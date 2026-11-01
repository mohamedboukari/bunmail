/**
 * The queue gauges of `GET /metrics` (#362), against a real Postgres:
 * only live (not trashed) `queued` and `sending` rows count, and the
 * overdue age measures `next_attempt_at`, not the email's age, so a
 * scheduled retry is not mistaken for a stuck queue.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import {
  readQueueSnapshot,
  readSuppressionCounts,
  readWebhookBacklog,
} from "../../src/modules/metrics/services/db-gauges.service.ts";
import { webhookDeliveries } from "../../src/modules/webhooks/models/webhook-delivery.schema.ts";
import { suppressions } from "../../src/modules/suppressions/models/suppression.schema.ts";
import { generateId } from "../../src/utils/id.ts";
import { truncateAll, seed, db, emails, enqueueDelivery } from "./_helpers.ts";

beforeEach(async () => {
  await truncateAll();
});

/** `minutes` minutes from now (negative: in the past). */
function inMinutes(minutes: number): Date {
  return new Date(Date.now() + minutes * 60_000);
}

describe("readQueueSnapshot", () => {
  test("an empty queue is all zeros", async () => {
    expect(await readQueueSnapshot()).toEqual({
      queued: 0,
      sending: 0,
      due: 0,
      oldestDueAgeSeconds: 0,
    });
  });

  test("counts live queued and sending rows; the overdue age follows next_attempt_at", async () => {
    const apiKey = await seed.apiKey();
    const overdue = await seed.email({ apiKeyId: apiKey.id, status: "queued" });
    const dueNow = await seed.email({ apiKeyId: apiKey.id, status: "queued" });
    const retryLater = await seed.email({ apiKeyId: apiKey.id, status: "queued" });
    await seed.email({ apiKeyId: apiKey.id, status: "sending" });
    await seed.email({ apiKeyId: apiKey.id, status: "sent" });
    await seed.email({ apiKeyId: apiKey.id, status: "failed" });
    const trashed = await seed.email({ apiKeyId: apiKey.id, status: "queued" });

    await db
      .update(emails)
      .set({ nextAttemptAt: inMinutes(-10) })
      .where(eq(emails.id, overdue.id));
    await db
      .update(emails)
      .set({ nextAttemptAt: inMinutes(-1) })
      .where(eq(emails.id, dueNow.id));
    await db
      .update(emails)
      .set({ nextAttemptAt: inMinutes(30) })
      .where(eq(emails.id, retryLater.id));
    await db
      .update(emails)
      .set({ deletedAt: new Date(), nextAttemptAt: inMinutes(-60) })
      .where(eq(emails.id, trashed.id));

    const snapshot = await readQueueSnapshot();
    expect(snapshot.queued).toBe(3);
    expect(snapshot.sending).toBe(1);
    expect(snapshot.due).toBe(2);
    /** The overdue email, not the trashed one an hour overdue. */
    expect(snapshot.oldestDueAgeSeconds).toBeGreaterThan(9 * 60);
    expect(snapshot.oldestDueAgeSeconds).toBeLessThan(11 * 60);
  });
});

describe("readWebhookBacklog", () => {
  test("counts pending deliveries; due only those whose next attempt has passed", async () => {
    const apiKey = await seed.apiKey();
    const webhook = await seed.webhook({
      apiKeyId: apiKey.id,
      url: "https://hooks.example.com/x",
      events: ["email.sent"],
    });
    const envelope = {
      event: "email.sent",
      timestamp: new Date().toISOString(),
      data: {},
    };
    const due = await enqueueDelivery({ webhookId: webhook.id, envelope });
    const later = await enqueueDelivery({ webhookId: webhook.id, envelope });
    const done = await enqueueDelivery({ webhookId: webhook.id, envelope });
    await db
      .update(webhookDeliveries)
      .set({ nextAttemptAt: inMinutes(-2) })
      .where(eq(webhookDeliveries.id, due.id));
    await db
      .update(webhookDeliveries)
      .set({ nextAttemptAt: inMinutes(15) })
      .where(eq(webhookDeliveries.id, later.id));
    await db
      .update(webhookDeliveries)
      .set({ status: "delivered" })
      .where(eq(webhookDeliveries.id, done.id));

    expect(await readWebhookBacklog()).toEqual({ pending: 2, due: 1 });
  });
});

describe("readSuppressionCounts", () => {
  test("active suppressions by reason; expired ones out, an unknown reason as other", async () => {
    const apiKey = await seed.apiKey();
    await seed.suppression({
      apiKeyId: apiKey.id,
      email: "a@example.org",
      reason: "bounce",
    });
    await seed.suppression({
      apiKeyId: apiKey.id,
      email: "b@example.org",
      reason: "bounce",
    });
    await seed.suppression({
      apiKeyId: apiKey.id,
      email: "c@example.org",
      reason: "complaint",
    });
    await seed.suppression({
      apiKeyId: apiKey.id,
      email: "d@example.org",
      reason: "bounce",
      bounceType: "soft",
      expiresAt: inMinutes(60),
    });
    await seed.suppression({
      apiKeyId: apiKey.id,
      email: "e@example.org",
      reason: "manual",
      expiresAt: inMinutes(-60),
    });
    /** The column is free text: a reason a newer version wrote, or a manual edit. */
    await db.insert(suppressions).values({
      id: generateId("sup"),
      apiKeyId: apiKey.id,
      email: "f@example.org",
      reason: "legacy-import",
    });

    const counts = await readSuppressionCounts();
    const byReason = Object.fromEntries(
      counts.map(({ reason, count }) => [reason, count]),
    );
    expect(byReason).toEqual({ bounce: 3, complaint: 1, other: 1 });
  });
});
