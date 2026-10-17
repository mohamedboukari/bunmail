/**
 * Retry timing for temporarily failed outbound mail (#180).
 *
 * Receivers defer with 4xx replies and expect the sender to come back much
 * later: greylisting typically waits 5 to 15 minutes, and Yahoo, Microsoft
 * and Gmail rate limits last longer. RFC 5321 (4.5.4.1) suggests retry
 * intervals of 30 minutes or more and giving up after 4 to 5 days. Retrying
 * every few seconds turned these deferrals into permanent failures and kept
 * hammering throttled receivers.
 *
 * Pure: no I/O, so the schedule is unit-tested directly.
 */

/** Minutes to wait after the Nth attempt; the last value then repeats. */
export const RETRY_SCHEDULE_MINUTES = [5, 15, 30, 60, 120, 240] as const;

/**
 * How long to wait before retrying an email after a temporary failure, in
 * milliseconds, or `null` when the retry would make the email older than
 * `maxAgeMs` (it then fails for good). Ages come from the database clock.
 *
 * @param attempt - Attempts made so far, including the one that just failed (1-based)
 * @param ageMs - How long ago the email was queued
 * @param maxAgeMs - Oldest an email may get while still being retried
 */
export function nextRetryDelayMs(
  attempt: number,
  ageMs: number,
  maxAgeMs: number,
): number | null {
  const last = RETRY_SCHEDULE_MINUTES.length - 1;
  const minutes = RETRY_SCHEDULE_MINUTES[Math.min(Math.max(attempt, 1) - 1, last)] ?? 240;
  const delayMs = minutes * 60_000;
  return ageMs + delayMs > maxAgeMs ? null : delayMs;
}
