/**
 * Integration tests for the SMTP submission server (#120) against a real
 * Postgres and a real Nodemailer SMTP client.
 *
 * This is the faithful end-to-end path: a client authenticates with an
 * API key over SMTP, submits a message, and we assert a real `emails` row
 * was queued and attributed to that key — exercising `onAuth`
 * (findByHash), the message mapper, and `createEmail` together. Runs on an
 * isolated high port so it never collides with a locally-running instance.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import nodemailer from "nodemailer";
import * as smtpSubmission from "../../src/modules/smtp-submission/services/smtp-submission.service.ts";
import { truncateAll, seed, db, emails } from "./_helpers.ts";

/** Isolated port for the test server (avoids the privileged 587 default). */
const TEST_PORT = 12587;

/** Builds a Nodemailer transport pointed at the test submission server. */
function transport(pass: string, user = "apikey") {
  return nodemailer.createTransport({
    host: "127.0.0.1",
    port: TEST_PORT,
    secure: false,
    /** Force plaintext AUTH — don't attempt STARTTLS against the test server. */
    ignoreTLS: true,
    auth: { user, pass },
    tls: { rejectUnauthorized: false },
  });
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

describe("SMTP submission — authentication", () => {
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
    await expect(
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

    await expect(
      transport(rawKey).sendMail({
        from: "hello@unregistered.test",
        to: "user@example.org",
        subject: "revoked",
        text: "nope",
      }),
    ).rejects.toThrow();
  });
});

describe("SMTP submission — recipient handling", () => {
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
});
