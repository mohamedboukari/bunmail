import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { webhookDeliveries } from "../models/webhook-delivery.schema.ts";
import { webhooks } from "../models/webhook.schema.ts";
import { logger } from "../../../utils/logger.ts";
import { ReplayLimitReachedError } from "../errors.ts";
import { recordReplay, REPLAYS_PER_DELIVERY_PER_HOUR } from "./replay-limit.service.ts";

/* ─── Read-side queries ─── */

/**
 * Lists deliveries for a webhook, scoped by api key (the dashboard /
 * REST endpoint joins through `webhooks` for ownership).
 */
export async function listDeliveriesForWebhook(opts: {
  webhookId: string;
  apiKeyId: string;
  status?: "pending" | "delivered" | "failed";
  page: number;
  limit: number;
}): Promise<{ data: Array<typeof webhookDeliveries.$inferSelect>; total: number }> {
  /** Confirm the webhook belongs to this api key: defence in depth.
   *  The plugin layer already gates on the api key but we don't want
   *  this service to be a footgun if called from a different code
   *  path later. */
  const [hook] = await db
    .select({ id: webhooks.id })
    .from(webhooks)
    .where(and(eq(webhooks.id, opts.webhookId), eq(webhooks.apiKeyId, opts.apiKeyId)))
    .limit(1);
  if (!hook) return { data: [], total: 0 };

  const condition = opts.status
    ? and(
        eq(webhookDeliveries.webhookId, opts.webhookId),
        eq(webhookDeliveries.status, opts.status),
      )
    : eq(webhookDeliveries.webhookId, opts.webhookId);

  const offset = (opts.page - 1) * opts.limit;
  const [data, totalRows] = await Promise.all([
    db
      .select()
      .from(webhookDeliveries)
      .where(condition)
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(opts.limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(webhookDeliveries)
      .where(condition),
  ]);
  return { data, total: totalRows[0]?.count ?? 0 };
}

/**
 * Fetch a single delivery, scoped to the calling api key via the
 * parent webhook's ownership.
 */
export async function getDeliveryById(opts: {
  deliveryId: string;
  apiKeyId: string;
}): Promise<typeof webhookDeliveries.$inferSelect | undefined> {
  const [row] = await db
    .select({ delivery: webhookDeliveries })
    .from(webhookDeliveries)
    .innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhookId))
    .where(
      and(
        eq(webhookDeliveries.id, opts.deliveryId),
        eq(webhooks.apiKeyId, opts.apiKeyId),
      ),
    )
    .limit(1);
  return row?.delivery;
}

/* ─── Replay ─── */

/**
 * Flips a delivery row back to `pending` and resets `nextAttemptAt` to
 * now so the worker picks it up on the next poll. Used by operators
 * to manually retry a `failed` (or stuck) row.
 *
 * Resets `attempts` to 0: the operator is starting a fresh retry
 * cycle, not continuing the old one. Otherwise replay of a 5x-failed
 * row would immediately re-flip to `failed` after one more attempt.
 *
 * At most `REPLAYS_PER_DELIVERY_PER_HOUR` (5) replays per delivery per
 * hour (#258): one more throws `ReplayLimitReachedError` (429).
 *
 * Returns `undefined` if the delivery doesn't exist or doesn't belong
 * to the calling api key.
 */
export async function replayDelivery(opts: {
  deliveryId: string;
  apiKeyId: string;
  now?: Date;
}): Promise<typeof webhookDeliveries.$inferSelect | undefined> {
  const now = opts.now ?? new Date();
  /** Ownership check via the parent webhook. */
  const existing = await getDeliveryById(opts);
  if (!existing) return undefined;

  /**
   * Replay budget (#258), counted only once ownership is proven: a key
   * that guesses another key's delivery id can neither use up its budget
   * nor learn from a 429 that the id exists.
   */
  const decision = recordReplay(existing.id, now.getTime());
  if (decision.limited) {
    logger.warn("Webhook delivery replay refused: replay limit reached", {
      deliveryId: existing.id,
      webhookId: existing.webhookId,
      limit: REPLAYS_PER_DELIVERY_PER_HOUR,
      retryAfterSec: decision.retryAfterSec,
    });
    throw new ReplayLimitReachedError(
      REPLAYS_PER_DELIVERY_PER_HOUR,
      decision.retryAfterSec,
    );
  }

  const [updated] = await db
    .update(webhookDeliveries)
    .set({
      status: "pending",
      attempts: 0,
      lastError: null,
      lastResponseStatus: null,
      lastResponseBody: null,
      deliveredAt: null,
      /**
       * Use Postgres NOW() rather than the JS `now` so the row is
       * immediately due by the worker's DB-clock comparison even when
       * Node's clock is slightly ahead of PG's. Otherwise replay can
       * queue a row that's briefly invisible to the worker until the
       * next poll cycle catches up.
       */
      nextAttemptAt: sql`NOW()`,
      updatedAt: now,
    })
    .where(eq(webhookDeliveries.id, opts.deliveryId))
    .returning();
  return updated;
}
