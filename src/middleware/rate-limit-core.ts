/**
 * Pure per-API-key rate-limit logic for the HTTP API (#174).
 *
 * Kept separate from `rate-limit.ts` (the Elysia middleware + cleanup
 * timer) so unit tests can import the real algorithm. Several e2e tests
 * replace `rate-limit.ts` with a stub via `mock.module`, and those mocks
 * leak across files in a combined `bun test` run; nothing mocks this
 * module, so its tests always exercise the real code.
 */

/** Default maximum number of requests allowed per window */
export const MAX_REQUESTS = 100;

/** Default window duration in milliseconds (60 seconds) */
export const WINDOW_MS = 60_000;

/** The limit to enforce: `max` requests per `windowMs`. */
export interface RateLimitOptions {
  max: number;
  windowMs: number;
}

const DEFAULT_OPTIONS: RateLimitOptions = { max: MAX_REQUESTS, windowMs: WINDOW_MS };

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
 * expires) starts a new window; each later request in the window adds its
 * `weight`; a request that would take the count past `max` is limited.
 *
 * `weight` is how many sends the request is (#178): 1 for every route but
 * the batch send, which is one per email ({@link requestWeight}). A
 * limited request is refused whole and still counts once, so a client that
 * keeps retrying an over-budget batch is limited like any other.
 *
 * @param map - Per-key state (mutated)
 * @param key - The API key ID
 * @param now - Current time in ms
 * @param options - The limit (defaults to 100 requests per 60 s)
 * @param weight - Sends this request counts as (default 1)
 * @returns Whether the request is limited, with seconds until the window resets
 */
export function checkRateLimit(
  map: Map<string, RateLimitEntry>,
  key: string,
  now: number,
  options: RateLimitOptions = DEFAULT_OPTIONS,
  weight = 1,
): RateLimitDecision {
  const { max, windowMs } = options;
  let entry = map.get(key);

  if (!entry || now - entry.windowStart >= windowMs) {
    /** No entry or window expired: start a new window */
    entry = { count: 0, windowStart: now };
    map.set(key, entry);
  }

  if (entry.count + weight > max) {
    entry.count += 1;
    /** Seconds remaining in the current window */
    const retryAfter = Math.ceil((entry.windowStart + windowMs - now) / 1000);
    return { limited: true, count: entry.count, retryAfter };
  }

  entry.count += weight;
  return { limited: false };
}

/** The route whose one request is several sends (#178), as Elysia names it. */
export const BATCH_SEND_ROUTE = "/api/v1/emails/batch";

/**
 * How many sends a request counts as against the limit (#178): for
 * `POST /api/v1/emails/batch`, the number of emails in its (already
 * validated) body; 1 for every other request. Read at runtime, like
 * {@link readApiKeyId}, so an unexpected context degrades to 1.
 */
export function requestWeight(context: unknown): number {
  if (typeof context !== "object" || context === null) return 1;
  if (!("route" in context) || context.route !== BATCH_SEND_ROUTE) return 1;
  if (!("body" in context)) return 1;
  const { body } = context;
  if (typeof body !== "object" || body === null || !("emails" in body)) return 1;
  return Array.isArray(body.emails) ? Math.max(1, body.emails.length) : 1;
}

/**
 * Removes entries whose window has fully expired.
 *
 * @param map - Per-key state (mutated)
 * @param now - Current time in ms
 * @param windowMs - Window length (defaults to 60 s)
 * @returns Number of entries removed
 */
export function pruneExpiredEntries(
  map: Map<string, RateLimitEntry>,
  now: number,
  windowMs: number = WINDOW_MS,
): number {
  let removed = 0;
  for (const [key, entry] of map) {
    if (now - entry.windowStart >= windowMs) {
      map.delete(key);
      removed += 1;
    }
  }
  return removed;
}
