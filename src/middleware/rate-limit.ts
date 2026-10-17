import { Elysia } from "elysia";
import { config } from "../config.ts";
import { logger } from "../utils/logger.ts";
import {
  checkRateLimit,
  pruneExpiredEntries,
  readApiKeyId,
  type RateLimitEntry,
  type RateLimitOptions,
} from "./rate-limit-core.ts";

/** The enforced limit, from `API_RATE_LIMIT_MAX` / `API_RATE_LIMIT_WINDOW`. */
const limit: RateLimitOptions = {
  max: config.apiRateLimit.max,
  windowMs: config.apiRateLimit.windowSec * 1000,
};

/** How often the cleanup loop sweeps expired entries from the map. */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Tracks request counts per API key within a time window. The algorithm
 * lives in `rate-limit-core.ts` (pure, unit-tested); this module owns the
 * state, the cleanup timer and the Elysia wiring.
 *
 * Resets on server restart: acceptable for MVP. A production system
 * would use Redis or a shared store for multi-instance deployments.
 */
const rateLimitMap = new Map<string, RateLimitEntry>();

/** Reference to the periodic cleanup timer; null when not running. */
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Starts a periodic sweep that drops expired entries from the in-memory
 * rate-limit map. Without this, distinct API keys arriving over a long
 * lifetime would grow the map unbounded.
 *
 * Idempotent: calling twice is a no-op while the interval is running.
 * Mirrors the SMTP receiver's rate-limit cleanup pattern.
 */
export function startRateLimitCleanup(): void {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(
    () => pruneExpiredEntries(rateLimitMap, Date.now(), limit.windowMs),
    CLEANUP_INTERVAL_MS,
  );
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
 * Sliding window algorithm:
 * 1. Look up the API key's current window in the in-memory map
 * 2. If the window has expired, reset the counter
 * 3. Increment the counter
 * 4. If over the limit, return 429 with Retry-After header
 *
 * Must be applied AFTER authMiddleware (needs `apiKeyId` in context).
 * The limit comes from `config.apiRateLimit` (default 100 per 60 s).
 */
export const rateLimitMiddleware = new Elysia({
  name: "rate-limit-middleware",
})
  .onBeforeHandle((context) => {
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

    const decision = checkRateLimit(rateLimitMap, apiKeyId, Date.now(), limit);
    if (!decision.limited) return;

    const { count, retryAfter } = decision;
    logger.warn("Rate limit exceeded", { apiKeyId, count, retryAfter });

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
