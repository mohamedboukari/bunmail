import { describe, test, expect, afterAll } from "bun:test";
import { X509Certificate, createHash } from "crypto";
import { readFileSync } from "fs";
import type { TLSSocket } from "tls";
import Mail from "nodemailer/lib/mailer";
import SMTPTransport from "nodemailer/lib/smtp-transport";
import { peerChain, usableTlsa } from "../../src/modules/emails/services/dane-verify.ts";
import {
  createTlsRecorder,
  enforcedTlsFailure,
  mxTransportOptions,
  type DaneTls,
  type MxTransportOptions,
} from "../../src/modules/emails/services/mx-transport.ts";
import type { DaneHost } from "../../src/modules/emails/types/dane.types.ts";
import type { TlsaRecord } from "../../src/utils/dns-rdata.ts";
import { classifySendFailure } from "../../src/utils/smtp-error.ts";
import {
  startFixtureServer,
  type FixtureMode,
  type FixtureServer,
} from "../smtp-fixture.ts";

/**
 * DANE sessions (#345) against a real `smtp-server` over STARTTLS: the
 * production transport options (`mxTransportOptions` with `dane`), the
 * real nodemailer client under Bun, and the TLS check BunMail's nodemailer
 * patch runs right after the handshake (`patches/nodemailer@10.3.1.patch`).
 *
 * DANE-TA (#455) needs the chain the server presented, which Bun 1.4
 * exposes (Bun 1.3.14 showed the leaf alone): one test pins that, in the
 * order the server sent it, and the DANE-TA sessions run over real two-
 * and three-level chains.
 *
 * The mismatch tests double as the guard against a lost patch: without
 * it, nodemailer never calls `verifyTlsSocket`, the session goes on after
 * the handshake, and the server sees a MAIL FROM it must never see.
 *
 * nodemailer is imported through its `lib/` entry points (as in
 * `mx-transport.test.ts`): `mailer.service.test.ts` mocks the package root.
 */

const running: FixtureServer[] = [];

afterAll(() => {
  for (const server of running) server.stop();
});

/** Starts the fixture server in `mode` with a DANE fixture certificate. */
async function startServer(mode: FixtureMode, certName: string): Promise<FixtureServer> {
  const server = await startFixtureServer(mode, certName);
  running.push(server);
  return server;
}

const DIR = new URL("../fixtures/tls/dane/", import.meta.url);

/** A fixture certificate. */
function cert(name: string): X509Certificate {
  return new X509Certificate(readFileSync(new URL(`${name}.cert.pem`, DIR)));
}

/** A `<usage> <selector> 1` record for `c` (SHA-256). */
function sha256Record(usage: number, selector: number, c: X509Certificate): TlsaRecord {
  const bytes =
    selector === 0 ? c.raw : c.publicKey.export({ type: "spki", format: "der" });
  return {
    usage,
    selector,
    matchingType: 1,
    data: Uint8Array.from(createHash("sha256").update(bytes).digest()),
  };
}

/** DANE for the fixture host with `records`, usable as in production. */
function daneHost(records: TlsaRecord[]): DaneHost {
  return {
    mxHost: "mx.dane.example",
    baseDomain: "mx.dane.example",
    referenceIds: ["mx.dane.example", "example.org"],
    records,
    usable: usableTlsa(records),
  };
}

const MESSAGE: Mail.Options = {
  from: "sender@example.com",
  to: "rcpt@example.org",
  subject: "dane",
  text: "hello",
};

/**
 * One transaction with the production DANE options against `port`; the
 * check is wrapped to count its calls. Resolves with the error, the TLS
 * record and how often the check ran.
 */
async function send(
  port: number,
  dane: DaneTls,
  stallMs = 2_000,
): Promise<{ error?: unknown; tls: string | null; checks: number; chain: string[] }> {
  const recorder = createTlsRecorder(stallMs);
  let checks = 0;
  /** The subjects of the chain the check saw, leaf first. */
  let chain: string[] = [];
  const options = mxTransportOptions({
    address: "127.0.0.1",
    mxHost: "mx.dane.example",
    heloName: "bunmail.example.test",
    logger: recorder.logger,
    dane,
  });
  const check = options.verifyTlsSocket;
  /** Typed as BunMail's options: the patch's hook is not in nodemailer's own type. */
  const counted: MxTransportOptions = {
    ...options,
    port,
    verifyTlsSocket: (socket: TLSSocket) => {
      checks += 1;
      chain = peerChain(socket).map((c) => c.subject);
      return check === undefined ? null : check(socket);
    },
  };
  const mailer = new Mail(new SMTPTransport(counted));
  recorder.beginTransaction();
  try {
    await Promise.race([mailer.sendMail(MESSAGE), recorder.stalled]);
    return { tls: recorder.result(), checks, chain };
  } catch (error: unknown) {
    return { error, tls: recorder.result(), checks, chain };
  } finally {
    recorder.dispose();
    mailer.close();
  }
}

describe("mxTransportOptions with DANE", () => {
  test("STARTTLS required, SNI the TLSA base domain, no trust store, the check set", () => {
    const options = mxTransportOptions({
      address: "203.0.113.10",
      mxHost: "mx.example.org",
      heloName: "bunmail.example.test",
      logger: createTlsRecorder().logger,
      verifiedTls: {},
      dane: { host: { ...daneHost([]), baseDomain: "mxbackup.example.net" } },
    });
    expect(options.requireTLS).toBe(true);
    expect(options.opportunisticTLS).toBe(false);
    expect(options.tls?.servername).toBe("mxbackup.example.net");
    expect(options.tls?.rejectUnauthorized).toBe(false);
    expect(options.tls?.minVersion).toBe("TLSv1.2");
    expect(typeof options.verifyTlsSocket).toBe("function");
    /** DANE wins over MTA-STS: no PKIX check of the certificate. */
    expect(options.tls?.ca).toBeUndefined();
    expect(options.host).toBe("203.0.113.10");
  });
});

describe("DANE sessions against a real smtp-server (#345)", () => {
  test("DANE-EE: a matching certificate delivers, over TLS, with the base domain as SNI", async () => {
    const server = await startServer("starttls", "dane/ee");
    const outcome = await send(server.port, {
      host: daneHost([sha256Record(3, 1, cert("ee"))]),
    });
    expect(outcome.error).toBeUndefined();
    expect(outcome.tls).toBe("starttls");
    expect(outcome.checks).toBe(1);
    expect(await server.waitForMessages(1)).toBe(1);
    expect(server.snis()).toEqual(["mx.dane.example"]);
  });

  test("the runtime exposes the presented chain, in the order sent (#447, #455)", async () => {
    /**
     * Bun 1.3.14 exposed the leaf alone; Bun 1.4 links `issuerCertificate`
     * in `getPeerCertificate(true)` in the order the server sent the
     * certificates (Node reorders them), which DANE-TA needs. A server
     * sending them out of order (TLS 1.3 allows it) still authenticates:
     * the verifier builds the path itself.
     */
    const ordered = await startServer("starttls", "dane/ta3-chain");
    const root = cert("ta3-root");
    const outcome = await send(ordered.port, {
      host: daneHost([sha256Record(2, 0, root)]),
    });
    expect(outcome.error).toBeUndefined();
    expect(outcome.chain).toEqual([
      "CN=mx.dane.example",
      "CN=BunMail DANE test intermediate",
      "CN=BunMail DANE test root",
    ]);
    const unordered = await startServer("starttls", "dane/ta3-unordered");
    const shuffled = await send(unordered.port, {
      host: daneHost([sha256Record(2, 0, root)]),
    });
    expect(shuffled.error).toBeUndefined();
    expect(shuffled.chain).toEqual([
      "CN=mx.dane.example",
      "CN=BunMail DANE test root",
      "CN=BunMail DANE test intermediate",
    ]);
    expect(await unordered.waitForMessages(1)).toBe(1);
  });

  test("DANE-TA: the intermediate in the middle of a three-level chain anchors it", async () => {
    const server = await startServer("starttls", "dane/ta3-chain");
    for (const selector of [0, 1]) {
      const outcome = await send(server.port, {
        host: daneHost([sha256Record(2, selector, cert("ta3-int"))]),
      });
      expect(outcome.error).toBeUndefined();
      expect(outcome.tls).toBe("starttls");
    }
    expect(await server.waitForMessages(2)).toBe(2);
  });

  test("DANE-TA: an anchor the chain does not lead to is refused before MAIL FROM", async () => {
    const server = await startServer("starttls", "dane/ta-chain");
    const outcome = await send(server.port, {
      host: daneHost([
        sha256Record(2, 0, cert("ta3-root")),
        sha256Record(2, 1, cert("ee")),
      ]),
    });
    expect(outcome.checks).toBe(1);
    expect(String(outcome.error)).toContain("DANE: no TLSA record matches");
    expect(classifySendFailure(outcome.error)).toBeNull();
    await Bun.sleep(200);
    expect(server.mailFroms()).toBe(0);
  });

  test("DANE-EE beside DANE-TA: either authenticates", async () => {
    const server = await startServer("starttls", "dane/ta-chain");
    const ca = cert("ca");
    const anchor: TlsaRecord = {
      usage: 2,
      selector: 0,
      matchingType: 0,
      data: Uint8Array.from(ca.raw),
    };
    /** The DANE-EE record names another certificate; the "2 0 0" anchor issued this one. */
    const byAnchor = await send(server.port, {
      host: daneHost([sha256Record(3, 1, cert("ee")), anchor]),
    });
    expect(byAnchor.error).toBeUndefined();
    /** The DANE-EE record matches; the DANE-TA one names an unrelated CA. */
    const byLeaf = await send(server.port, {
      host: daneHost([
        sha256Record(3, 1, cert("ta-leaf")),
        sha256Record(2, 0, cert("ta3-root")),
      ]),
    });
    expect(byLeaf.error).toBeUndefined();
    expect(await server.waitForMessages(2)).toBe(2);
  });

  test("DANE-TA: an anchor published in full (2 0 0) that issued the certificate delivers", async () => {
    const server = await startServer("starttls", "dane/ta-chain");
    const ca = cert("ca");
    const outcome = await send(server.port, {
      host: daneHost([
        { usage: 2, selector: 0, matchingType: 0, data: Uint8Array.from(ca.raw) },
      ]),
    });
    expect(outcome.error).toBeUndefined();
    expect(await server.waitForMessages(1)).toBe(1);
  });

  test("no matching record: the session ends after the handshake, before MAIL FROM (the patch guard)", async () => {
    const server = await startServer("starttls", "dane/ee");
    const outcome = await send(server.port, {
      host: daneHost([sha256Record(3, 1, cert("ta-leaf"))]),
    });
    /** The check ran: the nodemailer patch is in place. */
    expect(outcome.checks).toBe(1);
    expect(outcome.error).toBeInstanceOf(Error);
    expect(String(outcome.error)).toContain("DANE: no TLSA record matches");
    /** No SMTP reply: retried or failed over, never a bounce. */
    expect(classifySendFailure(outcome.error)).toBeNull();
    const mapped = enforcedTlsFailure(outcome.error, "mx.dane.example", "DANE");
    expect(mapped instanceof Error ? mapped.message : "").toStartWith(
      "DANE: no authenticated TLS with mx.dane.example (",
    );
    await Bun.sleep(200);
    expect(server.mailFroms()).toBe(0);
    expect(server.messages()).toBe(0);
  });

  test("DANE-TA: a name no reference identifier matches is refused before MAIL FROM", async () => {
    const server = await startServer("starttls", "dane/ta-chain");
    const ca = cert("ca");
    const outcome = await send(server.port, {
      host: {
        ...daneHost([
          { usage: 2, selector: 0, matchingType: 0, data: Uint8Array.from(ca.raw) },
        ]),
        referenceIds: ["mx.example.org", "example.org"],
      },
    });
    expect(String(outcome.error)).toContain("DANE: certificate name mismatch");
    await Bun.sleep(200);
    expect(server.mailFroms()).toBe(0);
  });

  test("a server without STARTTLS: no plaintext fallback, retried, never a bounce", async () => {
    const server = await startServer("plaintext", "dane/ee");
    const outcome = await send(server.port, {
      host: daneHost([sha256Record(3, 1, cert("ee"))]),
    });
    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.checks).toBe(0);
    const mapped = enforcedTlsFailure(outcome.error, "mx.dane.example", "DANE");
    expect(classifySendFailure(mapped)).toBeNull();
    expect(mapped instanceof Error ? mapped.message : "").toStartWith(
      "DANE: no authenticated TLS",
    );
    await Bun.sleep(200);
    expect(server.mailFroms()).toBe(0);
    expect(server.messages()).toBe(0);
  });

  test("records present but none usable: TLS still required, any certificate accepted", async () => {
    const server = await startServer("starttls", "dane/ee");
    const outcome = await send(server.port, {
      host: daneHost([{ ...sha256Record(3, 1, cert("ta-leaf")), usage: 1 }]),
    });
    expect(outcome.error).toBeUndefined();
    expect(outcome.tls).toBe("starttls");
    expect(await server.waitForMessages(1)).toBe(1);
  });
});

describe("a handshake that did not complete (#345 review)", () => {
  test("encrypted-only DANE fails at once on a refused handshake, not after the stall limit", async () => {
    /**
     * A TLS 1.1 peer. Bun 1.3.14 called back for a handshake that did not
     * really complete, which the check refused (`DANE_HANDSHAKE_INCOMPLETE`,
     * kept as a guard and tested in `dane-verify.test.ts`); Bun 1.4 fails
     * the handshake itself with the peer's protocol-version alert, so the
     * check never runs.
     */
    const server = await startServer("tls11", "dane/ee");
    const host = daneHost([{ ...sha256Record(3, 1, cert("ee")), usage: 1 }]);
    expect(host.usable).toEqual([]);
    const started = Date.now();
    const outcome = await send(server.port, { host }, 30_000);
    expect(outcome.error).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(outcome.checks).toBe(0);
    expect(String(outcome.error)).toContain("PROTOCOL_VERSION");
    expect(classifySendFailure(outcome.error)).toBeNull();
    const mapped = enforcedTlsFailure(outcome.error, "mx.dane.example", "DANE");
    expect(mapped instanceof Error ? mapped.message : "").toStartWith(
      "DANE: no authenticated TLS with mx.dane.example (",
    );
    await Bun.sleep(200);
    expect(server.mailFroms()).toBe(0);
    expect(server.messages()).toBe(0);
  });
});

describe("the lost-patch guard of runMxSession", () => {
  test("an upgrade the check did not see rejects the session at once", async () => {
    let guardCalls = 0;
    const recorder = createTlsRecorder(60_000, () => {
      guardCalls += 1;
      return new Error("DANE: the TLS check did not run");
    });
    recorder.logger.info({ tnx: "smtp", sid: "a" }, "Connection upgraded with STARTTLS");
    let caught: unknown;
    try {
      await recorder.stalled;
    } catch (error: unknown) {
      caught = error;
    }
    recorder.dispose();
    expect(guardCalls).toBe(1);
    expect(String(caught)).toContain("DANE: the TLS check did not run");
  });
});
