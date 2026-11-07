import { afterAll, describe, expect, mock, test } from "bun:test";
import Mail from "nodemailer/lib/mailer";
import SMTPPool from "nodemailer/lib/smtp-pool";
import type { TlsRptObservation } from "../../src/modules/tls-rpt/types/tls-rpt.types.ts";
import {
  startFixtureServer,
  type FixtureMode,
  type FixtureServer,
} from "../smtp-fixture.ts";

/**
 * The real `createTransport` for what the MX session asks of it (a pool),
 * built from nodemailer's `lib/` entry points. `mailer.service.test.ts`
 * replaces the package root with a fake, and `mock.module` leaks across
 * unit files: this file needs the real client whatever ran before it, so
 * it puts the real one back for itself.
 */
function realCreateTransport(options: SMTPPool.Options): Mail {
  return new Mail(new SMTPPool(options), options);
}

void mock.module("nodemailer", () => ({
  createTransport: realCreateTransport,
  createTestAccount: mock(() =>
    Promise.reject(new Error("no Ethereal account in tests")),
  ),
  getTestMessageUrl: mock(() => false),
  default: { createTransport: realCreateTransport },
}));

const { config } = await import("../../src/config.ts");
const { sendMail } = await import("../../src/modules/emails/services/mailer.service.ts");
const { setMtaStsDeps } = await import("../../src/modules/emails/services/mta-sts.ts");
const { setMxRouteDeps } = await import("../../src/modules/emails/services/mx-route.ts");
const { runMxSession } =
  await import("../../src/modules/emails/services/mx-transport.ts");
const { setTlsRptObserveDeps, settleTlsRptRecordings } =
  await import("../../src/modules/tls-rpt/services/tls-rpt-observe.service.ts");
const { classifySession, tlsRptPolicyOf } =
  await import("../../src/modules/tls-rpt/services/tls-rpt-classify.ts");

/**
 * The TLS-RPT result types (#345) against real receiving servers
 * (`test/smtp-fixture.ts`, under Node) and the real MX session: the errors
 * Bun and nodemailer actually produce map to the right RFC 8460 result
 * types. Local servers on 127.0.0.1 only; the certificates under
 * `test/fixtures/tls/` are test-only (the `mx*.example.test` ones signed by
 * the test CA, `hook.example.test` self-signed).
 */

const CA = await Bun.file(
  new URL("../fixtures/tls/test-ca.cert.pem", import.meta.url),
).text();

const ENFORCE = tlsRptPolicyOf({
  policy: { id: "1", policy: { mode: "enforce", mx: ["*.example.test"], maxAge: 60 } },
  failure: null,
});
const NO_POLICY = tlsRptPolicyOf({ policy: null, failure: null });

const running: FixtureServer[] = [];
afterAll(() => {
  for (const server of running) server.stop();
});

/**
 * One session to a fixture in `mode` presenting `cert`, as `mxHost`, with
 * verified TLS (the test CA, or the system store with `ca: null`) or not,
 * and what TLS-RPT records for it.
 */
async function observe(args: {
  mode: FixtureMode;
  cert?: string;
  mxHost: string;
  verified: boolean;
  ca?: string | null;
}): Promise<TlsRptObservation | null> {
  const server = await startFixtureServer(args.mode, args.cert);
  running.push(server);
  const ca = args.ca === undefined ? CA : args.ca;
  const outcomes = await runMxSession({
    address: "127.0.0.1",
    mxHost: args.mxHost,
    heloName: "bunmail.example.test",
    port: server.port,
    transactions: [
      {
        key: "k",
        mail: {
          from: "sender@example.com",
          to: "user@example.org",
          text: "hello",
          envelope: { from: "sender@example.com", to: ["user@example.org"] },
        },
      },
    ],
    ...(args.verified ? { verifiedTls: ca === null ? {} : { ca } } : {}),
    setupTimeoutMs: 5_000,
    /** A handshake the peer refused stalls: give up quickly. */
    stallMs: 1_500,
  });
  return classifySession(args.verified ? ENFORCE : NO_POLICY, {
    mxHost: args.mxHost,
    address: "127.0.0.1",
    outcomes,
  });
}

describe("TLS-RPT result types from real sessions", () => {
  test("verified STARTTLS: success", async () => {
    expect(
      await observe({
        mode: "starttls",
        cert: "mx1.example.test",
        mxHost: "mx1.example.test",
        verified: true,
      }),
    ).toEqual({ result: "success" });
  });

  test("a certificate for another name: certificate-host-mismatch", async () => {
    expect(
      await observe({
        mode: "starttls",
        cert: "mx2.example.test",
        mxHost: "mx1.example.test",
        verified: true,
      }),
    ).toMatchObject({
      result: "certificate-host-mismatch",
      receivingMxHostname: "mx1.example.test",
      receivingIp: "127.0.0.1",
    });
  });

  test("a self-signed certificate: certificate-not-trusted", async () => {
    expect(
      await observe({ mode: "starttls", mxHost: "hook.example.test", verified: true }),
    ).toMatchObject({ result: "certificate-not-trusted" });
  });

  test("a certificate of an unknown CA: certificate-not-trusted", async () => {
    expect(
      await observe({
        mode: "starttls",
        cert: "mx1.example.test",
        mxHost: "mx1.example.test",
        verified: true,
        ca: null,
      }),
    ).toMatchObject({ result: "certificate-not-trusted" });
  });

  test("no STARTTLS under enforce: starttls-not-supported", async () => {
    expect(
      await observe({ mode: "plaintext", mxHost: "mx1.example.test", verified: true }),
    ).toMatchObject({
      result: "starttls-not-supported",
      failureReasonCode: "starttls-refused",
    });
  });

  test("no STARTTLS without a policy: delivered in plaintext, starttls-not-supported", async () => {
    expect(
      await observe({ mode: "plaintext", mxHost: "mx1.example.test", verified: false }),
    ).toMatchObject({ result: "starttls-not-supported", failureReasonCode: "" });
  });

  test("a server offering only TLS 1.1: validation-failure", async () => {
    expect(
      await observe({ mode: "tls11", mxHost: "mx1.example.test", verified: false }),
    ).toMatchObject({ result: "validation-failure" });
  }, 15_000);
});

describe("a session shared by several domains (the mailer's wiring)", () => {
  test("each domain is recorded once, from its own transaction", async () => {
    const server = await startFixtureServer("plaintext");
    running.push(server);
    const dnsError = (code: string): Error => Object.assign(new Error(code), { code });
    const savedAllowPrivate = config.mail.allowPrivateMx;
    Object.assign(config.mail, { allowPrivateMx: true });
    setMxRouteDeps({
      resolveMx: async () => [{ exchange: "mx1.example.test", priority: 10 }],
      resolve4: () => Promise.reject(dnsError("ENOTFOUND")),
      resolve6: () => Promise.reject(dnsError("ENOTFOUND")),
      lookup: async () => [{ address: "127.0.0.1" }],
      smtpPort: () => server.port,
      timeoutMs: 1_000,
    });
    setMtaStsDeps({
      resolveTxt: () => Promise.reject(dnsError("ENOTFOUND")),
      lookup: () => Promise.reject(dnsError("ENOTFOUND")),
      fetch: () => Promise.reject(new Error("no policy host")),
    });
    const recorded: Array<{ domain: string; result: string }> = [];
    setTlsRptObserveDeps({
      enabled: () => true,
      publishes: async () => true,
      record: async (args) => {
        recorded.push({ domain: args.domain, result: args.observation.result });
        return "recorded";
      },
    });
    try {
      await sendMail({
        from: "sender@example.com",
        to: "a@example.org",
        cc: "b@example.net",
        subject: "shared",
        text: "hello",
        messageId: `<${crypto.randomUUID()}@bunmail.example.test>`,
      });
      await settleTlsRptRecordings();
    } finally {
      setTlsRptObserveDeps(null);
      setMxRouteDeps(null);
      setMtaStsDeps(null);
      Object.assign(config.mail, { allowPrivateMx: savedAllowPrivate });
    }
    expect(recorded.toSorted((x, y) => x.domain.localeCompare(y.domain))).toEqual([
      { domain: "example.net", result: "starttls-not-supported" },
      { domain: "example.org", result: "starttls-not-supported" },
    ]);
  }, 30_000);
});
