/**
 * Webhook delivery worker (#30).
 *
 * The poll loop that drains the `webhook_deliveries` queue. Lives next
 * to the email queue worker (`emails/services/queue.service.ts`) and
 * mirrors its shape — `start` / `stop`, `setInterval` poll, atomic
 * claim under `FOR UPDATE SKIP LOCKED`, fire-and-forget per-row
 * processing inside the tick.
 *
 * Two periodic tasks:
 *   - **Poll** (every {@link POLL_INTERVAL_MS}) — claim the next batch
 *     of due rows, attempt POST for each, persist outcome.
 *   - **Cleanup** (every {@link CLEANUP_INTERVAL_MS}) — delete
 *     `delivered` rows older than `config.webhookDelivery.retentionDays`.
 *     `failed` rows kept indefinitely for forensics.
 *
 * The worker is concurrency-safe (multiple replicas safe by
 * construction — same SKIP LOCKED pattern as #20). Single-instance
 * today, but no race blocks horizontal scale.
 */

import {
  claimDueDeliveries,
  performHttpAttempt,
  recordAttempt,
  purgeOldDeliveries,
} from "./webhook-delivery.service.ts";
import { logger } from "../../../utils/logger.ts";
import { config } from "../../../config.ts";

/** How often the worker checks for due deliveries. 5s is a balance:
 *  fast enough that a freshly-enqueued event lands within the
 *  consumer's freshness window before the first signature timestamp
 *  ages, slow enough not to hammer Postgres on idle instances. */
const POLL_INTERVAL_MS = 5_000;

/** Max rows claimed per tick. Caps blast radius of a misbehaving
 *  consumer (a single hammered URL won't block the rest). With one
 *  attempt per row, 25 rows × 10s timeout = 4 minutes worst case
 *  before the next tick — still well inside the 5-min freshness
 *  window because most attempts return in milliseconds. */
const BATCH_SIZE = 25;

/** Cleanup task cadence. Delivered rows accumulate slowly; once an
 *  hour is plenty, and lighter on the box than scanning every tick. */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1h

let pollTimer: ReturnType<typeof setInterval> | null = null;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the worker. Idempotent — calling twice is a no-op.
 * No `recoverInterrupted`-style boot recovery is needed: durably-
 * stored `pending` rows are picked up by the very next poll without
 * any special-cased "left over from before reboot" handling. That's
 * the whole point of persistence.
 */
export function start(): void {
  if (pollTimer !== null) return;

  logger.info("Starting webhook delivery worker", {
    pollIntervalMs: POLL_INTERVAL_MS,
    batchSize: BATCH_SIZE,
    retentionDays: config.webhookDelivery.retentionDays,
  });

  pollTimer = setInterval(() => {
    void runPollCycle();
  }, POLL_INTERVAL_MS);

  cleanupTimer = setInterval(() => {
    void runCleanupCycle();
  }, CLEANUP_INTERVAL_MS);
}

/** Stops the worker. Called from the SIGINT/SIGTERM shutdown path. */
export function stop(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (cleanupTimer !== null) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  logger.info("Webhook delivery worker stopped");
}

/**
 * One poll tick: claim a batch of due rows and process them in
 * parallel. Errors at the row level don't kill the tick — `recordAttempt`
 * captures them — so one bad URL can't gate the rest.
 *
 * Exported for tests so they can drive a deterministic single-tick
 * loop without arming the setInterval.
 */
export async function runPollCycle(): Promise<{ claimed: number }> {
  let batch: Awaited<ReturnType<typeof claimDueDeliveries>>;
  try {
    batch = await claimDueDeliveries(BATCH_SIZE);
  } catch (err) {
    logger.error("Webhook worker: claim failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { claimed: 0 };
  }

  if (batch.length === 0) return { claimed: 0 };

  logger.debug("Webhook worker: processing batch", { count: batch.length });

  await Promise.allSettled(
    batch.map(async (row) => {
      const outcome = await performHttpAttempt({
        url: row.url,
        secret: row.secret,
        body: row.payload,
        event: row.event,
      });
      try {
        await recordAttempt({
          deliveryId: row.id,
          outcome,
          priorAttempts: row.attempts,
        });
      } catch (err) {
        /** A DB error here is bad — the row stays `pending` with the
         *  old `next_attempt_at`, so it'll be re-claimed on the next
         *  tick and we'll re-attempt. Log loud. */
        logger.error("Webhook worker: failed to persist attempt outcome", {
          deliveryId: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      if (outcome.ok) {
        logger.debug("Webhook delivered", {
          deliveryId: row.id,
          url: row.url,
          event: row.event,
          status: outcome.status,
        });
      } else {
        logger.warn("Webhook delivery attempt failed", {
          deliveryId: row.id,
          url: row.url,
          event: row.event,
          attempt: row.attempts + 1,
          httpStatus: outcome.status,
          error: outcome.error,
        });
      }
    }),
  );

  return { claimed: batch.length };
}

/** Deletes `delivered` rows older than the retention cutoff. */
export async function runCleanupCycle(): Promise<{ deleted: number }> {
  try {
    const cutoff = new Date(
      Date.now() - config.webhookDelivery.retentionDays * 24 * 60 * 60 * 1000,
    );
    const result = await purgeOldDeliveries({ olderThan: cutoff });
    if (result.deleted > 0) {
      logger.info("Webhook worker: purged old delivered rows", {
        deleted: result.deleted,
        retentionDays: config.webhookDelivery.retentionDays,
      });
    }
    return result;
  } catch (err) {
    logger.error("Webhook worker: cleanup failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { deleted: 0 };
  }
}
