/**
 * Webhook delivery worker (#30).
 *
 * The poll loop that drains the `webhook_deliveries` queue. Lives next
 * to the email queue worker (`emails/services/queue.service.ts`) and
 * mirrors its shape: `start` / `stop`, `setInterval` poll, atomic
 * claim under `FOR UPDATE SKIP LOCKED`, fire-and-forget per-row
 * processing inside the tick.
 *
 * Two periodic tasks:
 *   - **Poll** (every {@link POLL_INTERVAL_MS}): claim the next batch
 *     of due rows, attempt POST for each, persist outcome.
 *   - **Cleanup** (every {@link CLEANUP_INTERVAL_MS}): delete finished
 *     rows (`delivered` and `failed`) whose last change is older than
 *     `config.webhookDelivery.retentionDays` (#258), in batches.
 *
 * The worker is concurrency-safe (multiple replicas safe by
 * construction: same SKIP LOCKED pattern as #20). Single-instance
 * today, but no race blocks horizontal scale.
 */

import {
  claimDueDeliveries,
  performHttpAttempt,
  recordAttempt,
  purgeOldDeliveries,
} from "./webhook-delivery.service.ts";
import { logger } from "../../../utils/logger.ts";
import { runWithLogContext } from "../../../utils/log-context.ts";
import { redactUrl } from "../../../utils/redact.ts";
import { config } from "../../../config.ts";

/** How often the worker checks for due deliveries. 5s is a balance:
 *  fast enough that a freshly-enqueued event lands within the
 *  consumer's freshness window before the first signature timestamp
 *  ages, slow enough not to hammer Postgres on idle instances. */
const POLL_INTERVAL_MS = 5_000;

/** Max rows claimed per tick. Caps blast radius of a misbehaving
 *  consumer (a single hammered URL won't block the rest). With one
 *  attempt per row and the batch sent in parallel, the next tick waits
 *  for at most one 10s timeout (#176): well inside the 5-min freshness
 *  window, and most attempts return in milliseconds. */
const BATCH_SIZE = 25;

/** Cleanup task cadence. Delivered rows accumulate slowly; once an
 *  hour is plenty, and lighter on the box than scanning every tick. */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1h

/** True between `start()` and `stop()`. */
let running = false;
/** True while a poll runs; that poll schedules the next one when it ends. */
let polling = false;
/** The next scheduled poll, or `null` while a poll runs or once stopped. */
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/** `ms` +/-10%, so several replicas don't poll the database in lockstep (#176). */
function withJitter(ms: number): number {
  return Math.round(ms * (0.9 + Math.random() * 0.2));
}

/**
 * Starts the worker. Idempotent: calling twice is a no-op.
 * No `recoverInterrupted`-style boot recovery is needed: durably-
 * stored `pending` rows are picked up by the very next poll without
 * any special-cased "left over from before reboot" handling. That's
 * the whole point of persistence.
 *
 * Each poll is scheduled once the previous one has finished its batch
 * (#176), so polls never overlap: a batch of slow receivers delays the
 * next poll instead of stacking another 25 requests on top of it.
 */
export function start(): void {
  if (running) return;
  running = true;

  logger.info("Starting webhook delivery worker", {
    pollIntervalMs: POLL_INTERVAL_MS,
    batchSize: BATCH_SIZE,
    retentionDays: config.webhookDelivery.retentionDays,
  });

  /** A poll still running from before a `stop()` reschedules itself. */
  if (!polling) schedulePoll();

  cleanupTimer = setInterval(() => {
    void runCleanupCycle();
  }, CLEANUP_INTERVAL_MS);
}

/** Schedules the next poll, unless the worker was stopped. */
function schedulePoll(): void {
  if (!running) return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    polling = true;
    void runPollCycle().finally(() => {
      polling = false;
      schedulePoll();
    });
  }, withJitter(POLL_INTERVAL_MS));
}

/** Stops the worker. Called from the SIGINT/SIGTERM shutdown path. */
export function stop(): void {
  running = false;
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
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
 * parallel. Errors at the row level don't kill the tick: `recordAttempt`
 * captures them, so one bad URL can't gate the rest.
 *
 * Exported for tests so they can drive a deterministic single-tick
 * loop without arming the poll timer.
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
    batch.map(async (row) =>
      runWithLogContext({ job: "webhook-delivery", jobId: row.id }, async () => {
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
          /** A DB error here is bad: the row stays `pending` with the
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
            url: redactUrl(row.url),
            event: row.event,
            status: outcome.status,
          });
        } else {
          logger.warn("Webhook delivery attempt failed", {
            deliveryId: row.id,
            url: redactUrl(row.url),
            event: row.event,
            attempt: row.attempts + 1,
            httpStatus: outcome.status,
            error: outcome.error,
          });
        }
      }),
    ),
  );

  return { claimed: batch.length };
}

/**
 * Deletes finished deliveries older than the retention cutoff (#258), in
 * its own log context so every line carries `job: "webhook-delivery-cleanup"`.
 * Logs the outcome once when anything was deleted; a failure is logged
 * and swallowed, the next hourly pass tries again.
 */
export function runCleanupCycle(): Promise<{ deleted: number }> {
  return runWithLogContext({ job: "webhook-delivery-cleanup" }, async () => {
    const { retentionDays } = config.webhookDelivery;
    const startedAt = Date.now();
    try {
      const cutoff = new Date(startedAt - retentionDays * 24 * 60 * 60 * 1000);
      const result = await purgeOldDeliveries({ olderThan: cutoff });
      if (result.deleted > 0) {
        logger.info("Webhook worker: purged finished deliveries", {
          deleted: result.deleted,
          retentionDays,
          durationMs: Date.now() - startedAt,
        });
      }
      return result;
    } catch (err) {
      /** The logger strips a drizzle error's query parameters (#260). */
      logger.error("Webhook worker: cleanup failed", {
        retentionDays,
        error: err instanceof Error ? err.message : String(err),
      });
      return { deleted: 0 };
    }
  });
}
