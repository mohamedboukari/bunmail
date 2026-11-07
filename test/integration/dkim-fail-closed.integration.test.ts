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
 * A key that decrypts but cannot sign (#345: not a usable PEM, another key
 * type) is held the same way, in every environment: the real mailer signs
 * before any DNS lookup or connection and throws, so nothing is sent.
 *
 * The mailer is injected into `runQueueCycle`, so no SMTP is involved (the
 * #345 cases inject the real `sendMail`, which fails before any network).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { randomBytes } from "crypto";
import { eq, sql } from "drizzle-orm";
import { runQueueCycle } from "../../src/modules/emails/services/queue.service.ts";
import { findUndecryptableDomainKeys } from "../../src/db/encrypt-domain-keys.ts";
import { sendMail } from "../../src/modules/emails/services/mailer.service.ts";
import { encryptSecret } from "../../src/utils/crypto.ts";
import { config } from "../../src/config.ts";
import { suppressions } from "../../src/modules/suppressions/models/suppression.schema.ts";
import { webhookDeliveries } from "../../src/modules/webhooks/models/webhook-delivery.schema.ts";
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

describe("queue: a key that decrypts but cannot sign (#345)", () => {
  /** `seed.domain`'s default key decrypts to a PEM that does not parse. */
  async function queuedWithUnusableKey(): Promise<string> {
    const { id: domainId } = await seed.domain({ name: "unusable.example.com" });
    const { id: apiKeyId } = await seed.apiKey();
    const { id } = await seed.email({
      apiKeyId,
      domainId,
      fromAddress: "hello@unusable.example.com",
      toAddress: "user@example.org",
    });
    return id;
  }

  /** Rows the outcome path would have written: suppressions and webhook deliveries. */
  async function sideEffects(): Promise<{ suppressions: number; deliveries: number }> {
    return {
      suppressions: (await db.select().from(suppressions)).length,
      deliveries: (await db.select().from(webhookDeliveries)).length,
    };
  }

  for (const env of ["production", "development"] as const) {
    test(`${env}: held on the retry backoff, nothing sent, no recipient failure, no suppression`, async () => {
      runtime.env = env;
      const id = await queuedWithUnusableKey();

      await runQueueCycle({ sendMail, signedReturnPath: async () => false });

      const r = await row(id);
      expect(r.status).toBe("queued");
      expect(r.lastError).toContain("cannot be used to sign: not sent unsigned");
      expect(r.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 60_000);
      expect(r.deliveryState).toBeNull();
      expect(await sideEffects()).toEqual({ suppressions: 0, deliveries: 0 });
    });
  }

  test("fails the email once it is too old to retry, still without sending", async () => {
    runtime.env = "production";
    const id = await queuedWithUnusableKey();
    await db
      .update(emails)
      .set({ createdAt: sql`NOW() - interval '49 hours'` })
      .where(eq(emails.id, id));

    await runQueueCycle({ sendMail, signedReturnPath: async () => false });

    const r = await row(id);
    expect(r.status).toBe("failed");
    expect(r.lastError).toContain("cannot be used to sign");
    expect(r.deliveryState).toBeNull();
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
