/**
 * STARTTLS on the SMTP submission server (`SMTP_SUBMISSION_TLS_MODE=starttls`,
 * #414), under Bun.
 *
 * The submission server runs in this (Bun) process with `mx1.example.test`,
 * a leaf of the test CA; every client is a Node child process
 * (`test/fixtures/smtp-submission-client.mjs`) that verifies it against
 * that CA, so the client is never the thing under test.
 *
 * Server-side STARTTLS needs Bun 1.4.4 or later (Bun 1.3.14 never finishes
 * the handshake, and the config refuses the mode on it), so this file
 * skips on an older Bun (`runtimeHasSocketFeatures`).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, spyOn } from "bun:test";
import type { Mock } from "bun:test";
import { eq } from "drizzle-orm";
import * as smtpSubmission from "../../src/modules/smtp-submission/services/smtp-submission.service.ts";
import { config, runtimeHasSocketFeatures } from "../../src/config.ts";
import { logger } from "../../src/utils/logger.ts";
import { truncateAll, seed, db, emails } from "./_helpers.ts";
import { boundTestPort } from "../listen-port.ts";

/**
 * The STARTTLS server's port (never the privileged 587): it binds 0 and the
 * OS picks a free one (#443).
 */
let submissionPort = 0;

const CLIENT = new URL("../fixtures/smtp-submission-client.mjs", import.meta.url)
  .pathname;
const TLS_DIR = new URL("../fixtures/tls/", import.meta.url).pathname;

/** What the Node client printed: the fields these tests read. */
interface ClientResult {
  ok: boolean;
  response?: string;
  error?: string;
  text?: string;
  ehlo?: string[];
}

/** Narrows the client's JSON line without a cast. */
function toClientResult(line: unknown): ClientResult {
  if (typeof line !== "object" || line === null) throw new Error("bad client output");
  const text = (name: string): string | undefined => {
    const value: unknown = Reflect.get(line, name);
    return typeof value === "string" ? value : undefined;
  };
  const ehlo: unknown = Reflect.get(line, "ehlo");
  return {
    ok: Reflect.get(line, "ok") === true,
    response: text("response"),
    error: text("error"),
    text: text("text"),
    ehlo: Array.isArray(ehlo) ? ehlo.map(String) : undefined,
  };
}

/** Runs the Node client in `mode` against the test server. */
async function runClient(
  mode: "starttls" | "auth-before-starttls",
  env: { key?: string; subject?: string } = {},
): Promise<ClientResult> {
  const node = Bun.which("node");
  if (node === null) throw new Error("these tests need `node` on PATH");
  const proc = Bun.spawn([node, CLIENT, mode, String(submissionPort)], {
    stdout: "pipe",
    stderr: "inherit",
    env: {
      ...process.env,
      SUBMISSION_KEY: env.key ?? "",
      SUBMISSION_SUBJECT: env.subject ?? "over STARTTLS",
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

/** The structured fields of every `info` line with this message so far. */
function infoFields(spy: Mock<typeof logger.info>, message: string): unknown[] {
  return spy.mock.calls.filter((call) => call[0] === message).map((call) => call[1]);
}

describe.skipIf(!runtimeHasSocketFeatures())("SMTP submission: STARTTLS (#414)", () => {
  let infoSpy: Mock<typeof logger.info>;
  const savedTls = { ...config.smtpSubmission.tls };

  beforeAll(async () => {
    infoSpy = spyOn(logger, "info");
    Object.assign(config.smtpSubmission.tls, {
      mode: "starttls",
      certPath: `${TLS_DIR}mx1.example.test.cert.pem`,
      keyPath: `${TLS_DIR}mx1.example.test.key.pem`,
    });
    smtpSubmission.start(0);
    submissionPort = await boundTestPort(
      smtpSubmission.listeningPort(),
      "SMTP submission (STARTTLS)",
    );
  });

  afterAll(() => {
    smtpSubmission.stop();
    Object.assign(config.smtpSubmission.tls, savedTls);
    infoSpy.mockRestore();
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

  test("the start line reports STARTTLS and its port", async () => {
    const started = await waitForStart();
    expect(fieldOf(started, "tls")).toBe("starttls");
    expect(fieldOf(started, "port")).toBe(submissionPort);
  });

  test("STARTTLS, then AUTH with an API key queues the message, in a secure session", async () => {
    await waitForStart();
    const { id: apiKeyId, rawKey } = await seed.apiKey();

    const result = await runClient("starttls", { key: rawKey, subject: "via 587" });
    expect(result).toMatchObject({ ok: true });
    expect(result.response).toMatch(/^250 /);

    const rows = await db.select().from(emails).where(eq(emails.apiKeyId, apiKeyId));
    expect(rows.map((row) => row.subject)).toEqual(["via 587"]);

    const authenticated = infoFields(
      infoSpy,
      "SMTP submission client authenticated",
    ).filter((context) => fieldOf(context, "apiKeyId") === apiKeyId);
    expect(authenticated).toHaveLength(1);
    expect(fieldOf(authenticated[0], "secure")).toBe(true);
  });

  test("AUTH before STARTTLS gets 538, after the key crossed the wire: clients must require STARTTLS", async () => {
    await waitForStart();
    const { id: apiKeyId, rawKey } = await seed.apiKey();

    const result = await runClient("auth-before-starttls", { key: rawKey });
    expect(result).toMatchObject({ ok: true });
    /** EHLO offers STARTTLS; AUTH gets smtp-server's "STARTTLS first" refusal (538). */
    expect((result.ehlo ?? []).some((line) => /STARTTLS/.test(line))).toBe(true);
    expect(result.text).toMatch(/^538 .*STARTTLS/);
    /**
     * The documented residual (THREAT_MODEL.md): AUTH is advertised before
     * TLS too (smtp-server cannot hide it), so only a client that requires
     * STARTTLS keeps its key off the wire. If this ever flips, update the docs.
     */
    expect((result.ehlo ?? []).some((line) => /AUTH PLAIN LOGIN/.test(line))).toBe(true);

    const authenticated = infoFields(
      infoSpy,
      "SMTP submission client authenticated",
    ).filter((context) => fieldOf(context, "apiKeyId") === apiKeyId);
    expect(authenticated).toHaveLength(0);
  });
});
