import { describe, test, expect, afterAll } from "bun:test";
import Mail from "nodemailer/lib/mailer";
import SMTPPool from "nodemailer/lib/smtp-pool";
import SMTPTransport from "nodemailer/lib/smtp-transport";
import {
  OUTBOUND_TLS_MIN_VERSION,
  createTlsRecorder,
  enforcedTlsFailure,
  mxTransportOptions,
  type TlsRecorder,
} from "../../src/modules/emails/services/mx-transport.ts";
import { classifySendFailure } from "../../src/utils/smtp-error.ts";
import {
  startFixtureServer,
  type FixtureMode,
  type FixtureServer,
} from "../smtp-fixture.ts";

/**
 * Outbound TLS record (#250) against a real `smtp-server`: the recorder
 * reads nodemailer's own events, so these tests run the real nodemailer
 * client (under Bun, as in production) against a real receiving server.
 *
 * The server runs under Node (`test/smtp-fixture.ts`): Bun cannot upgrade
 * an accepted socket to TLS, so it cannot serve STARTTLS.
 *
 * nodemailer is imported through its `lib/` entry points, not the package
 * root: `mailer.service.test.ts` mocks the package root with
 * `mock.module`, which leaks across unit files.
 *
 * Bun's TLS client never negotiates below TLS 1.2, with or without
 * `minVersion`, so the TLS 1.1 peer cannot tell whether `minVersion` is
 * set; the options test (and the mailer's transport test) pin that.
 */

const running: FixtureServer[] = [];

afterAll(() => {
  for (const server of running) server.stop();
});

/** Starts the fixture server in `mode`, stopped after the file. */
async function startServer(mode: FixtureMode): Promise<FixtureServer> {
  const server = await startFixtureServer(mode);
  running.push(server);
  return server;
}

/** The production options for an MX, pointed at the fixture's port. */
function optionsFor(port: number, recorder: TlsRecorder): SMTPTransport.Options {
  return {
    ...mxTransportOptions({
      address: "127.0.0.1",
      mxHost: "mx.example.test",
      heloName: "bunmail.example.test",
      logger: recorder.logger,
    }),
    port,
  };
}

const MESSAGE: Mail.Options = {
  from: "sender@example.com",
  to: "rcpt@example.org",
  subject: "tls record",
  text: "hello",
};

/** One transaction, the way the mailer runs it: raced against a stalled upgrade. */
async function transact(
  mailer: Mail,
  recorder: TlsRecorder,
): Promise<{ error?: unknown; tls: ReturnType<TlsRecorder["result"]> }> {
  recorder.beginTransaction();
  try {
    await Promise.race([mailer.sendMail(MESSAGE), recorder.stalled]);
    return { tls: recorder.result() };
  } catch (error: unknown) {
    return { error, tls: recorder.result() };
  }
}

describe("mxTransportOptions", () => {
  test("opportunistic STARTTLS, TLS 1.2 at least, certificates not verified", () => {
    const options = mxTransportOptions({
      address: "203.0.113.10",
      mxHost: "mx.example.org",
      heloName: "bunmail.example.test",
      logger: createTlsRecorder().logger,
    });
    expect(OUTBOUND_TLS_MIN_VERSION).toBe("TLSv1.2");
    expect(options.tls?.minVersion).toBe("TLSv1.2");
    expect(options.tls?.servername).toBe("mx.example.org");
    expect(options.tls?.rejectUnauthorized).toBe(false);
    expect(options.opportunisticTLS).toBe(true);
    expect(options.requireTLS).toBeUndefined();
    expect(options.ignoreTLS).toBeUndefined();
    expect(options.host).toBe("203.0.113.10");
    expect(options.port).toBe(25);
    expect(options.logger).toBeDefined();
  });

  test("MTA-STS enforce: STARTTLS required, the certificate verified for the MX name", () => {
    const options = mxTransportOptions({
      address: "203.0.113.10",
      mxHost: "mx.example.org",
      heloName: "bunmail.example.test",
      logger: createTlsRecorder().logger,
      verifiedTls: {},
    });
    expect(options.requireTLS).toBe(true);
    expect(options.opportunisticTLS).toBe(false);
    expect(options.tls?.rejectUnauthorized).toBe(true);
    expect(options.tls?.servername).toBe("mx.example.org");
    expect(options.tls?.minVersion).toBe("TLSv1.2");
    expect(options.tls?.ca).toBeUndefined();
    /** Still pinned to the checked address. */
    expect(options.host).toBe("203.0.113.10");
  });

  test("MTA-STS enforce: a test CA replaces the trust store only when given", () => {
    const options = mxTransportOptions({
      address: "203.0.113.10",
      mxHost: "mx.example.org",
      heloName: "bunmail.example.test",
      logger: createTlsRecorder().logger,
      verifiedTls: { ca: "-----BEGIN CERTIFICATE-----" },
    });
    expect(options.tls?.ca).toBe("-----BEGIN CERTIFICATE-----");
  });
});

describe("enforcedTlsFailure (#250)", () => {
  /** An error shaped like nodemailer's, with its extra fields. */
  function smtpError(message: string, fields: Record<string, unknown>): Error {
    return Object.assign(new Error(message), fields);
  }

  test("a refused STARTTLS loses its 5xx reply: retried, never a bounce", () => {
    const refused = smtpError(
      "Error upgrading connection with STARTTLS: 500 5.5.1 Error: command not recognized",
      {
        code: "ETLS",
        responseCode: 500,
        response: "500 5.5.1 Error: command not recognized",
        command: "STARTTLS",
      },
    );
    expect(classifySendFailure(refused)?.kind).toBe("hard");
    const mapped = enforcedTlsFailure(refused, "mx.example.org");
    expect(mapped).toBeInstanceOf(Error);
    expect(classifySendFailure(mapped)).toBeNull();
    expect(mapped instanceof Error ? mapped.message : "").toStartWith(
      "MTA-STS: no verified TLS with mx.example.org (",
    );
    expect(
      mapped instanceof Error ? Reflect.get(mapped, "responseCode") : 0,
    ).toBeUndefined();
  });

  test("a multi-line reply never leaves a line starting with a reply code", () => {
    const refused = smtpError(
      "Error upgrading connection with STARTTLS:\n550-5.7.0 no\n550 5.7.0 tls",
      {
        code: "ETLS",
        responseCode: 550,
      },
    );
    expect(classifySendFailure(enforcedTlsFailure(refused, "mx.example.org"))).toBeNull();
  });

  test("a certificate failure is mapped too", () => {
    const badCert = smtpError("Hostname/IP does not match certificate's altnames", {
      code: "ESOCKET",
      originalCode: "ERR_TLS_CERT_ALTNAME_INVALID",
      command: "CONN",
    });
    const mapped = enforcedTlsFailure(badCert, "mx.example.org");
    expect(mapped instanceof Error ? mapped.message : "").toContain("does not match");
    expect(mapped).not.toBe(badCert);
  });

  test("any other failure is kept as it is", () => {
    const rcpt = smtpError("Recipient command failed: 550 5.1.1 No such user", {
      code: "EENVELOPE",
      responseCode: 550,
      command: "RCPT TO",
    });
    expect(enforcedTlsFailure(rcpt, "mx.example.org")).toBe(rcpt);
    const refusedConnection = smtpError("connect ECONNREFUSED", {
      code: "ESOCKET",
      originalCode: "ECONNREFUSED",
    });
    expect(enforcedTlsFailure(refusedConnection, "mx.example.org")).toBe(
      refusedConnection,
    );
  });
});

describe("TLS record against a real smtp-server (#250)", () => {
  test("a server offering STARTTLS: the session is recorded as starttls", async () => {
    const server = await startServer("starttls");
    const recorder = createTlsRecorder();
    const mailer = new Mail(new SMTPTransport(optionsFor(server.port, recorder)));
    const outcome = await transact(mailer, recorder);
    recorder.dispose();
    expect(outcome.error).toBeUndefined();
    expect(outcome.tls).toBe("starttls");
  });

  test("a server without STARTTLS: the session is recorded as plaintext", async () => {
    const server = await startServer("plaintext");
    const recorder = createTlsRecorder();
    const mailer = new Mail(new SMTPTransport(optionsFor(server.port, recorder)));
    const outcome = await transact(mailer, recorder);
    recorder.dispose();
    expect(outcome.error).toBeUndefined();
    expect(outcome.tls).toBe("plaintext");
  });

  test("a server limited to TLS 1.1 fails the attempt as retryable, TLS unknown", async () => {
    const server = await startServer("tls11");
    const recorder = createTlsRecorder(1_000);
    const mailer = new Mail(new SMTPTransport(optionsFor(server.port, recorder)));
    const outcome = await transact(mailer, recorder);
    recorder.dispose();
    expect(outcome.error).toBeInstanceOf(Error);
    /** No SMTP reply: retried later, never a bounce. */
    expect(classifySendFailure(outcome.error)).toBeNull();
    expect(outcome.tls).toBeNull();
    expect(server.messages()).toBe(0);
  });

  test("pooled transactions on one STARTTLS connection are each recorded as starttls", async () => {
    const server = await startServer("starttls");
    const recorder = createTlsRecorder();
    const pool = new SMTPPool({
      ...optionsFor(server.port, recorder),
      pool: true,
      maxConnections: 1,
      maxRequeues: 0,
    });
    const mailer = new Mail(pool);
    const first = await transact(mailer, recorder);
    const second = await transact(mailer, recorder);
    recorder.dispose();
    pool.close();
    expect(first).toEqual({ tls: "starttls" });
    expect(second).toEqual({ tls: "starttls" });
    expect(server.messages()).toBe(2);
    expect(server.connections()).toBe(1);
  });
});

describe("createTlsRecorder", () => {
  test("nothing ready: unknown, even after the upgrade line", () => {
    const recorder = createTlsRecorder();
    expect(recorder.result()).toBeNull();
    recorder.logger.info({ tnx: "smtp", sid: "a" }, "Connection upgraded with STARTTLS");
    expect(recorder.result()).toBeNull();
    recorder.dispose();
  });

  test("a new connection is not upgraded until it says so", () => {
    const recorder = createTlsRecorder();
    recorder.logger.info({ tnx: "smtp", sid: "a" }, "Connection upgraded with STARTTLS");
    recorder.logger.info({ tnx: "send" }, "Sending message %s", "<id>");
    expect(recorder.result()).toBe("starttls");
    recorder.beginTransaction();
    recorder.logger.info({ tnx: "network", sid: "b" }, "%s established to %s:%s");
    recorder.logger.info({ tnx: "send" }, "Sending message %s", "<id>");
    expect(recorder.result()).toBe("plaintext");
    recorder.dispose();
  });

  test("an upgrade that never becomes ready rejects `stalled`", async () => {
    const recorder = createTlsRecorder(20);
    recorder.logger.info({ tnx: "smtp", sid: "a" }, "Connection upgraded with STARTTLS");
    let caught: unknown;
    try {
      await recorder.stalled;
    } catch (error: unknown) {
      caught = error;
    }
    expect(String(caught)).toContain("STARTTLS handshake did not complete");
    expect(classifySendFailure(caught)).toBeNull();
  });
});
