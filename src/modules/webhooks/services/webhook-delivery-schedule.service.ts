/**
 * Backoff schedule per the issue's acceptance criteria. The value at
 * index `i` is the wait between attempt `i` (just-failed) and
 * attempt `i+1`. So a row with `attempts == 1` that just failed waits
 * 5 minutes before it's eligible for the next claim.
 *
 *   attempts=1 just-failed → wait 1m  (overall: 1m)
 *   attempts=2 just-failed → wait 5m  (overall: 6m)
 *   attempts=3 just-failed → wait 15m (overall: 21m)
 *   attempts=4 just-failed → wait 1h  (overall: 1h21m)
 *   attempts=5 just-failed → row flips to `failed`, no further attempts
 *
 * Tuned for the realistic consumer-outage profile: a brief deploy
 * (recovers within minutes) gets one or two retries; an extended
 * outage gets about 80 minutes of cover before we stop trying.
 */
export const RETRY_BACKOFF_MINUTES = [1, 5, 15, 60] as const;
export const MAX_DELIVERY_ATTEMPTS = RETRY_BACKOFF_MINUTES.length + 1; // 5

/**
 * Computes the next attempt timestamp after a failed attempt. Returns
 * `null` if `attempts` has reached the cap, signalling the caller
 * should mark the row `failed`.
 */
export function nextAttemptAt(attempts: number, now: Date = new Date()): Date | null {
  /** `attempts` is the count *after* the most-recent failure has been
   *  recorded, so attempts=1 means one attempt made, schedule wait
   *  according to RETRY_BACKOFF_MINUTES[0]. */
  const idx = attempts - 1;
  if (idx < 0 || idx >= RETRY_BACKOFF_MINUTES.length) return null;
  const minutes = RETRY_BACKOFF_MINUTES[idx]!;
  return new Date(now.getTime() + minutes * 60_000);
}
