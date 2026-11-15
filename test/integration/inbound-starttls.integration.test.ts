/**
 * STARTTLS on the inbound receiver (#414), under Bun.
 *
 * The receiver runs in this (Bun) process with `mx1.example.test`, a leaf
 * of the test CA; every client is a Node child process
 * (`test/fixtures/smtp-starttls-client.mjs`) that verifies it against that
 * CA, so the client is never the thing under test.
 *
 * Server-side STARTTLS needs Bun 1.4.4 or later (Bun 1.3.14 never finishes
 * the handshake, and the config refuses `SMTP_TLS_CERT` on it), so the
 * STARTTLS tests skip on an older Bun (`runtimeHasSocketFeatures`). The
 * default (no certificate, no STARTTLS) is checked on every version.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, spyOn } from "bun:test";
import type { Mock } from "bun:test";
import { eq } from "drizzle-orm";
import * as smtpReceiver from "../../src/modules/inbound/services/smtp-receiver.service.ts";
import { inboundEmails } from "../../src/modules/inbound/models/inbound-email.schema.ts";
import { config, runtimeHasSocketFeatures } from "../../src/config.ts";
import { logger } from "../../src/utils/logger.ts";
import { db } from "./_helpers.ts";
import { boundTestPort } from "../listen-port.ts";
import { IDLE_CPU_BUDGET, serverCpuShare, socketsLeftAfterHangUp } from "./_sockets.ts";

/**
 * The running receiver's port: it binds 0 and the OS picks a free one
 * (#443), read back after each start (one receiver without STARTTLS, then
 * one with it).
 */
let receiverPort = 0;

const CLIENT = new URL("../fixtures/smtp-starttls-client.mjs", import.meta.url).pathname;
const TLS_DIR = new URL("../fixtures/tls/", import.meta.url).pathname;

/** What the Node client printed. */
interface ClientResult {
  ok: boolean;
  error?: string;
  protocol?: string;
  ehloBefore?: string[];
  ehloAfter?: string[];
  response?: string;
  text?: string;
  runs?: number;
  serverEnded?: boolean;
}

/** Narrows the client's JSON line without a cast. */
function toClientResult(line: unknown): ClientResult {
  if (typeof line !== "object" || line === null) throw new Error("bad client output");
  const field = (name: string): unknown => Reflect.get(line, name);
  const text = (name: string): string | undefined => {
    const value = field(name);
    return typeof value === "string" ? value : undefined;
  };
  const lines = (name: string): string[] | undefined => {
    const value = field(name);
    return Array.isArray(value) ? value.map(String) : undefined;
  };
  return {
    ok: field("ok") === true,
    error: text("error"),
    protocol: text("protocol"),
    ehloBefore: lines("ehloBefore"),
    ehloAfter: lines("ehloAfter"),
    response: text("response"),
    text: text("text"),
    runs: typeof field("runs") === "number" ? Number(field("runs")) : undefined,
    serverEnded: field("serverEnded") === true,
  };
}

/** What the Node client does, see its header. */
type ClientMode =
  "deliver" | "plaintext" | "bad-handshake" | "hangup" | "half-close" | "quit";

/** Runs the Node client in `mode` against `port`. */
async function runClient(
  mode: ClientMode,
  port: number,
  env: { subject?: string; repeat?: number } = {},
): Promise<ClientResult> {
  const node = Bun.which("node");
  if (node === null) throw new Error("these tests need `node` on PATH");
  const proc = Bun.spawn([node, CLIENT, mode, String(port)], {
    stdout: "pipe",
    stderr: "inherit",
    env: {
      ...process.env,
      STARTTLS_RCPT: "inbox@example.org",
      STARTTLS_SUBJECT: env.subject ?? "over STARTTLS",
      STARTTLS_REPEAT: String(env.repeat ?? 1),
    },
  });
  const out = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  const last = out.trim().split("\n").pop() ?? "";
  if (last === "") {
    return { ok: false, error: `the client printed nothing (exit code ${exitCode})` };
  }
  return toClientResult(JSON.parse(last));
}

/** Reads one field of a logged context object. */
function fieldOf(context: unknown, name: string): unknown {
  return typeof context === "object" && context !== null
    ? Reflect.get(context, name)
    : undefined;
}

/** A spy on one logger method. */
type LogSpy = Mock<typeof logger.info>;

/** The structured fields of every call with this message so far. */
function fieldsOf(spy: LogSpy, message: string): unknown[] {
  return spy.mock.calls.filter((call) => call[0] === message).map((call) => call[1]);
}

/** Waits up to 3 s for a call with `message`; returns the calls so far. */
async function waitForCall(spy: LogSpy, message: string, count = 1): Promise<unknown[]> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const calls = fieldsOf(spy, message);
    if (calls.length >= count || Date.now() > deadline) return calls;
    await Bun.sleep(20);
  }
}

/** The subjects of stored inbound messages with this subject. */
async function storedSubjects(subject: string): Promise<(string | null)[]> {
  const rows = await db
    .select({ subject: inboundEmails.subject })
    .from(inboundEmails)
    .where(eq(inboundEmails.subject, subject));
  return rows.map((row) => row.subject);
}

/** Inbound settings this file overrides, restored after each receiver. */
const savedSmtp = { ...config.smtp, spamProtection: { ...config.smtp.spamProtection } };

/**
 * Starts the receiver on a free port (#443), without DNSBL, rate limit or
 * recipient checks, and resolves once it listens, with `receiverPort` set.
 */
async function startReceiver(
  tls: { certPath: string; keyPath: string } | null,
): Promise<void> {
  Object.assign(config.smtp, { tls, port: 0 });
  Object.assign(config.smtp.spamProtection, {
    dnsblEnabled: false,
    rateLimitEnabled: false,
    recipientValidationEnabled: false,
  });
  smtpReceiver.start();
  receiverPort = await boundTestPort(
    smtpReceiver.listeningPort(),
    "Inbound SMTP (STARTTLS)",
  );
}

/** Stops the receiver and restores the inbound settings. */
function stopReceiver(): void {
  smtpReceiver.stop();
  Object.assign(config.smtp, { tls: savedSmtp.tls, port: savedSmtp.port });
  Object.assign(config.smtp.spamProtection, savedSmtp.spamProtection);
}

let infoSpy: LogSpy;
let warnSpy: LogSpy;
let errorSpy: LogSpy;

beforeAll(() => {
  infoSpy = spyOn(logger, "info");
  warnSpy = spyOn(logger, "warn");
  errorSpy = spyOn(logger, "error");
});

afterAll(() => {
  infoSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

/** Each test sees only its own log lines; a start line is captured before. */
beforeEach(() => {
  infoSpy.mockClear();
  warnSpy.mockClear();
  errorSpy.mockClear();
});

describe("inbound SMTP without a certificate (the default)", () => {
  /** The receiver's start line, captured once it is listening. */
  let started: unknown;

  beforeAll(async () => {
    await startReceiver(null);
    started = (await waitForCall(infoSpy, "Inbound SMTP server started"))[0];
  });
  afterAll(stopReceiver);

  test("the start line reports no STARTTLS", () => {
    expect(fieldOf(started, "starttls")).toBe(false);
  });

  test("STARTTLS is not offered, and mail is delivered in plaintext", async () => {
    const subject = `plain default ${crypto.randomUUID()}`;
    const result = await runClient("plaintext", receiverPort, { subject });
    expect(result).toMatchObject({ ok: true });
    expect(result.response).toMatch(/^250 /);
    expect((result.ehloBefore ?? []).some((line) => /STARTTLS/i.test(line))).toBe(false);
    expect(await storedSubjects(subject)).toEqual([subject]);
  });
});

describe.skipIf(!runtimeHasSocketFeatures())("inbound SMTP with STARTTLS (#414)", () => {
  /** The receiver's start line, captured once it is listening. */
  let started: unknown;

  beforeAll(async () => {
    await startReceiver({
      /** A leaf of the test CA: the client verifies it against that CA. */
      certPath: `${TLS_DIR}mx1.example.test.cert.pem`,
      keyPath: `${TLS_DIR}mx1.example.test.key.pem`,
    });
    started = (await waitForCall(infoSpy, "Inbound SMTP server started"))[0];
  });
  afterAll(stopReceiver);

  test("the start line reports STARTTLS", () => {
    expect(fieldOf(started, "starttls")).toBe(true);
    expect(fieldOf(started, "port")).toBe(receiverPort);
  });

  test("STARTTLS is offered, then a message over TLS is stored, in a secure session", async () => {
    const subject = `starttls ${crypto.randomUUID()}`;
    const result = await runClient("deliver", receiverPort, { subject });
    expect(result).toMatchObject({ ok: true });
    expect(result.protocol).toMatch(/^TLSv1\.[23]$/);
    expect(result.response).toMatch(/^250 /);
    /** Offered on the plaintext EHLO, and no longer once the session is TLS. */
    expect((result.ehloBefore ?? []).some((line) => /STARTTLS/.test(line))).toBe(true);
    expect((result.ehloAfter ?? []).some((line) => /STARTTLS/.test(line))).toBe(false);
    /** AUTH stays off on an MX, TLS or not. */
    expect((result.ehloAfter ?? []).some((line) => /AUTH/.test(line))).toBe(false);
    expect(await storedSubjects(subject)).toEqual([subject]);

    const closed = await waitForCall(infoSpy, "SMTP session closed");
    expect(closed.some((context) => fieldOf(context, "secure") === true)).toBe(true);
  });

  test("STARTTLS is opportunistic: a sender without TLS still delivers", async () => {
    const subject = `starttls plaintext ${crypto.randomUUID()}`;
    const result = await runClient("plaintext", receiverPort, { subject });
    expect(result).toMatchObject({ ok: true });
    expect((result.ehloBefore ?? []).some((line) => /STARTTLS/.test(line))).toBe(true);
    expect(await storedSubjects(subject)).toEqual([subject]);

    const closed = await waitForCall(infoSpy, "SMTP session closed");
    expect(closed.some((context) => fieldOf(context, "secure") === false)).toBe(true);
  });

  test("a failed handshake is one neutral TLS warn line, not a server error, and the receiver keeps working", async () => {
    const result = await runClient("bad-handshake", receiverPort);
    expect(result).toMatchObject({ ok: true });
    /** Nothing it sent was read as SMTP: no reply to its EHLO. */
    expect(result.text ?? "").not.toMatch(/^250/m);

    const failed = await waitForCall(warnSpy, "Inbound SMTP TLS error");
    /** Give a second report of the same error time to arrive, then count. */
    await Bun.sleep(200);
    expect(fieldsOf(warnSpy, "Inbound SMTP TLS error")).toHaveLength(1);
    expect(fieldOf(failed[0], "ip")).toMatch(/127\.0\.0\.1$/);
    expect(String(fieldOf(failed[0], "code"))).toMatch(/^(ERR_SSL_|ERR_TLS_|TLSError$)/);
    /** smtp-server's own STARTTLS connection, told apart from implicit TLS. */
    expect(fieldOf(failed[0], "starttls")).toBe(true);
    expect(fieldsOf(errorSpy, "SMTP server error")).toEqual([]);

    const subject = `after a bad handshake ${crypto.randomUUID()}`;
    expect(await runClient("deliver", receiverPort, { subject })).toMatchObject({
      ok: true,
    });
    expect(await storedSubjects(subject)).toEqual([subject]);
  });

  /* A client hanging up after STARTTLS leaves nothing behind (#351 on port 25). */
  const stages: { name: string; mode: ClientMode }[] = [
    { name: "plaintext instead of a ClientHello", mode: "bad-handshake" },
    { name: "TLS and EHLO, closed without QUIT", mode: "hangup" },
    { name: "TLS and EHLO, then a half-close", mode: "half-close" },
    { name: "QUIT, closed while the server closes its side", mode: "quit" },
  ];

  for (const { name, mode } of stages) {
    test(`hang-up after STARTTLS, ${name}: no socket left, no CPU spin`, async () => {
      const result = await runClient(mode, receiverPort);
      expect(result).toMatchObject({ ok: true });
      if (mode === "quit") expect(result.response).toMatch(/^221 /);
      if (mode === "half-close") expect(result.serverEnded).toBe(true);

      expect(await socketsLeftAfterHangUp(receiverPort)).toEqual([]);
      expect(await serverCpuShare()).toBeLessThan(IDLE_CPU_BUDGET);
    }, 15_000);
  }

  test("20 hang-ups and 20 QUITs after STARTTLS leave nothing behind", async () => {
    expect(await runClient("hangup", receiverPort, { repeat: 20 })).toMatchObject({
      ok: true,
      runs: 20,
    });
    expect(await runClient("quit", receiverPort, { repeat: 20 })).toMatchObject({
      ok: true,
      runs: 20,
    });
    expect(await socketsLeftAfterHangUp(receiverPort)).toEqual([]);
    expect(await serverCpuShare()).toBeLessThan(IDLE_CPU_BUDGET);
  }, 30_000);
});
