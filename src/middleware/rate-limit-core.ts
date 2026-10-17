/**
 * Pure per-API-key rate-limit logic for the HTTP API (#174).
 *
 * Kept separate from `rate-limit.ts` (the Elysia middleware + cleanup
 * timer) so unit tests can import the real algorithm. Several e2e tests
 * replace `rate-limit.ts` with a stub via `mock.module`, and those mocks
 * leak across files in a combined `bun test` run; nothing mocks this
 * module, so its tests always exercise the real code.
 */

/** Maximum number of requests allowed per window */
export const MAX_REQUESTS = 100;

/** Window duration in milliseconds (60 seconds) */
export const WINDOW_MS = 60_000;

/** Request count and window start for one API key. */
export interface RateLimitEntry {
  /** Number of requests made in the current window */
  count: number;
  /** Timestamp (ms) when the current window started */
  windowStart: number;
}

/**
 * Reads the authenticated API key ID from an Elysia request context.
 *
 * The auth middleware adds `apiKeyId` via `.resolve()`, but the rate-limit
 * plugin is its own Elysia instance and can't see that field statically.
 * A runtime check (rather than a cast) means a missing or non-string value
 * degrades to "unauthenticated" instead of being trusted as a key ID.
 *
 * @param context - The request context
 * @returns The API key ID, or undefined when auth didn't run
 */
export function readApiKeyId(context: unknown): string | undefined {
  return typeof context === "object" &&
    context !== null &&
    "apiKeyId" in context &&
    typeof context.apiKeyId === "string"
    ? context.apiKeyId
    : undefined;
}

/** Outcome of one request against the limit. */
export type RateLimitDecision =
  { limited: false } | { limited: true; count: number; retryAfter: number };

/**
 * Records one request for `key` and decides whether it's over the limit.
 *
 * Fixed window per key: the first request (or the first after the window
 * expires) starts a new window; each later request in the window
 * increments the count; request number MAX_REQUESTS + 1 onward is limited.
 *
 * @param map - Per-key state (mutated)
 * @param key - The API key ID
 * @param now - Current time in ms
 * @returns Whether the request is limited, with seconds until the window resets
 */
export function checkRateLimit(
  map: Map<string, RateLimitEntry>,
  key: string,
  now: number,
): RateLimitDecision {
  const entry = map.get(key);

  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    /** No entry or window expired: start a new window */
    map.set(key, { count: 1, windowStart: now });
    return { limited: false };
  }

  /** Increment the counter within the current window */
  entry.count += 1;

  if (entry.count > MAX_REQUESTS) {
    /** Seconds remaining in the current window */
    const retryAfter = Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000);
    return { limited: true, count: entry.count, retryAfter };
  }

  return { limited: false };
}

/**
 * Removes entries whose window has fully expired.
 *
 * @param map - Per-key state (mutated)
 * @param now - Current time in ms
 * @returns Number of entries removed
 */
export function pruneExpiredEntries(
  map: Map<string, RateLimitEntry>,
  now: number,
): number {
  let removed = 0;
  for (const [key, entry] of map) {
    if (now - entry.windowStart >= WINDOW_MS) {
      map.delete(key);
      removed += 1;
    }
  }
  return removed;
}
