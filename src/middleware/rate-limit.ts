import { Elysia } from "elysia";
import { logger } from "../utils/logger.ts";

/** Maximum number of requests allowed per window */
const MAX_REQUESTS = 100;

/** Window duration in milliseconds (60 seconds) */
const WINDOW_MS = 60_000;

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

const rateLimitMap = new Map<string, RateLimitEntry>();

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
   * Read apiKeyId from the derived auth context.
   * The auth middleware uses `derive()` which adds apiKeyId directly
   * to the request context. Cast needed because Elysia can't infer
   * cross-plugin derive types in a standalone middleware.
   */
  const apiKeyId = (context as Record<string, unknown>)["apiKeyId"] as string | undefined;

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
