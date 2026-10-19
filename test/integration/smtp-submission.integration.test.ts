/**
 * Integration tests for the SMTP submission server (#120) against a real
 * Postgres and a real Nodemailer SMTP client.
 *
 * This is the faithful end-to-end path: a client authenticates with an
 * API key over SMTP, submits a message, and we assert a real `emails` row
 * was queued and attributed to that key: exercising `onAuth`
 * (findByHash), the message mapper, and `createEmail` together. Runs on an
 * isolated high port so it never collides with a locally-running instance.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "bun:test";
import { eq } from "drizzle-orm";
import { createTransport } from "nodemailer";
import * as smtpSubmission from "../../src/modules/smtp-submission/services/smtp-submission.service.ts";
import { config } from "../../src/config.ts";
import { emailAttachments } from "../../src/modules/emails/models/email-attachment.schema.ts";
import { truncateAll, seed, db, emails } from "./_helpers.ts";

/** Isolated port for the test server (avoids the privileged 587 default). */
const TEST_PORT = 12587;

/** Builds a Nodemailer transport pointed at the test submission server. */
function transport(pass: string, user = "apikey") {
  return createTransport({
    host: "127.0.0.1",
    port: TEST_PORT,
    secure: false,
    /** Force plaintext AUTH: don't attempt STARTTLS against the test server. */
    ignoreTLS: true,
    auth: { user, pass },
    tls: { rejectUnauthorized: false },
  });
}

/** Awaits a send that must fail and returns its error message. */
async function failureOf(send: Promise<unknown>): Promise<string> {
  try {
    await send;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the submission to be rejected");
}

beforeAll(() => {
  smtpSubmission.start(TEST_PORT);
});

afterAll(() => {
  smtpSubmission.stop();
});

beforeEach(async () => {
  await truncateAll();
});

describe("SMTP submission: authentication", () => {
  test("a valid API key authenticates and queues the message", async () => {
    const { id: apiKeyId, rawKey } = await seed.apiKey();

    const info = await transport(rawKey).sendMail({
      from: "hello@unregistered.test",
      to: "user@example.org",
      subject: "via smtp",
      html: "<p>hi</p>",
      text: "hi",
    });
    expect(info.accepted.length).toBeGreaterThan(0);

    const rows = await db.select().from(emails).where(eq(emails.apiKeyId, apiKeyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("queued");
    expect(rows[0]!.fromAddress).toBe("hello@unregistered.test");
    expect(rows[0]!.toAddress).toBe("user@example.org");
    expect(rows[0]!.subject).toBe("via smtp");
  });

  test("an invalid API key is rejected and queues nothing", async () => {
    expect(
      transport("bm_live_totally_invalid_key").sendMail({
        from: "hello@unregistered.test",
        to: "user@example.org",
        subject: "should fail",
        text: "nope",
      }),
    ).rejects.toThrow();

    const rows = await db.select().from(emails);
    expect(rows).toHaveLength(0);
  });

  test("a revoked (inactive) API key is rejected", async () => {
    const { id, rawKey } = await seed.apiKey();
    /** Deactivate the key directly, then confirm AUTH now fails. */
    const { apiKeys } =
      await import("../../src/modules/api-keys/models/api-key.schema.ts");
    await db.update(apiKeys).set({ isActive: false }).where(eq(apiKeys.id, id));

    expect(
      transport(rawKey).sendMail({
        from: "hello@unregistered.test",
        to: "user@example.org",
        subject: "revoked",
        text: "nope",
      }),
    ).rejects.toThrow();
  });

  test("revoking a key stops a session that authenticated before the revocation", async () => {
    const { id, rawKey } = await seed.apiKey();
    /** A pooled transport keeps one authenticated SMTP session open. */
    const session = createTransport({
      host: "127.0.0.1",
      port: TEST_PORT,
      secure: false,
      ignoreTLS: true,
      auth: { user: "apikey", pass: rawKey },
      pool: true,
      maxConnections: 1,
    });
    const message = {
      from: "hello@unregistered.test",
      to: "user@example.org",
      text: "hi",
    };

    try {
      await session.sendMail({ ...message, subject: "before" });

      const { apiKeys } =
        await import("../../src/modules/api-keys/models/api-key.schema.ts");
      await db.update(apiKeys).set({ isActive: false }).where(eq(apiKeys.id, id));

      expect(session.sendMail({ ...message, subject: "after" })).rejects.toThrow(
        /revoked/,
      );
    } finally {
      session.close();
    }

    const rows = await db.select().from(emails).where(eq(emails.apiKeyId, id));
    expect(rows.map((r) => r.subject)).toEqual(["before"]);
  });
});

describe("SMTP submission: failed-AUTH throttle (#190)", () => {
  /** Runtime handle on the throttle settings (config is import-time). */
  const authLimit = config.smtpSubmission.authRateLimit as {
    maxAttempts: number;
    windowSec: number;
  };
  const original = { ...authLimit };

  afterEach(() => {
    authLimit.maxAttempts = original.maxAttempts;
    authLimit.windowSec = original.windowSec;
  });

  test("a successful AUTH does not clear the IP's earlier failures", async () => {
    /** A short window starts a fresh count and keeps the lockout from leaking into other tests. */
    authLimit.maxAttempts = 3;
    authLimit.windowSec = 2;
    /** Earlier tests' failures from this IP fall out of the short window. */
    await Bun.sleep(2100);
    const { rawKey } = await seed.apiKey();
    const message = {
      from: "hello@unregistered.test",
      to: "user@example.org",
      subject: "probe",
      text: "hi",
    };

    expect(await failureOf(transport("bm_live_wrong_one").sendMail(message))).toContain(
      "535",
    );
    expect(await failureOf(transport("bm_live_wrong_two").sendMail(message))).toContain(
      "535",
    );
    /** One valid login between guesses... */
    await transport(rawKey).sendMail(message);
    expect(await failureOf(transport("bm_live_wrong_three").sendMail(message))).toContain(
      "535",
    );

    /** ...did not reset the count: the third failure locks the IP out, valid key included. */
    expect(await failureOf(transport(rawKey).sendMail(message))).toContain("454");
    expect(await db.select().from(emails)).toHaveLength(1);

    /** Let the short window lapse so later tests start clean. */
    await Bun.sleep(2100);
  });
});

describe("SMTP submission: recipient handling", () => {
  test("drops a header address longer than 254 characters instead of storing it", async () => {
    const { id: apiKeyId, rawKey } = await seed.apiKey();
    const overLong = "a".repeat(300) + "@example.org";

    await transport(rawKey).sendMail({
      from: "hello@unregistered.test",
      to: "user@example.org",
      cc: overLong,
      subject: "long cc",
      text: "hi",
      envelope: { from: "hello@unregistered.test", to: ["user@example.org", overLong] },
    });

    const rows = await db.select().from(emails).where(eq(emails.apiKeyId, apiKeyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.toAddress).toBe("user@example.org");
    expect(rows[0]!.cc).toBeNull();
    expect(rows[0]!.bcc).toBeNull();
  });

  test("only envelope recipients are delivered, whatever the To header lists", async () => {
    const { id: apiKeyId, rawKey } = await seed.apiKey();

    await transport(rawKey).sendMail({
      from: "hello@unregistered.test",
      to: ["one@example.org", "two@example.org", "three@example.org"],
      subject: "fan-out",
      text: "hi",
      /** One RCPT TO, three addresses in the visible To header. */
      envelope: { from: "hello@unregistered.test", to: ["one@example.org"] },
    });

    const rows = await db.select().from(emails).where(eq(emails.apiKeyId, apiKeyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.toAddress).toBe("one@example.org");
    expect(rows[0]!.cc).toBeNull();
    expect(rows[0]!.bcc).toBeNull();
  });

  test("BCC recipients are delivered but kept out of the visible headers", async () => {
    const { id: apiKeyId, rawKey } = await seed.apiKey();

    await transport(rawKey).sendMail({
      from: "hello@unregistered.test",
      to: "visible@example.org",
      bcc: "blind@hidden.example",
      subject: "bcc test",
      text: "hi",
    });

    const [row] = await db.select().from(emails).where(eq(emails.apiKeyId, apiKeyId));
    expect(row!.toAddress).toBe("visible@example.org");
    /** The blind recipient lands in bcc, never in to/cc. */
    expect(row!.bcc).toContain("blind@hidden.example");
    expect(row!.toAddress).not.toContain("blind@hidden.example");
  });

  test("CC recipients are preserved in the visible Cc field", async () => {
    const { id: apiKeyId, rawKey } = await seed.apiKey();

    await transport(rawKey).sendMail({
      from: "hello@unregistered.test",
      to: "to@example.org",
      cc: "cc@example.net",
      subject: "cc test",
      text: "hi",
    });

    const [row] = await db.select().from(emails).where(eq(emails.apiKeyId, apiKeyId));
    expect(row!.toAddress).toBe("to@example.org");
    expect(row!.cc).toContain("cc@example.net");
  });

  test("the Reply-To header is relayed, without becoming a recipient (#169)", async () => {
    const { id: apiKeyId, rawKey } = await seed.apiKey();

    await transport(rawKey).sendMail({
      from: "no-reply@unregistered.test",
      to: "to@example.org",
      replyTo: "support@example.net",
      subject: "reply-to test",
      text: "hi",
    });

    const [row] = await db.select().from(emails).where(eq(emails.apiKeyId, apiKeyId));
    expect(row!.replyTo).toBe("support@example.net");
    expect(row!.toAddress).toBe("to@example.org");
    expect(row!.bcc).toBeNull();
  });
});

describe("SMTP submission: sender domain (#245)", () => {
  /** Mutable view of the read-only config, restored after the test. */
  const runtime = config as { env: "development" | "production" };
  const originalEnv = config.env;

  afterEach(() => {
    runtime.env = originalEnv;
  });

  test("production: an unregistered From domain is refused with 550, nothing queued", async () => {
    runtime.env = "production";
    const { id: apiKeyId, rawKey } = await seed.apiKey();

    const failure = await failureOf(
      transport(rawKey).sendMail({
        from: "hello@unregistered.test",
        to: "user@example.org",
        subject: "unregistered",
        text: "hi",
      }),
    );

    expect(failure).toContain("550");
    expect(failure).toContain('Sender domain "unregistered.test" is not registered');
    const rows = await db.select().from(emails).where(eq(emails.apiKeyId, apiKeyId));
    expect(rows).toHaveLength(0);
  });
});

describe("SMTP submission: message content (#250)", () => {
  test("a message with an attachment is queued with it (#181)", async () => {
    const { rawKey } = await seed.apiKey();
    await transport(rawKey).sendMail({
      from: "hello@unregistered.test",
      to: "user@example.org",
      subject: "with attachment",
      text: "see attached",
      attachments: [{ filename: "a.txt", content: "attached" }],
    });
    const rows = await db.select().from(emails);
    expect(rows).toHaveLength(1);
    const files = await db.select().from(emailAttachments);
    expect(files.map((f) => [f.emailId, f.filename, f.contentType, f.sizeBytes])).toEqual(
      [[rows[0]!.id, "a.txt", "text/plain", 8]],
    );
  });

  test("an 8-bit ISO-8859-1 body keeps its characters", async () => {
    const { rawKey } = await seed.apiKey();
    const head = [
      "From: hello@unregistered.test",
      "To: user@example.org",
      "Subject: latin1",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=ISO-8859-1",
      "Content-Transfer-Encoding: 8bit",
      "",
      "",
    ].join("\r\n");
    const raw = Buffer.concat([
      Buffer.from(head, "ascii"),
      Buffer.from("Caf\xe9 cr\xe8me\r\n", "latin1"),
    ]);
    await transport(rawKey).sendMail({
      envelope: { from: "hello@unregistered.test", to: ["user@example.org"] },
      raw,
    });
    const [row] = await db.select().from(emails);
    expect(row?.textContent?.trim()).toBe("Café crème");
  });
});
