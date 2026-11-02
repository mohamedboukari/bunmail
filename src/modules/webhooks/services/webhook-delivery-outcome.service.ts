import { eq } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { webhookDeliveries } from "../models/webhook-delivery.schema.ts";
import { recordWebhookAttempt } from "../../metrics/services/metrics.service.ts";
import { nextAttemptAt } from "./webhook-delivery-schedule.service.ts";
import {
  RESPONSE_PREVIEW_LIMIT,
  type AttemptOutcome,
} from "./webhook-delivery-attempt.service.ts";

/**
 * Persists the outcome of one attempt to the delivery row. On success
 * the row is terminal (`delivered`). On failure, either reschedule via
 * `nextAttemptAt(attempts)` or terminate at `failed` if the cap has
 * been reached.
 */
export async function recordAttempt(opts: {
  deliveryId: string;
  outcome: AttemptOutcome;
  priorAttempts: number;
  now?: Date;
}): Promise<void> {
  const now = opts.now ?? new Date();
  const newAttempts = opts.priorAttempts + 1;

  if (opts.outcome.ok) {
    await db
      .update(webhookDeliveries)
      .set({
        status: "delivered",
        attempts: newAttempts,
        lastError: null,
        lastResponseStatus: opts.outcome.status,
        lastResponseBody: opts.outcome.bodyPreview
          ? { bodyPreview: opts.outcome.bodyPreview }
          : null,
        deliveredAt: now,
        updatedAt: now,
      })
      .where(eq(webhookDeliveries.id, opts.deliveryId));
    recordWebhookAttempt("delivered");
    return;
  }

  const next = nextAttemptAt(newAttempts, now);
  if (next === null) {
    /** Cap reached: terminal failure. */
    await db
      .update(webhookDeliveries)
      .set({
        status: "failed",
        attempts: newAttempts,
        lastError: opts.outcome.error?.slice(0, RESPONSE_PREVIEW_LIMIT) ?? "unknown",
        lastResponseStatus: opts.outcome.status,
        lastResponseBody: opts.outcome.bodyPreview
          ? { bodyPreview: opts.outcome.bodyPreview }
          : null,
        updatedAt: now,
      })
      .where(eq(webhookDeliveries.id, opts.deliveryId));
    recordWebhookAttempt("failed");
    return;
  }

  await db
    .update(webhookDeliveries)
    .set({
      attempts: newAttempts,
      lastError: opts.outcome.error?.slice(0, RESPONSE_PREVIEW_LIMIT) ?? "unknown",
      lastResponseStatus: opts.outcome.status,
      lastResponseBody: opts.outcome.bodyPreview
        ? { bodyPreview: opts.outcome.bodyPreview }
        : null,
      nextAttemptAt: next,
      updatedAt: now,
    })
    .where(eq(webhookDeliveries.id, opts.deliveryId));
  recordWebhookAttempt("retry");
}
