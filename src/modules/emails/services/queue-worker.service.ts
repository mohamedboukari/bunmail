import { sendMail } from "./mailer.service.ts";
import { logger } from "../../../utils/logger.ts";
import { runWithLogContext } from "../../../utils/log-context.ts";
import { withSpan } from "../../../utils/tracing.ts";
import { config } from "../../../config.ts";
import { sendAttemptDuration } from "../../metrics/services/metrics.service.ts";
import {
  claimNextEmails,
  LEASE_RENEW_MS,
  renewLease,
  WORKER_ID,
  type Claim,
  type ClaimedEmail,
} from "./queue-claim.service.ts";
import { sendClaimedEmail, type QueueDeps } from "./queue-send.service.ts";
import { metricSource } from "./queue-outcome.service.ts";

const defaultDeps: QueueDeps = { sendMail };

/** How many emails one cycle may claim, and how many may be in flight (#176). */
interface QueueLimits {
  batchSize: number;
  maxConcurrentSends: number;
}

/** The configured limits, read at use time (see {@link retryMaxAgeMs}). */
function configuredLimits(): QueueLimits {
  return {
    batchSize: config.mail.queueBatchSize,
    maxConcurrentSends: config.mail.queueMaxConcurrentSends,
  };
}

/** Sends this process has started and not yet finished (#176). */
let inFlight = 0;

/** True between `start()` and `stop()`. */
let running = false;

/** True while a poll runs; that poll schedules the next one when it ends. */
let polling = false;

/** The next scheduled poll, or `null` while a poll runs or once stopped. */
let pollTimer: ReturnType<typeof setTimeout> | null = null;

/** `ms` +/-10%, so several replicas don't poll the database in lockstep (#176). */
function withJitter(ms: number): number {
  return Math.round(ms * (0.9 + Math.random() * 0.2));
}

/**
 * Starts the queue processor: polls for due emails every
 * `QUEUE_POLL_INTERVAL_MS` (#176).
 *
 * Each poll is scheduled only after the previous one has claimed its
 * rows, so polls never overlap; sends run in the background, bounded by
 * `QUEUE_MAX_CONCURRENT_SENDS` (see {@link startQueueCycle}).
 *
 * There is no recovery step at boot (#180). Rows a crashed worker left in
 * `sending` are reclaimed by the normal claim once their lease expires.
 * The old boot step reset every `sending` row, including ones another
 * replica was still sending, which delivered those emails twice.
 */
export async function start(): Promise<void> {
  if (running) return;
  running = true;
  logger.info("Starting email queue processor", {
    pollIntervalMs: config.mail.queuePollIntervalMs,
    ...configuredLimits(),
    retryMaxAgeHours: config.mail.retryMaxAgeHours,
    workerId: WORKER_ID,
  });
  /** A poll still running from before a `stop()` reschedules itself. */
  if (!polling) schedulePoll();
}

/** Schedules the next poll, unless the queue was stopped. */
function schedulePoll(): void {
  if (!running) return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void poll();
  }, withJitter(config.mail.queuePollIntervalMs));
}

/** One poll: start the sends there is room for, then schedule the next poll. */
async function poll(): Promise<void> {
  polling = true;
  try {
    const sends = await startQueueCycle(defaultDeps, configuredLimits());
    /** Not awaited: the sends run in the background, and each one resolves, never rejects. */
    void Promise.all(sends);
  } catch (error: unknown) {
    logger.error("Queue processing error", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    polling = false;
    schedulePoll();
  }
}

/**
 * Stops the queue processor.
 *
 * Called during graceful shutdown (SIGINT/SIGTERM) to prevent
 * new emails from being picked up while the server is stopping.
 * Sends already in flight are not awaited: shutdown releases their
 * leases (`releaseOwnLeases`) so another worker picks them up.
 */
export function stop(): void {
  if (!running) return;
  running = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  logger.info("Email queue processor stopped", { inFlight });
}

/**
 * Single poll cycle, waiting for the sends it started: what the poll
 * loop does, plus the wait. Exported (with an injectable mailer and
 * limits) so tests can drive one cycle and inspect its outcome.
 */
export async function runQueueCycle(
  deps: QueueDeps = defaultDeps,
  limits: QueueLimits = configuredLimits(),
): Promise<void> {
  await Promise.all(await startQueueCycle(deps, limits));
}

/**
 * Claims as many due emails as there are free send slots and starts
 * sending them, without waiting for the sends (#176). Returns the sends
 * so a caller may wait for them; each one resolves, never rejects.
 *
 * Steps:
 * 1. Count the free slots: `maxConcurrentSends` minus the sends in
 *    flight. None free: claim nothing, so a slow receiver can only hold
 *    the slots it has, never grow the number of open connections.
 * 2. Atomically claim up to `min(batchSize, free)` rows (queued → sending
 *    in one statement, with `FOR UPDATE SKIP LOCKED` so concurrent
 *    workers can't claim the same row, see {@link claimNextEmails}).
 * 3. For each claimed row, in the background:
 *    a. Try SMTP delivery via the mailer service.
 *    b. On success: mark "sent" with timestamp.
 *    c. On failure: hard 5xx groups are auto-suppressed (#68); temporary
 *       failures are requeued with backoff until the email is older than
 *       `MAIL_RETRY_MAX_AGE_HOURS`, then marked "failed" (#180), with a
 *       24-hour soft suppression when the last reply was `4.2.2` (#250).
 */
async function startQueueCycle(
  deps: QueueDeps,
  limits: QueueLimits,
): Promise<Promise<void>[]> {
  const free = limits.maxConcurrentSends - inFlight;
  if (free <= 0) {
    logger.debug("Queue at its concurrency cap, claiming nothing", { inFlight });
    return [];
  }

  const batch = await claimNextEmails(Math.min(limits.batchSize, free));

  /** Nothing to process: skip silently */
  if (batch.length === 0) return [];

  logger.debug("Processing email batch", { count: batch.length, inFlight });

  /** Counted before any await, so the next poll sees these slots as taken. */
  return batch.map((email) => {
    inFlight++;
    return processEmail(email, deps)
      .catch((error: unknown) => {
        logger.error("Email send attempt crashed", {
          emailId: email.id,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        inFlight--;
      });
  });
}

/**
 * Processes a single email: marks it as sending, attempts SMTP delivery,
 * and updates the status based on the outcome.
 *
 * @param email - The queued email row to process
 */
async function processEmail(email: ClaimedEmail, deps: QueueDeps): Promise<void> {
  const claim: Claim = { emailId: email.id, attempt: email.attempts };
  /** Keep the lease alive for as long as this send takes. */
  const renewal = setInterval(() => {
    renewLease(claim)
      .then((held) => {
        if (!held) logger.warn("Lease lost while sending", { ...claim });
      })
      .catch((error: unknown) => {
        logger.error("Lease renewal failed", {
          ...claim,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, LEASE_RENEW_MS);
  /**
   * The attempt runs in its own log context (#284): every line it writes,
   * down to the mailer, DKIM and the webhooks it fires, carries the email
   * id and attempt number.
   */
  const startedAt = performance.now();
  try {
    /**
     * With tracing on (#363), each attempt is the root of its own trace:
     * the mailer's MX deliveries nest under it. The email id, attempt
     * number and source only, never an address.
     */
    await runWithLogContext({ job: "email-send", jobId: email.id }, () =>
      withSpan(
        "email.send_attempt",
        {
          root: true,
          attributes: {
            "bunmail.email.id": email.id,
            "bunmail.email.attempt": email.attempts,
            "bunmail.email.source": metricSource(email),
          },
        },
        () => sendClaimedEmail(email, claim, deps),
      ),
    );
  } finally {
    clearInterval(renewal);
    const elapsedMs = performance.now() - startedAt;
    logger.debug("Email send attempt finished", {
      emailId: email.id,
      attempt: email.attempts,
      durationMs: Math.round(elapsedMs),
    });
    sendAttemptDuration.observe({}, elapsedMs / 1000);
  }
}
