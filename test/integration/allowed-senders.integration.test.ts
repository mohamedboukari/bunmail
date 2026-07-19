/**
 * Integration tests for the per-API-key allowed-senders authorization gate
 * (#126) against a real Postgres. Exercises the `createEmail` gate (which
 * covers BOTH the REST send API and the SMTP submission server, since both
 * call it), the create/update service paths, and the live SMTP submission
 * server rejecting a disallowed From.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import nodemailer from "nodemailer";
import { createEmail } from "../../src/modules/emails/services/email.service.ts";
import {
  createApiKey,
  updateApiKey,
} from "../../src/modules/api-keys/services/api-key.service.ts";
import { UnauthorizedSenderError } from "../../src/modules/api-keys/errors.ts";
import * as smtpSubmission from "../../src/modules/smtp-submission/services/smtp-submission.service.ts";
import { truncateAll, seed, db, emails } from "./_helpers.ts";

const TEST_PORT = 12589;

function transport(pass: string) {
  return nodemailer.createTransport({
    host: "127.0.0.1",
    port: TEST_PORT,
    secure: false,
    ignoreTLS: true,
    auth: { user: "apikey", pass },
    tls: { rejectUnauthorized: false },
  });
}

beforeAll(() => smtpSubmission.start(TEST_PORT));
afterAll(() => smtpSubmission.stop());
beforeEach(async () => {
  await truncateAll();
});

describe("createEmail — allowed-senders gate (covers REST + SMTP)", () => {
  test("empty allowlist (default) permits any sender", async () => {
    const { apiKey } = await createApiKey({ name: "unrestricted" });
    const email = await createEmail(
      { from: "anyone@example.com", to: "user@example.org", subject: "hi" },
      apiKey.id,
    );
    expect(email.fromAddress).toBe("anyone@example.com");
  });

  test("non-empty allowlist permits an address on the list", async () => {
    const { apiKey } = await createApiKey({
      name: "restricted",
      allowedSenders: ["noreply@example.com"],
    });
    const email = await createEmail(
      { from: "noreply@example.com", to: "user@example.org", subject: "hi" },
      apiKey.id,
    );
    expect(email.fromAddress).toBe("noreply@example.com");
  });

  test("non-empty allowlist rejects an address NOT on the list (anti-spoofing)", async () => {
    const { apiKey } = await createApiKey({
      name: "restricted",
      allowedSenders: ["noreply@example.com"],
    });
    await expect(
      createEmail(
        { from: "ceo@example.com", to: "user@example.org", subject: "spoof" },
        apiKey.id,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedSenderError);

    /** Nothing queued. */
    const rows = await db.select().from(emails).where(eq(emails.apiKeyId, apiKey.id));
    expect(rows).toHaveLength(0);
  });

  test("match is case-insensitive", async () => {
    const { apiKey } = await createApiKey({
      name: "restricted",
      allowedSenders: ["NoReply@Example.com"],
    });
    const email = await createEmail(
      { from: "noreply@EXAMPLE.com", to: "user@example.org", subject: "hi" },
      apiKey.id,
    );
    expect(email.status).toBe("queued");
  });

  test("update can add an address (previously blocked send now allowed) and remove it again", async () => {
    const { apiKey } = await createApiKey({
      name: "restricted",
      allowedSenders: ["noreply@example.com"],
    });

    /** Blocked before adding. */
    await expect(
      createEmail(
        { from: "ceo@example.com", to: "user@example.org", subject: "1" },
        apiKey.id,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedSenderError);

    /** Add ceo@ → now allowed. */
    await updateApiKey(apiKey.id, {
      allowedSenders: ["noreply@example.com", "ceo@example.com"],
    });
    const ok = await createEmail(
      { from: "ceo@example.com", to: "user@example.org", subject: "2" },
      apiKey.id,
    );
    expect(ok.status).toBe("queued");

    /** Remove ceo@ → blocked again. */
    await updateApiKey(apiKey.id, { allowedSenders: ["noreply@example.com"] });
    await expect(
      createEmail(
        { from: "ceo@example.com", to: "user@example.org", subject: "3" },
        apiKey.id,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedSenderError);
  });
});

describe("SMTP submission respects the allowlist (live server)", () => {
  test("a disallowed From is rejected over SMTP; an allowed one succeeds", async () => {
    const { apiKey, rawKey } = await createApiKey({
      name: "restricted",
      allowedSenders: ["noreply@example.com"],
    });

    /** Disallowed From → SMTP rejects (createEmail throws → 550). */
    await expect(
      transport(rawKey).sendMail({
        from: "ceo@example.com",
        to: "user@example.org",
        subject: "spoof",
        text: "no",
      }),
    ).rejects.toThrow();

    /** Allowed From → accepted + queued. */
    const info = await transport(rawKey).sendMail({
      from: "noreply@example.com",
      to: "user@example.org",
      subject: "ok",
      text: "yes",
    });
    expect(info.accepted.length).toBeGreaterThan(0);

    const rows = await db.select().from(emails).where(eq(emails.apiKeyId, apiKey.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fromAddress).toBe("noreply@example.com");
  });
});
