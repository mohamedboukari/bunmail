/**
 * Log context of background work (#284), against real Postgres and a real
 * SMTP connection: every line a queued email attempt writes carries the
 * email id, and every line of an SMTP submission session (including the
 * close summary) carries the session id.
 */
import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  spyOn,
} from "bun:test";
import { createTransport } from "nodemailer";
import { runQueueCycle } from "../../src/modules/emails/services/queue.service.ts";
import * as smtpSubmission from "../../src/modules/smtp-submission/services/smtp-submission.service.ts";
import * as smtpReceiver from "../../src/modules/inbound/services/smtp-receiver.service.ts";
import { config } from "../../src/config.ts";
import { sql } from "drizzle-orm";
import type { sendMail } from "../../src/modules/emails/services/mailer.service.ts";
import { getLogContext, type LogContext } from "../../src/utils/log-context.ts";
import { logger } from "../../src/utils/logger.ts";
import { truncateAll, seed, db } from "./_helpers.ts";

/** Isolated ports, distinct from the other SMTP test files. */
const TEST_PORT = 12590;
const INBOUND_PORT = 12591;

/** Inbound settings this file overrides, restored after the run. */
const savedSmtp = { ...config.smtp, spamProtection: { ...config.smtp.spamProtection } };

/** A log call and the context that was active when it was made. */
interface Captured {
  message: string;
  context: LogContext | undefined;
}

let captured: Captured[] = [];
const spies: Array<{ mockRestore: () => void }> = [];

beforeAll(() => {
  smtpSubmission.start(TEST_PORT);
  /** Inbound receiver on a free port, without network checks (DNSBL) or a seeded domain. */
  /** `config` is typed read-only; the runtime object is plain, so tests override it in place. */
  Object.assign(config.smtp, { port: INBOUND_PORT });
  Object.assign(config.smtp.spamProtection, {
    dnsblEnabled: false,
    rateLimitEnabled: false,
    recipientValidationEnabled: false,
  });
  smtpReceiver.start();
});

afterAll(() => {
  smtpSubmission.stop();
  smtpReceiver.stop();
  Object.assign(config.smtp, { port: savedSmtp.port });
  Object.assign(config.smtp.spamProtection, savedSmtp.spamProtection);
});

/** Waits up to 3 s for a captured line with `message`. */
async function waitForLine(message: string): Promise<Captured | undefined> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const found = captured.find((c) => c.message === message);
    if (found) return found;
    await Bun.sleep(20);
  }
  return undefined;
}

beforeEach(async () => {
  await truncateAll();
  captured = [];
  for (const level of ["debug", "info", "warn", "error"] as const) {
    spies.push(
      spyOn(logger, level).mockImplementation((message: string) => {
        captured.push({ message, context: getLogContext() });
      }),
    );
  }
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

/** A mailer that delivers instantly, so no SMTP is involved in the queue test. */
const deliveredMailer: typeof sendMail = async (options) => ({
  messageId: options.messageId,
  deliveryState: {
    "mx.example.org": { status: "sent", recipients: ["user@example.org"], attempts: 1 },
  },
});

describe("queue", () => {
  test("every line of a send attempt carries the email id", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id } = await seed.email({ apiKeyId, toAddress: "user@example.org" });

    await runQueueCycle({ sendMail: deliveredMailer });

    const attemptLines = captured.filter((c) => c.context?.jobId === id);
    expect(attemptLines.map((c) => c.message)).toContain("Processing email");
    expect(attemptLines.map((c) => c.message)).toContain("Email reached terminal state");
    for (const line of attemptLines) expect(line.context?.job).toBe("email-send");
  });
});

describe("SMTP submission", () => {
  test("the session's lines, including the close summary, carry its id", async () => {
    const { rawKey } = await seed.apiKey();
    const transport = createTransport({
      host: "127.0.0.1",
      port: TEST_PORT,
      secure: false,
      ignoreTLS: true,
      auth: { user: "apikey", pass: rawKey },
      tls: { rejectUnauthorized: false },
    });
    await transport.sendMail({
      from: "hello@unregistered.test",
      to: "user@example.org",
      subject: "context",
      text: "hi",
    });
    transport.close();

    /** The close summary arrives after the client disconnects. */
    const deadline = Date.now() + 3000;
    while (
      !captured.some((c) => c.message === "SMTP session closed") &&
      Date.now() < deadline
    ) {
      await Bun.sleep(20);
    }

    const closed = captured.find((c) => c.message === "SMTP session closed");
    expect(closed?.context?.listener).toBe("submission");
    const sessionId = closed?.context?.smtpSessionId ?? "";
    expect(sessionId).not.toBe("");

    const sessionLines = captured.filter((c) => c.context?.smtpSessionId === sessionId);
    /** More than the summary: the AUTH and DATA handlers logged inside it too. */
    expect(sessionLines.length).toBeGreaterThan(1);
  });
});

describe("inbound SMTP", () => {
  /**
   * End to end through the real receiver: the wrapped handlers still
   * accept and store a message, and the session's lines carry its id.
   */
  test("a delivered message is stored and its session's lines carry the session id", async () => {
    /** Unique per run: `truncateAll` does not clear `inbound_emails`. */
    const subject = `inbound context ${crypto.randomUUID()}`;
    const transport = createTransport({
      host: "127.0.0.1",
      port: INBOUND_PORT,
      secure: false,
      ignoreTLS: true,
    });
    await transport.sendMail({
      from: "sender@example.net",
      to: "inbox@example.org",
      subject,
      text: "hello",
    });
    transport.close();

    const closed = await waitForLine("SMTP session closed");
    expect(closed?.context?.listener).toBe("inbound");
    const sessionId = closed?.context?.smtpSessionId ?? "";
    expect(sessionId).not.toBe("");
    expect(
      captured.filter((c) => c.context?.smtpSessionId === sessionId).length,
    ).toBeGreaterThan(1);

    /** The message made it through onData into storage. */
    const deadline = Date.now() + 3000;
    let stored = 0;
    while (Date.now() < deadline) {
      const rows = await db.execute(
        sql`SELECT count(*)::int AS n FROM inbound_emails WHERE subject = ${subject}`,
      );
      stored = Number(rows[0]?.["n"]);
      if (stored > 0) break;
      await Bun.sleep(20);
    }
    expect(stored).toBe(1);
  });
});
