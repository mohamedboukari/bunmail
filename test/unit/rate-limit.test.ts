import { describe, test, expect } from "bun:test";

/**
 * Unit tests for the rate-limit algorithm.
 *
 * Tests the sliding-window per-key rate limiting logic extracted from
 * src/middleware/rate-limit.ts. Testing the algorithm directly avoids
 * Elysia plugin scoping complexities while verifying the core behavior.
 */

const MAX_REQUESTS = 100;
const WINDOW_MS = 60_000;

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

/**
 * Evaluates a rate-limit check for the given API key.
 * Returns `null` if allowed, or `{ retryAfter }` if rate-limited.
 * Mirrors the logic in rateLimitMiddleware.onBeforeHandle.
 */
function checkRateLimit(
  map: Map<string, RateLimitEntry>,
  apiKeyId: string | undefined,
  now: number,
): { retryAfter: number } | null {
  if (!apiKeyId) return null;

  const entry = map.get(apiKeyId);

  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    map.set(apiKeyId, { count: 1, windowStart: now });
    return null;
  }

  entry.count += 1;

  if (entry.count > MAX_REQUESTS) {
    const retryAfter = Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000);
    return { retryAfter };
  }

  return null;
}

describe("rate-limit algorithm", () => {
  test("allows requests under the limit (first request passes)", () => {
    const map = new Map<string, RateLimitEntry>();
    const result = checkRateLimit(map, "key_first", Date.now());
    expect(result).toBeNull();
  });

  test("returns rate-limit info when limit exceeded (101st request)", () => {
    const map = new Map<string, RateLimitEntry>();
    const now = Date.now();

    for (let i = 0; i < 100; i++) {
      checkRateLimit(map, "key_burst", now);
    }

    const result = checkRateLimit(map, "key_burst", now);
    expect(result).not.toBeNull();
    expect(result!.retryAfter).toBeGreaterThan(0);
  });

  test("includes positive retryAfter seconds on rate-limited response", () => {
    const map = new Map<string, RateLimitEntry>();
    const now = Date.now();

    for (let i = 0; i < 100; i++) {
      checkRateLimit(map, "key_retry", now);
    }

    const result = checkRateLimit(map, "key_retry", now);
    expect(result).not.toBeNull();
    expect(result!.retryAfter).toBeLessThanOrEqual(60);
    expect(result!.retryAfter).toBeGreaterThan(0);
  });

  test("different API keys have independent limits", () => {
    const map = new Map<string, RateLimitEntry>();
    const now = Date.now();

    for (let i = 0; i < 100; i++) {
      checkRateLimit(map, "key_a", now);
    }

    const resultA = checkRateLimit(map, "key_a", now);
    expect(resultA).not.toBeNull();

    const resultB = checkRateLimit(map, "key_b", now);
    expect(resultB).toBeNull();
  });

  test("skips rate limiting when no apiKeyId present", () => {
    const map = new Map<string, RateLimitEntry>();
    const now = Date.now();

    for (let i = 0; i < 200; i++) {
      checkRateLimit(map, undefined, now);
    }

    const result = checkRateLimit(map, undefined, now);
    expect(result).toBeNull();
  });

  test("resets counter after window expires", () => {
    const map = new Map<string, RateLimitEntry>();
    const start = Date.now();

    for (let i = 0; i < 100; i++) {
      checkRateLimit(map, "key_reset", start);
    }

    const blocked = checkRateLimit(map, "key_reset", start);
    expect(blocked).not.toBeNull();

    const afterWindow = start + WINDOW_MS + 1;
    const result = checkRateLimit(map, "key_reset", afterWindow);
    expect(result).toBeNull();
  });
});

/**
 * Mirror of `pruneExpiredEntries` in `src/middleware/rate-limit.ts`.
 * Kept here as a pure helper so unit tests don't pull in the real
 * config/logger graph (which requires DATABASE_URL at import time).
 */
function prune(map: Map<string, RateLimitEntry>, now: number): number {
  let removed = 0;
  for (const [k, entry] of map) {
    if (now - entry.windowStart >= WINDOW_MS) {
      map.delete(k);
      removed += 1;
    }
  }
  return removed;
}

describe("rate-limit cleanup", () => {
  test("removes expired entries", () => {
    const map = new Map<string, RateLimitEntry>();
    const start = Date.now();

    /** Mix of expired and live entries */
    map.set("k_expired_1", { count: 5, windowStart: start });
    map.set("k_expired_2", { count: 12, windowStart: start });
    map.set("k_live", { count: 1, windowStart: start + WINDOW_MS });

    const removed = prune(map, start + WINDOW_MS + 1);

    expect(removed).toBe(2);
    expect(map.has("k_expired_1")).toBe(false);
    expect(map.has("k_expired_2")).toBe(false);
    expect(map.has("k_live")).toBe(true);
  });

  test("keeps all entries when nothing has expired", () => {
    const map = new Map<string, RateLimitEntry>();
    const now = Date.now();
    map.set("a", { count: 1, windowStart: now });
    map.set("b", { count: 1, windowStart: now });

    const removed = prune(map, now);

    expect(removed).toBe(0);
    expect(map.size).toBe(2);
  });

  test("handles an empty map without throwing", () => {
    const map = new Map<string, RateLimitEntry>();
    const removed = prune(map, Date.now());
    expect(removed).toBe(0);
  });
});
