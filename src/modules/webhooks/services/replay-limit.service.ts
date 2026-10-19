import {
  checkRateLimit,
  pruneExpiredEntries,
  type RateLimitEntry,
} from "../../../middleware/rate-limit-core.ts";

/**
 * Replay budget per webhook delivery (#258): a replay resets a delivery to
 * `pending` with a fresh attempt budget, so unlimited replays would let a
 * key loop up to five POSTs per replay at any receiver it registered.
 */
export const REPLAYS_PER_DELIVERY_PER_HOUR = 5;

/** Length of the replay window: one hour, fixed from the first replay in it. */
const REPLAY_WINDOW_MS = 60 * 60 * 1000;

/**
 * Replays per delivery id in the current window. In memory and per
 * replica, like the API and login limiters: it resets on restart, and
 * each replica keeps its own count (#185).
 */
const replays = new Map<string, RateLimitEntry>();

/** Outcome of one replay against the budget. */
export type ReplayDecision =
  { limited: false } | { limited: true; retryAfterSec: number };

/**
 * Counts one replay of `deliveryId` and decides whether it is over the
 * budget, with the shared fixed-window primitive of the API limiter.
 * Expired windows are pruned on each call (replays are rare, the map
 * stays small).
 *
 * @param deliveryId - The delivery being replayed (already ownership-checked)
 * @param now - Current time in ms
 */
export function recordReplay(deliveryId: string, now: number): ReplayDecision {
  pruneExpiredEntries(replays, now, REPLAY_WINDOW_MS);
  const decision = checkRateLimit(replays, deliveryId, now, {
    max: REPLAYS_PER_DELIVERY_PER_HOUR,
    windowMs: REPLAY_WINDOW_MS,
  });
  return decision.limited
    ? { limited: true, retryAfterSec: decision.retryAfter }
    : { limited: false };
}
