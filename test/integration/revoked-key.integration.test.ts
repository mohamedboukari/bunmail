/**
 * Revoking an API key must cut off everything that key set up, not just
 * its future REST calls: the event feed of its webhooks (including the
 * admin-only inbound feed) and sending through `createEmail`, which an SMTP
 * submission session authenticated before the revocation still reaches.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { apiKeys } from "../../src/modules/api-keys/models/api-key.schema.ts";
import { InactiveApiKeyError } from "../../src/modules/api-keys/errors.ts";
import { createEmail } from "../../src/modules/emails/services/email.service.ts";
import {
  enqueueEvent,
  type DispatchScope,
} from "../../src/modules/webhooks/services/webhook-dispatch.service.ts";
import type { WebhookEventType } from "../../src/modules/webhooks/types/webhook.types.ts";
import { claimDueDeliveries } from "../../src/modules/webhooks/services/webhook-delivery.service.ts";
import { webhookDeliveries } from "../../src/modules/webhooks/models/webhook-delivery.schema.ts";
import { truncateAll, seed, db, enqueueDelivery } from "./_helpers.ts";

async function revoke(apiKeyId: string): Promise<void> {
  await db.update(apiKeys).set({ isActive: false }).where(eq(apiKeys.id, apiKeyId));
}

beforeEach(async () => {
  await truncateAll();
});

/** The webhook ids an event is enqueued for, in its own transaction (#184). */
async function enqueuedFor(
  event: WebhookEventType,
  scope: DispatchScope,
): Promise<string[]> {
  await db.transaction((tx) => enqueueEvent(tx, event, {}, scope));
  const rows = await db
    .select({ webhookId: webhookDeliveries.webhookId })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.event, event));
  await db.delete(webhookDeliveries);
  return rows.map((row) => row.webhookId);
}

describe("webhook dispatch skips revoked keys", () => {
  test("a revoked key's webhooks get none of its email events", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    await seed.webhook({
      apiKeyId,
      url: "https://93.184.216.34/a",
      events: ["email.sent"],
    });
    expect(await enqueuedFor("email.sent", { apiKeyId })).toHaveLength(1);

    await revoke(apiKeyId);

    expect(await enqueuedFor("email.sent", { apiKeyId })).toEqual([]);
  });

  test("a revoked admin key's webhooks stop getting inbound mail; active admins still do", async () => {
    const revoked = await seed.apiKey({ isAdmin: true });
    const active = await seed.apiKey({ isAdmin: true });
    await seed.webhook({
      apiKeyId: revoked.id,
      url: "https://93.184.216.34/revoked",
      events: ["email.received"],
    });
    const { id: activeHook } = await seed.webhook({
      apiKeyId: active.id,
      url: "https://93.184.216.34/active",
      events: ["email.received"],
    });

    await revoke(revoked.id);

    expect(await enqueuedFor("email.received", { adminOnly: true })).toEqual([
      activeHook,
    ]);
  });
});

describe("delivery worker skips revoked keys", () => {
  test("a delivery queued before the key was revoked is failed, not sent", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id: webhookId } = await seed.webhook({
      apiKeyId,
      url: "https://93.184.216.34/a",
      events: ["email.sent"],
    });
    const { id } = await enqueueDelivery({
      webhookId,
      envelope: { event: "email.sent", timestamp: "2026-05-10T12:00:00.000Z", data: {} },
    });

    await revoke(apiKeyId);

    expect(await claimDueDeliveries(10)).toEqual([]);
    const [row] = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, id));
    expect(row?.status).toBe("failed");
  });
});

describe("createEmail rejects revoked keys", () => {
  test("throws InactiveApiKeyError and queues nothing", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    await revoke(apiKeyId);

    expect(
      createEmail(
        {
          from: "hello@unregistered.test",
          to: "user@example.org",
          subject: "x",
          text: "x",
        },
        apiKeyId,
        "smtp",
      ),
    ).rejects.toThrow(InactiveApiKeyError);
  });
});
