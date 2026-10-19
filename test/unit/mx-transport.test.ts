import { describe, test, expect, afterAll } from "bun:test";
import Mail from "nodemailer/lib/mailer";
import SMTPPool from "nodemailer/lib/smtp-pool";
import SMTPTransport from "nodemailer/lib/smtp-transport";
import {
  OUTBOUND_TLS_MIN_VERSION,
  createTlsRecorder,
  mxTransportOptions,
  type TlsRecorder,
} from "../../src/modules/emails/services/mx-transport.ts";
import { classifySendFailure } from "../../src/utils/smtp-error.ts";

/**
 * Outbound TLS record (#250) against a real `smtp-server`: the recorder
 * reads nodemailer's own events, so these tests run the real nodemailer
 * client (under Bun, as in production) against a real receiving server.
 *
 * The server runs under Node (`test/fixtures/smtp-tls-server.mjs`): Bun
 * cannot upgrade an accepted socket to TLS, so it cannot serve STARTTLS.
 *
 * nodemailer is imported through its `lib/` entry points, not the package
 * root: `mailer.service.test.ts` mocks the package root with
 * `mock.module`, which leaks across unit files.
 *
 * Bun's TLS client never negotiates below TLS 1.2, with or without
 * `minVersion`, so the TLS 1.1 peer cannot tell whether `minVersion` is
 * set; the options test (and the mailer's transport test) pin that.
 */

const FIXTURE = new URL("../fixtures/smtp-tls-server.mjs", import.meta.url).pathname;

/** A running fixture server and what it reported on stdout. */
interface FixtureServer {
  port: number;
  /** Messages the server accepted so far. */
  messages: () => number;
  /** Connections the server accepted so far. */
  connections: () => number;
  stop: () => void;
}

const running: FixtureServer[] = [];

afterAll(() => {
  for (const server of running) server.stop();
});

/** Starts the fixture server in `mode` and waits for its port. */
async function startServer(
  mode: "starttls" | "plaintext" | "tls11",
): Promise<FixtureServer> {
  const node = Bun.which("node");
  if (node === null)
    throw new Error("these tests need `node` on PATH to run smtp-server");
  const proc = Bun.spawn([node, FIXTURE, mode], { stdin: "pipe", stdout: "pipe" });
  let messages = 0;
  let connections = 0;
  let resolvePort: (port: number) => void = () => undefined;
  const port = new Promise<number>((resolve) => {
    resolvePort = resolve;
  });
  void (async () => {
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of proc.stdout) {
      buffered += decoder.decode(chunk, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line: unknown = JSON.parse(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
        if (typeof line !== "object" || line === null) continue;
        const reported: unknown = Reflect.get(line, "port");
        const message: unknown = Reflect.get(line, "message");
        const connection: unknown = Reflect.get(line, "connection");
        if (typeof reported === "number") resolvePort(reported);
        if (typeof message === "number") messages = message;
        if (typeof connection === "number") connections = connection;
      }
    }
  })();
  const server: FixtureServer = {
    port: await port,
    messages: () => messages,
    connections: () => connections,
    stop: () => {
      void proc.stdin.end();
      proc.kill();
    },
  };
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
