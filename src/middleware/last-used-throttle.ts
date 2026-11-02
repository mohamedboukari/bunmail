import { sharedWindowCounter } from "../utils/shared-store.ts";

/**
 * Minimum interval between `last_used_at` writes for the same API key.
 * Without this throttle a hot key under sustained load would fire one
 * `UPDATE` per request: pure write amplification with no observable
 * benefit (the timestamp is only used for "stale key" UX, not security).
 *
 * Trade-off: `last_used_at` can lag by up to this window. 60 seconds
 * is well below any human-relevant precision.
 */
const LAST_USED_THROTTLE_MS = 60_000;

/**
 * One claim per key and window, in the shared store (#185): a window
 * counter with a budget of one is "write at most once per window". In
 * Redis with `REDIS_URL`, so N replicas write once a minute per key, not
 * N times; else process memory. Every key expires with its window (the
 * sweep drops ended ones from memory), so keys used once, or deleted
 * since, do not stay in the map for good. During a Redis outage the
 * claims fall back to each replica's memory: at worst one extra write.
 */
const lastUsedCounter = sharedWindowCounter("throttle:last-used");

/**
 * The in-memory claims, keyed by API key id: the whole state without
 * Redis. Exported for tests; the middleware goes through the function
 * below.
 */
export const lastUsedClaimMap = lastUsedCounter.local.entries;

/**
 * True when this request should write `last_used_at` for `apiKeyId`: the
 * first use of the key in a window of {@link LAST_USED_THROTTLE_MS}, on
 * any replica. False for every later use in that window.
 */
export async function claimLastUsedWrite(apiKeyId: string): Promise<boolean> {
  const decision = await lastUsedCounter.take([apiKeyId], {
    max: 1,
    windowMs: LAST_USED_THROTTLE_MS,
  });
  return !decision.limited;
}
