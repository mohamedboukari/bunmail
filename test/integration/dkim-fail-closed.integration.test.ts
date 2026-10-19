/**
 * Unreadable DKIM keys fail closed in production (#244), real Postgres.
 *
 * A stored DKIM key that does not decrypt with `DKIM_ENCRYPTION_KEY` (a
 * regenerated `.env`, a rotation without re-encryption) used to send
 * every email from that domain unsigned, silently. Now:
 * - production holds the email on the retry backoff, then fails it once
 *   it is too old to retry; nothing is ever sent unsigned;
 * - development still sends, unsigned;
 * - the boot check names every domain whose key does not decrypt.
 *
 * The mailer is injected into `runQueueCycle`, so no SMTP is involved.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { randomBytes } from "crypto";
import { eq, sql } from "drizzle-orm";
import { runQueueCycle } from "../../src/modules/emails/services/queue.service.ts";
import { findUndecryptableDomainKeys } from "../../src/db/encrypt-domain-keys.ts";
import type { sendMail } from "../../src/modules/emails/services/mailer.service.ts";
import { encryptSecret } from "../../src/utils/crypto.ts";
import { config } from "../../src/config.ts";
import { truncateAll, seed, db, emails, domains } from "./_helpers.ts";

/** Runtime handle on the environment (config is read-only at the type level). */
const runtime = config as { env: "development" | "production" };
const originalEnv = runtime.env;

/** A mailer that records its calls and reports one delivered MX group. */
function recordingMailer(): {
  mailer: typeof sendMail;
  calls: Parameters<typeof sendMail>[0][];
} {
  const calls: Parameters<typeof sendMail>[0][] = [];
  const mailer: typeof sendMail = async (options) => {
    calls.push(options);
    return {
      messageId: options.messageId,
      deliveryState: {
        "mx.example.org": {
          status: "sent",
          recipients: ["user@example.org"],
          attempts: 1,
        },
      },
    };
  };
  return { mailer, calls };
}

/** Seeds a domain whose stored key was encrypted under some other key. */
async function domainWithUnreadableKey(name: string): Promise<string> {
  const { id } = await seed.domain({ name });
  await db
    .update(domains)
    .set({
      dkimPrivateKey: encryptSecret(
        "-----BEGIN PRIVATE KEY-----\nX\n-----END PRIVATE KEY-----",
        randomBytes(32),
      ),
    })
    .where(eq(domains.id, id));
  return id;
}

async function row(id: string) {
  const [r] = await db.select().from(emails).where(eq(emails.id, id));
  if (!r) throw new Error(`email ${id} not found`);
  return r;
}

beforeEach(async () => {
  await truncateAll();
});

afterEach(() => {
  runtime.env = originalEnv;
});

describe("queue (production)", () => {
  test("holds the email on the retry backoff instead of sending it unsigned", async () => {
    runtime.env = "production";
    const domainId = await domainWithUnreadableKey("unreadable.example.com");
    const { id: apiKeyId } = await seed.apiKey();
    const { id } = await seed.email({
      apiKeyId,
      domainId,
      fromAddress: "hello@unreadable.example.com",
      toAddress: "user@example.org",
    });
    const { mailer, calls } = recordingMailer();

    await runQueueCycle({ sendMail: mailer });

    expect(calls).toHaveLength(0);
    const r = await row(id);
    expect(r.status).toBe("queued");
    expect(r.lastError).toContain("cannot be decrypted");
    expect(r.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 60_000);
  });

  test("fails the email once it is too old to retry, still without sending", async () => {
    runtime.env = "production";
    const domainId = await domainWithUnreadableKey("unreadable.example.com");
    const { id: apiKeyId } = await seed.apiKey();
    const { id } = await seed.email({
      apiKeyId,
      domainId,
      fromAddress: "hello@unreadable.example.com",
      toAddress: "user@example.org",
    });
    await db
      .update(emails)
      .set({ createdAt: sql`NOW() - interval '49 hours'` })
      .where(eq(emails.id, id));
    const { mailer, calls } = recordingMailer();

    await runQueueCycle({ sendMail: mailer });

    expect(calls).toHaveLength(0);
    const r = await row(id);
    expect(r.status).toBe("failed");
    expect(r.lastError).toContain("cannot be decrypted");
  });

  test("a readable key still signs", async () => {
    runtime.env = "production";
    const { id: domainId } = await seed.domain({ name: "readable.example.com" });
    const { id: apiKeyId } = await seed.apiKey();
    await seed.email({
      apiKeyId,
      domainId,
      fromAddress: "hello@readable.example.com",
      toAddress: "user@example.org",
    });
    const { mailer, calls } = recordingMailer();

    await runQueueCycle({ sendMail: mailer });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.dkim?.domainName).toBe("readable.example.com");
  });
});

describe("queue (development)", () => {
  test("sends unsigned, as before", async () => {
    runtime.env = "development";
    const domainId = await domainWithUnreadableKey("unreadable.example.com");
    const { id: apiKeyId } = await seed.apiKey();
    await seed.email({
      apiKeyId,
      domainId,
      fromAddress: "hello@unreadable.example.com",
      toAddress: "user@example.org",
    });
    const { mailer, calls } = recordingMailer();

    await runQueueCycle({ sendMail: mailer });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.dkim).toBeUndefined();
  });
});

describe("boot check", () => {
  test("names exactly the domains whose key does not decrypt", async () => {
    await seed.domain({ name: "fine.example.com" });
    await domainWithUnreadableKey("broken-a.example.com");
    await domainWithUnreadableKey("broken-b.example.com");

    const found = await findUndecryptableDomainKeys();
    expect(found.active.toSorted()).toEqual([
      "broken-a.example.com",
      "broken-b.example.com",
    ]);
    expect(found.pending).toEqual([]);
  });

  test("is empty when every key decrypts", async () => {
    await seed.domain({ name: "fine.example.com" });
    expect(await findUndecryptableDomainKeys()).toEqual({ active: [], pending: [] });
  });
});
