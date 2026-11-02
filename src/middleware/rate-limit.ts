import { Elysia } from "elysia";
import { config } from "../config.ts";
import { logger } from "../utils/logger.ts";
import { sharedWindowCounter } from "../utils/shared-store.ts";
import { readApiKeyId, requestWeight, type RateLimitOptions } from "./rate-limit-core.ts";

/** The enforced limit, from `API_RATE_LIMIT_MAX` / `API_RATE_LIMIT_WINDOW`. */
const limit: RateLimitOptions = {
  max: config.apiRateLimit.max,
  windowMs: config.apiRateLimit.windowSec * 1000,
};

/** How often the cleanup loop sweeps expired entries from the map. */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Request counts per API key in fixed windows (#185): in Redis when
 * `REDIS_URL` is set, so every replica shares one budget per key; else
 * (and while Redis is down) in this process's memory, reset by a restart.
 */
const apiCounter = sharedWindowCounter("rl:api");

/** Reference to the periodic cleanup timer; null when not running. */
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Starts a periodic sweep that drops expired entries from the in-memory
 * counters (the default store, and the fallback while Redis is down).
 * Without this, distinct API keys arriving over a long lifetime would
 * grow the map unbounded; Redis expires its keys on its own.
 *
 * Idempotent: calling twice is a no-op while the interval is running.
 * Mirrors the SMTP receiver's rate-limit cleanup pattern.
 */
export function startRateLimitCleanup(): void {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => apiCounter.local.prune(), CLEANUP_INTERVAL_MS);
  logger.debug("HTTP rate-limit cleanup started", {
    intervalMs: CLEANUP_INTERVAL_MS,
  });
}

/** Stops the periodic sweep: called from the graceful shutdown handler. */
export function stopRateLimitCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    logger.debug("HTTP rate-limit cleanup stopped");
  }
}

/**
 * Rate-limit middleware: enforces per-API-key request limits.
 *
 * Fixed window algorithm, one atomic step in the shared counter:
 * 1. A key without a live window starts one
 * 2. Add the request's weight: 1, or one per email for a batch send (#178)
 * 3. If that would pass the limit, count the refused request once and
 *    return 429 with Retry-After header, before the handler runs, so an
 *    over-budget batch creates nothing
 *
 * Must be applied AFTER authMiddleware (needs `apiKeyId` in context).
 * The limit comes from `config.apiRateLimit` (default 100 per 60 s).
 */
export const rateLimitMiddleware = new Elysia({
  name: "rate-limit-middleware",
})
  .onBeforeHandle(async (context) => {
    /** Every plugin applies `.use(authMiddleware).use(rateLimitMiddleware)`, so
     *  `apiKeyId` is in the context by now if auth ran. See readApiKeyId. */
    const apiKeyId = readApiKeyId(context);

    /**
     * If no apiKeyId is present, auth middleware hasn't run or the route
     * is unprotected: skip rate limiting silently.
     */
    if (!apiKeyId) {
      return;
    }

    const { set } = context;

    /** A batch send counts as one send per email (#178). */
    const weight = requestWeight(context);
    const decision = await apiCounter.take([apiKeyId], {
      max: limit.max,
      windowMs: limit.windowMs,
      weight,
      refusedWeight: 1,
    });
    if (!decision.limited) return;

    const { count } = decision;
    /** Whole seconds left in the window, rounded up. */
    const retryAfter = Math.ceil(decision.retryAfterMs / 1000);
    logger.warn("Rate limit exceeded", { apiKeyId, count, weight, retryAfter });

    set.status = 429;
    set.headers["retry-after"] = String(retryAfter);

    return {
      success: false,
      error: "Rate limit exceeded: try again later",
      retryAfter,
    };
  })
  /**
   * Without `scoped`, Elysia keeps this hook local to this instance, so it
   * never ran for the routes of the plugins that `.use()` it. Scoped
   * applies it to the parent plugin's routes, like `authMiddleware`.
   */
  .as("scoped");
