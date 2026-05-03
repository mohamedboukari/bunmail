import { Elysia } from "elysia";
import { logger } from "../utils/logger.ts";

/** Maximum number of requests allowed per window */
const MAX_REQUESTS = 100;

/** Window duration in milliseconds (60 seconds) */
const WINDOW_MS = 60_000;

/** How often the cleanup loop sweeps expired entries from the map. */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Tracks request counts per API key within a sliding time window.
 * Key: API key ID, Value: request count and window start timestamp.
 *
 * Resets on server restart — acceptable for MVP. A production system
 * would use Redis or a shared store for multi-instance deployments.
 */
interface RateLimitEntry {
  /** Number of requests made in the current window */
  count: number;
  /** Timestamp (ms) when the current window started */
  windowStart: number;
}

export const rateLimitMap = new Map<string, RateLimitEntry>();

/** Reference to the periodic cleanup timer; null when not running. */
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Removes entries whose window has fully expired.
 * Exported for unit testing — the running server uses the interval below.
 */
export function pruneExpiredEntries(now: number = Date.now()): number {
  let removed = 0;
  for (const [key, entry] of rateLimitMap) {
    if (now - entry.windowStart >= WINDOW_MS) {
      rateLimitMap.delete(key);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Starts a periodic sweep that drops expired entries from the in-memory
 * rate-limit map. Without this, distinct API keys arriving over a long
 * lifetime would grow the map unbounded.
 *
 * Idempotent — calling twice is a no-op while the interval is running.
 * Mirrors the SMTP receiver's rate-limit cleanup pattern.
 */
export function startRateLimitCleanup(): void {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => pruneExpiredEntries(), CLEANUP_INTERVAL_MS);
  logger.debug("HTTP rate-limit cleanup started", {
    intervalMs: CLEANUP_INTERVAL_MS,
  });
}

/** Stops the periodic sweep — called from the graceful shutdown handler. */
export function stopRateLimitCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    logger.debug("HTTP rate-limit cleanup stopped");
  }
}

/**
 * Rate-limit middleware — enforces per-API-key request limits.
 *
 * Sliding window algorithm:
 * 1. Look up the API key's current window in the in-memory map
 * 2. If the window has expired, reset the counter
 * 3. Increment the counter
 * 4. If over the limit, return 429 with Retry-After header
 *
 * Must be applied AFTER authMiddleware (needs `apiKeyId` in context).
 */
export const rateLimitMiddleware = new Elysia({
  name: "rate-limit-middleware",
}).onBeforeHandle((context) => {
  /**
   * Read `apiKeyId` from the derived auth context.
   *
   * The auth middleware adds `apiKeyId` via `.resolve()`, but this
   * plugin is its own `Elysia` instance — it doesn't statically know
   * about the auth middleware's context, so TypeScript can't see the
   * field. The read is order-dependent: every plugin that uses the
   * rate-limiter calls `.use(authMiddleware).use(rateLimitMiddleware)`
   * so by the time this hook fires, `apiKeyId` is already in the
   * context if auth ran. The narrow `{ apiKeyId?: string }` cast is
   * preferred over `Record<string, unknown>` because it expresses
   * exactly the shape we read — anything else would be a real bug.
   */
  const { apiKeyId } = context as { apiKeyId?: string };

  /**
   * If no apiKeyId is present, auth middleware hasn't run or the route
   * is unprotected — skip rate limiting silently.
   */
  if (!apiKeyId) {
    return;
  }

  const { set } = context;

  const now = Date.now();
  const entry = rateLimitMap.get(apiKeyId);

  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    /** No entry or window expired — start a new window */
    rateLimitMap.set(apiKeyId, { count: 1, windowStart: now });
    return;
  }

  /** Increment the counter within the current window */
  entry.count += 1;

  /** Check if the limit has been exceeded */
  if (entry.count > MAX_REQUESTS) {
    /** Calculate seconds remaining in the current window */
    const retryAfter = Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000);

    logger.warn("Rate limit exceeded", {
      apiKeyId,
      count: entry.count,
      retryAfter,
    });

    set.status = 429;
    set.headers["retry-after"] = String(retryAfter);

    return {
      success: false,
      error: "Rate limit exceeded — try again later",
      retryAfter,
    };
  }
});
