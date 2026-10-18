/**
 * Webhook signing secrets encrypted at rest (#259), against real Postgres.
 *
 * - `createWebhook` stores only the `v1:` ciphertext and returns the raw
 *   secret once.
 * - The delivery claim decrypts it; a row from before #259 (plaintext)
 *   still works until the boot pass encrypts it.
 * - A secret that does not decrypt fails the attempt without sending.
 * - The boot pass encrypts plaintext rows once and is idempotent.
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { createWebhook } from "../../src/modules/webhooks/services/webhook.service.ts";
import {
  claimDueDeliveries,
  enqueueDelivery,
  performHttpAttempt,
} from "../../src/modules/webhooks/services/webhook-delivery.service.ts";
import { encryptWebhookSecrets } from "../../src/db/encrypt-webhook-secrets.ts";
import { webhooks } from "../../src/modules/webhooks/models/webhook.schema.ts";
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
} from "../../src/utils/crypto.ts";
import { config } from "../../src/config.ts";
import { truncateAll, seed, db } from "./_helpers.ts";

const ENVELOPE = {
  event: "email.sent",
  timestamp: "2026-10-18T12:00:00.000Z",
  data: { emailId: "msg_test", to: "user@example.com" },
} as const;

async function storedSecret(id: string): Promise<string> {
  const [row] = await db
    .select({ secret: webhooks.secret })
    .from(webhooks)
    .where(eq(webhooks.id, id));
  if (!row) throw new Error(`webhook ${id} not found`);
  return row.secret;
}

beforeEach(async () => {
  await truncateAll();
});

describe("createWebhook", () => {
  test("stores only the ciphertext and returns the raw secret once", async () => {
    const { id: apiKeyId } = await seed.apiKey();

    const { webhook, secret } = await createWebhook(
      { url: "https://93.184.216.34/hook", events: ["email.sent"] },
      apiKeyId,
    );

    const stored = await storedSecret(webhook.id);
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
    expect(isEncryptedSecret(stored)).toBe(true);
    expect(stored).not.toContain(secret);
    expect(decryptSecret(stored, config.dkimEncryptionKey)).toBe(secret);
  });
});

describe("delivery claim", () => {
  test("decrypts the secret for signing", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id: webhookId, secret } = await seed.webhook({
      apiKeyId,
      url: "https://93.184.216.34/hook",
      events: ["email.sent"],
    });
    await enqueueDelivery({ webhookId, envelope: ENVELOPE });

    const [claimed] = await claimDueDeliveries(10);
    expect(claimed?.secret).toBe(secret);
  });

  test("a plaintext row from before #259 still signs until the boot pass runs", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id: webhookId } = await seed.webhook({
      apiKeyId,
      url: "https://93.184.216.34/hook",
      events: ["email.sent"],
      secret: "legacy-plaintext-secret",
      storePlaintext: true,
    });
    await enqueueDelivery({ webhookId, envelope: ENVELOPE });

    const [claimed] = await claimDueDeliveries(10);
    expect(claimed?.secret).toBe("legacy-plaintext-secret");
  });

  test("a secret that does not decrypt fails the attempt without sending", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id: webhookId } = await seed.webhook({
      apiKeyId,
      url: "https://93.184.216.34/hook",
      events: ["email.sent"],
      storePlaintext: true,
      /** Encrypted under some other key: what a changed DKIM_ENCRYPTION_KEY looks like. */
      secret: encryptSecret("other-secret", randomBytes(32)),
    });
    await enqueueDelivery({ webhookId, envelope: ENVELOPE });

    const [claimed] = await claimDueDeliveries(10);
    expect(claimed?.secret).toBeNull();

    const fetchImpl = mock(async () => new Response("ok", { status: 200 }));
    const outcome = await performHttpAttempt({
      url: claimed?.url ?? "",
      secret: claimed?.secret ?? null,
      body: "{}",
      event: "email.sent",
      fetchImpl: Object.assign(fetchImpl, { preconnect: () => {} }),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("could not be decrypted");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("boot pass", () => {
  test("encrypts plaintext secrets once and leaves encrypted ones alone", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const plainA = await seed.webhook({
      apiKeyId,
      url: "https://93.184.216.34/a",
      events: ["email.sent"],
      secret: "plain-secret-a",
      storePlaintext: true,
    });
    const plainB = await seed.webhook({
      apiKeyId,
      url: "https://93.184.216.34/b",
      events: ["email.sent"],
      secret: "plain-secret-b",
      storePlaintext: true,
    });
    const already = await seed.webhook({
      apiKeyId,
      url: "https://93.184.216.34/c",
      events: ["email.sent"],
    });
    const alreadyStored = await storedSecret(already.id);

    expect(await encryptWebhookSecrets()).toEqual({ encrypted: 2, skipped: 1 });
    expect(decryptSecret(await storedSecret(plainA.id), config.dkimEncryptionKey)).toBe(
      "plain-secret-a",
    );
    expect(decryptSecret(await storedSecret(plainB.id), config.dkimEncryptionKey)).toBe(
      "plain-secret-b",
    );
    expect(await storedSecret(already.id)).toBe(alreadyStored);

    /** Idempotent. */
    expect(await encryptWebhookSecrets()).toEqual({ encrypted: 0, skipped: 3 });
  });
});
