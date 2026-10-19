/**
 * Implicit TLS on the SMTP submission server (#349), under Bun.
 *
 * The BunMail submission server runs in this (Bun) process with a test
 * certificate; every client is a Node child process
 * (`test/fixtures/smtp-submission-client.mjs`), so the client is never the
 * thing under test. Bun cannot act as a STARTTLS server, and smtp-server's
 * own implicit TLS fails under Bun for the same reason, so BunMail
 * terminates TLS with the runtime's TLS server and hands each socket to
 * smtp-server (`SMTPServer#connect`). These tests pin that handover: a
 * smtp-server upgrade that breaks it fails here.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, spyOn } from "bun:test";
import type { Mock } from "bun:test";
import { eq } from "drizzle-orm";
import * as smtpSubmission from "../../src/modules/smtp-submission/services/smtp-submission.service.ts";
import { config } from "../../src/config.ts";
import { logger } from "../../src/utils/logger.ts";
import { truncateAll, seed, db, emails } from "./_helpers.ts";

/** Isolated port for the implicit-TLS server (avoids the privileged 465). */
const TEST_PORT = 12465;

const CLIENT = new URL("../fixtures/smtp-submission-client.mjs", import.meta.url)
  .pathname;
const TLS_DIR = new URL("../fixtures/tls/", import.meta.url).pathname;

/** What the Node client printed. */
interface ClientResult {
  ok: boolean;
  response?: string;
  code?: string | null;
  message?: string;
  protocol?: string;
  greeting?: string[];
  ehlo?: string[];
  hex?: string;
  text?: string;
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
    response: text("response"),
    code: text("code") ?? null,
    message: text("message"),
    protocol: text("protocol"),
    greeting: lines("greeting"),
    ehlo: lines("ehlo"),
    hex: text("hex"),
    text: text("text"),
  };
}

/** Runs the Node client in `mode` against the test server. */
async function runClient(
  mode: "send" | "starttls" | "ehlo" | "hangup" | "plaintext",
  env: { key?: string; subject?: string } = {},
): Promise<ClientResult> {
  const node = Bun.which("node");
  if (node === null) throw new Error("these tests need `node` on PATH");
  const proc = Bun.spawn([node, CLIENT, mode, String(TEST_PORT)], {
    stdout: "pipe",
    stderr: "inherit",
    env: {
      ...process.env,
      SUBMISSION_KEY: env.key ?? "",
      SUBMISSION_SUBJECT: env.subject ?? "over implicit TLS",
    },
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const last = out.trim().split("\n").pop() ?? "";
  return toClientResult(JSON.parse(last));
}

/** The structured fields of every `info` line with this message so far. */
function infoFields(spy: Mock<typeof logger.info>, message: string): unknown[] {
  return spy.mock.calls.filter((call) => call[0] === message).map((call) => call[1]);
}

/** Reads one field of a logged context object. */
function fieldOf(context: unknown, name: string): unknown {
  return typeof context === "object" && context !== null
    ? Reflect.get(context, name)
    : undefined;
}

let infoSpy: Mock<typeof logger.info>;
let stderrLines: string[] = [];
const savedTls = { ...config.smtpSubmission.tls };

beforeAll(() => {
  infoSpy = spyOn(logger, "info");
  /** smtp-server prints its default-certificate warning on stderr. */
  const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderrLines.push(args.map(String).join(" "));
  });
  Object.assign(config.smtpSubmission.tls, {
    mode: "implicit",
    certPath: `${TLS_DIR}hook.example.test.cert.pem`,
    keyPath: `${TLS_DIR}hook.example.test.key.pem`,
  });
  try {
    smtpSubmission.start(TEST_PORT);
  } finally {
    errorSpy.mockRestore();
  }
});

afterAll(() => {
  smtpSubmission.stop();
  Object.assign(config.smtpSubmission.tls, savedTls);
  infoSpy.mockRestore();
  stderrLines = [];
});

beforeEach(async () => {
  await truncateAll();
});

/** Waits for the server to have started listening (the callback logs it). */
async function waitForStart(): Promise<unknown> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const started = infoFields(infoSpy, "SMTP submission server started");
    if (started.length > 0) return started[0];
    if (Date.now() > deadline) throw new Error("the submission server never started");
    await Bun.sleep(20);
  }
}

describe("SMTP submission: implicit TLS (#349)", () => {
  test("the start line reports implicit TLS and its port", async () => {
    const started = await waitForStart();
    expect(fieldOf(started, "tls")).toBe("implicit");
    expect(fieldOf(started, "port")).toBe(TEST_PORT);
  });

  test("smtp-server is told the TLS is done upstream (no default-certificate warning)", () => {
    expect(
      stderrLines.filter((line) => line.includes("default TLS certificate")),
    ).toEqual([]);
  });

  test("TLS from the first byte, then a greeting and an EHLO without STARTTLS", async () => {
    await waitForStart();
    const result = await runClient("ehlo");
    expect(result.ok).toBe(true);
    expect(result.protocol).toMatch(/^TLSv1\.[23]$/);
    expect(result.greeting?.at(-1)).toMatch(/^220 /);
    const ehlo = result.ehlo ?? [];
    expect(ehlo.some((line) => /AUTH PLAIN LOGIN/.test(line))).toBe(true);
    expect(ehlo.some((line) => /STARTTLS/i.test(line))).toBe(false);
  });

  test("AUTH with an API key over implicit TLS queues the message, in a secure session", async () => {
    await waitForStart();
    const { id: apiKeyId, rawKey } = await seed.apiKey();

    const result = await runClient("send", { key: rawKey, subject: "via 465" });
    expect(result.ok).toBe(true);
    expect(result.response).toMatch(/^250 /);

    const rows = await db.select().from(emails).where(eq(emails.apiKeyId, apiKeyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("queued");
    expect(rows[0]!.subject).toBe("via 465");
    expect(rows[0]!.source).toBe("smtp");

    const authenticated = infoFields(
      infoSpy,
      "SMTP submission client authenticated",
    ).filter((context) => fieldOf(context, "apiKeyId") === apiKeyId);
    expect(authenticated).toHaveLength(1);
    /** `session.secure` in `onAuth`, and the per-IP limits see the real client. */
    expect(fieldOf(authenticated[0], "secure")).toBe(true);
    expect(fieldOf(authenticated[0], "ip")).toMatch(/127\.0\.0\.1$/);
  });

  test("a plaintext client gets a TLS alert, never a greeting or AUTH", async () => {
    await waitForStart();
    const { id: apiKeyId, rawKey } = await seed.apiKey();

    const result = await runClient("plaintext", { key: rawKey });
    expect(result.ok).toBe(true);
    /** A TLS alert record (content type 21), not SMTP text. */
    expect(result.hex?.startsWith("15")).toBe(true);
    expect(result.text).not.toContain("220");
    expect(result.text).not.toContain("235");

    const authenticated = infoFields(
      infoSpy,
      "SMTP submission client authenticated",
    ).filter((context) => fieldOf(context, "apiKeyId") === apiKeyId);
    expect(authenticated).toHaveLength(0);
  });

  test("a STARTTLS client cannot send", async () => {
    await waitForStart();
    const { id: apiKeyId, rawKey } = await seed.apiKey();

    const result = await runClient("starttls", { key: rawKey });
    expect(result.ok).toBe(false);

    const rows = await db.select().from(emails).where(eq(emails.apiKeyId, apiKeyId));
    expect(rows).toHaveLength(0);
  });

  test("a client hanging up mid-session leaves the server working", async () => {
    await waitForStart();
    const hangup = await runClient("hangup");
    expect(hangup.ok).toBe(true);
    expect(hangup.greeting?.at(-1)).toMatch(/^220 /);

    const { id: apiKeyId, rawKey } = await seed.apiKey();
    const result = await runClient("send", { key: rawKey, subject: "after a hang-up" });
    expect(result.ok).toBe(true);
    const rows = await db.select().from(emails).where(eq(emails.apiKeyId, apiKeyId));
    expect(rows.map((row) => row.subject)).toEqual(["after a hang-up"]);
  });
});
