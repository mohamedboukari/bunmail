/**
 * Implicit TLS on the SMTP submission server (#349), under Bun.
 *
 * The BunMail submission server runs in this (Bun) process with
 * `mx1.example.test`, a leaf of the test CA, which every client verifies
 * against that CA; every client is a Node child process
 * (`test/fixtures/smtp-submission-client.mjs`), so the client is never the
 * thing under test. Bun cannot act as a STARTTLS server, and smtp-server's
 * own implicit TLS fails under Bun for the same reason, so BunMail
 * terminates TLS with the runtime's TLS server and hands each socket to
 * smtp-server (`SMTPServer#connect`). These tests pin that handover: a
 * smtp-server upgrade that breaks it fails here.
 *
 * They also pin #351: a client hanging up at any stage must leave no
 * socket behind (Bun kept one in CLOSE_WAIT and spun a CPU core on it).
 */

import { readFileSync } from "fs";
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
  /** Why the client failed: what the server said, or that it closed or never answered. */
  error?: string;
  protocol?: string;
  greeting?: string[];
  ehlo?: string[];
  hex?: string;
  text?: string;
  /** How many connections a hang-up mode made (#351). */
  runs?: number;
  /** Whether the server closed the connection before the client did. */
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
    response: text("response"),
    code: text("code") ?? null,
    error: text("error"),
    protocol: text("protocol"),
    greeting: lines("greeting"),
    ehlo: lines("ehlo"),
    hex: text("hex"),
    text: text("text"),
    runs: typeof field("runs") === "number" ? Number(field("runs")) : undefined,
    serverEnded: field("serverEnded") === true,
  };
}

/** What the Node client does; the hang-up modes are #351's stages. */
type ClientMode =
  | "send"
  | "starttls"
  | "ehlo"
  | "plaintext"
  | "tcp-hangup"
  | "handshake-hangup"
  | "hangup"
  | "half-close"
  | "quit";

/** Runs the Node client in `mode` against the test server. */
async function runClient(
  mode: ClientMode,
  env: { key?: string; subject?: string; repeat?: number } = {},
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
      SUBMISSION_REPEAT: String(env.repeat ?? 1),
    },
  });
  const out = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  const last = out.trim().split("\n").pop() ?? "";
  if (last === "") {
    /** The fixture always prints a line; say so instead of a JSON parse error. */
    return { ok: false, error: `the client printed nothing (exit code ${exitCode})` };
  }
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
    /** A leaf of the test CA: the client verifies it against that CA. */
    certPath: `${TLS_DIR}mx1.example.test.cert.pem`,
    keyPath: `${TLS_DIR}mx1.example.test.key.pem`,
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
    expect(result).toMatchObject({ ok: true });
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
    expect(result).toMatchObject({ ok: true });
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
    expect(result).toMatchObject({ ok: true });
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
    /** The server waits for a TLS ClientHello, so the plaintext greeting never comes. */
    expect(result).toMatchObject({ ok: false, code: "ETIMEDOUT" });

    const rows = await db.select().from(emails).where(eq(emails.apiKeyId, apiKeyId));
    expect(rows).toHaveLength(0);
  });

  test("a client hanging up mid-session leaves the server working", async () => {
    await waitForStart();
    const hangup = await runClient("hangup");
    expect(hangup).toMatchObject({ ok: true });
    expect(hangup.greeting?.at(-1)).toMatch(/^220 /);

    const { id: apiKeyId, rawKey } = await seed.apiKey();
    const result = await runClient("send", { key: rawKey, subject: "after a hang-up" });
    expect(result).toMatchObject({ ok: true });
    const rows = await db.select().from(emails).where(eq(emails.apiKeyId, apiKeyId));
    expect(rows.map((row) => row.subject)).toEqual(["after a hang-up"]);
  });
});

/* ─── #351: a client hanging up leaves nothing behind ─── */

/** `/proc/net/tcp` state codes of a server socket a gone client must not leave. */
const LINGERING_STATES = new Map([
  ["01", "ESTABLISHED"],
  ["08", "CLOSE_WAIT"],
]);

/**
 * The server's sockets on the test port that are still open for a client
 * (the listener aside). Linux: the kernel's TCP tables, by local port (the
 * Node clients use ephemeral ports, never this one). macOS: `lsof` on this
 * process, where a socket the runtime never released also shows as CLOSED.
 */
function lingeringSockets(): string[] {
  if (process.platform === "linux") {
    const local = `:${TEST_PORT.toString(16).toUpperCase().padStart(4, "0")}`;
    const states: string[] = [];
    for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      let rows: string[];
      try {
        rows = readFileSync(table, "utf8").split("\n").slice(1);
      } catch {
        /** No IPv6 table on a host without IPv6. */
        continue;
      }
      for (const row of rows) {
        const [, address, , state] = row.trim().split(/\s+/);
        const name = state === undefined ? undefined : LINGERING_STATES.get(state);
        if (address?.endsWith(local) && name !== undefined) states.push(name);
      }
    }
    return states;
  }
  const lsof = Bun.which("lsof");
  if (lsof === null) throw new Error("these tests need /proc/net/tcp or `lsof`");
  const out = Bun.spawnSync([
    lsof,
    "-nP",
    "-a",
    "-p",
    String(process.pid),
    `-iTCP:${TEST_PORT}`,
  ]).stdout.toString();
  return out
    .split("\n")
    .map((line) => /\((ESTABLISHED|CLOSE_WAIT|CLOSED)\)$/.exec(line.trim())?.[1])
    .filter((state) => state !== undefined);
}

/** Polls for up to 2 s until no socket lingers; returns what is left. */
async function socketsLeftAfterHangUp(): Promise<string[]> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const left = lingeringSockets();
    if (left.length === 0 || Date.now() > deadline) return left;
    await Bun.sleep(50);
  }
}

/**
 * The share of one CPU core this (server) process uses over 3 s, after a
 * short settle. A socket Bun spins on takes the whole core (about 1.0);
 * idle is a few percent. The 0.25 budget leaves room both ways, so a busy
 * shared CI runner neither fails it nor hides a spin.
 */
const IDLE_CPU_BUDGET = 0.25;
async function serverCpuShare(): Promise<number> {
  await Bun.sleep(250);
  const before = process.cpuUsage();
  const startedAt = performance.now();
  await Bun.sleep(3000);
  const used = process.cpuUsage(before);
  return (used.user + used.system) / 1000 / (performance.now() - startedAt);
}

describe("SMTP submission: implicit TLS, client hang-ups (#351)", () => {
  const savedRateLimit = { ...config.smtpSubmission.connectionRateLimit };

  beforeAll(() => {
    /** Dozens of connections from 127.0.0.1: keep the per-IP limit out of it. */
    Object.assign(config.smtpSubmission.connectionRateLimit, { enabled: false });
  });

  afterAll(() => {
    Object.assign(config.smtpSubmission.connectionRateLimit, savedRateLimit);
  });

  const stages: { name: string; mode: ClientMode }[] = [
    { name: "(a) TCP connect, closed before any TLS byte", mode: "tcp-hangup" },
    { name: "(b) closed mid-handshake", mode: "handshake-hangup" },
    { name: "(c) TLS and the greeting, closed without QUIT", mode: "hangup" },
    { name: "(d) TLS and EHLO, then a half-close", mode: "half-close" },
    { name: "(e) QUIT, closed while the server closes its side", mode: "quit" },
  ];

  for (const { name, mode } of stages) {
    test(`${name}: no socket left, no CPU spin`, async () => {
      await waitForStart();
      const result = await runClient(mode);
      expect(result).toMatchObject({ ok: true });
      if (mode === "quit") expect(result.response).toMatch(/^221 /);
      /** A half-closed client is closed by the server, not left half-open. */
      if (mode === "half-close") expect(result.serverEnded).toBe(true);

      expect(await socketsLeftAfterHangUp()).toEqual([]);
      expect(await serverCpuShare()).toBeLessThan(IDLE_CPU_BUDGET);
    }, 15_000);
  }

  test("20 quick hang-ups and 20 QUITs leave nothing behind, and a client still sends", async () => {
    await waitForStart();
    expect(await runClient("hangup", { repeat: 20 })).toMatchObject({
      ok: true,
      runs: 20,
    });
    expect(await runClient("quit", { repeat: 20 })).toMatchObject({
      ok: true,
      runs: 20,
    });

    expect(await socketsLeftAfterHangUp()).toEqual([]);
    expect(await serverCpuShare()).toBeLessThan(IDLE_CPU_BUDGET);

    const { id: apiKeyId, rawKey } = await seed.apiKey();
    const result = await runClient("send", { key: rawKey, subject: "after 40 hang-ups" });
    expect(result).toMatchObject({ ok: true });
    const rows = await db.select().from(emails).where(eq(emails.apiKeyId, apiKeyId));
    expect(rows.map((row) => row.subject)).toEqual(["after 40 hang-ups"]);
  }, 30_000);
});
