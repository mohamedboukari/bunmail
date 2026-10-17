import { describe, test, expect } from "bun:test";
import {
  checkRateLimit,
  MAX_REQUESTS,
  pruneExpiredEntries,
  readApiKeyId,
  WINDOW_MS,
  type RateLimitEntry,
} from "../../src/middleware/rate-limit-core.ts";

/**
 * Unit tests for the HTTP API rate limiter (#174).
 *
 * These exercise the real algorithm in rate-limit-core.ts. They used to
 * re-declare it locally, so they passed regardless of the source. The
 * core lives apart from rate-limit.ts because e2e tests mock that module.
 */

const T0 = 1_700_000_000_000;

/** Sends `n` requests for `key` at time `now`; returns the last decision. */
function sendN(map: Map<string, RateLimitEntry>, key: string, n: number, now: number) {
  let last = checkRateLimit(map, key, now);
  for (let i = 1; i < n; i++) last = checkRateLimit(map, key, now);
  return last;
}

describe("checkRateLimit", () => {
  test("allows the first request and starts a window", () => {
    const map = new Map<string, RateLimitEntry>();
    expect(checkRateLimit(map, "key_a", T0)).toEqual({ limited: false });
    expect(map.get("key_a")).toEqual({ count: 1, windowStart: T0 });
  });

  test("allows exactly MAX_REQUESTS requests in a window", () => {
    const map = new Map<string, RateLimitEntry>();
    expect(sendN(map, "key_a", MAX_REQUESTS, T0)).toEqual({ limited: false });
  });

  test("limits request MAX_REQUESTS + 1", () => {
    const map = new Map<string, RateLimitEntry>();
    sendN(map, "key_a", MAX_REQUESTS, T0);
    const decision = checkRateLimit(map, "key_a", T0);
    expect(decision).toEqual({ limited: true, count: MAX_REQUESTS + 1, retryAfter: 60 });
  });

  test("retryAfter is the seconds left in the window, rounded up", () => {
    const map = new Map<string, RateLimitEntry>();
    sendN(map, "key_a", MAX_REQUESTS, T0);
    const decision = checkRateLimit(map, "key_a", T0 + 45_500);
    expect(decision).toMatchObject({ limited: true, retryAfter: 15 });
  });

  test("different API keys have independent limits", () => {
    const map = new Map<string, RateLimitEntry>();
    sendN(map, "key_a", MAX_REQUESTS + 1, T0);
    expect(checkRateLimit(map, "key_b", T0)).toEqual({ limited: false });
  });

  test("resets the counter once the window expires", () => {
    const map = new Map<string, RateLimitEntry>();
    sendN(map, "key_a", MAX_REQUESTS + 1, T0);
    expect(checkRateLimit(map, "key_a", T0 + WINDOW_MS)).toEqual({ limited: false });
    expect(map.get("key_a")).toEqual({ count: 1, windowStart: T0 + WINDOW_MS });
  });
});

describe("checkRateLimit with a configured limit (API_RATE_LIMIT_*)", () => {
  const options = { max: 3, windowMs: 10_000 };

  test("enforces the configured max instead of the default", () => {
    const map = new Map<string, RateLimitEntry>();
    for (let i = 0; i < 3; i++) {
      expect(checkRateLimit(map, "key_a", T0, options)).toEqual({ limited: false });
    }
    expect(checkRateLimit(map, "key_a", T0 + 1_000, options)).toEqual({
      limited: true,
      count: 4,
      retryAfter: 9,
    });
  });

  test("uses the configured window for resets and pruning", () => {
    const map = new Map<string, RateLimitEntry>();
    for (let i = 0; i < 4; i++) checkRateLimit(map, "key_a", T0, options);
    /** 10 s later the configured window has expired (the default is 60 s). */
    expect(checkRateLimit(map, "key_a", T0 + 10_000, options)).toEqual({
      limited: false,
    });
    expect(pruneExpiredEntries(map, T0 + 20_000, options.windowMs)).toBe(1);
  });
});

describe("readApiKeyId (skip rate limiting when auth didn't run)", () => {
  test("returns the key ID set by the auth middleware", () => {
    expect(readApiKeyId({ apiKeyId: "key_a" })).toBe("key_a");
  });

  test("returns undefined when there is no apiKeyId", () => {
    expect(readApiKeyId({})).toBeUndefined();
    expect(readApiKeyId(null)).toBeUndefined();
    expect(readApiKeyId(undefined)).toBeUndefined();
  });

  test("does not trust a non-string apiKeyId", () => {
    expect(readApiKeyId({ apiKeyId: 123 })).toBeUndefined();
    expect(readApiKeyId({ apiKeyId: { id: "key_a" } })).toBeUndefined();
  });
});

describe("pruneExpiredEntries", () => {
  test("removes expired entries and keeps live ones", () => {
    const map = new Map<string, RateLimitEntry>([
      ["old", { count: 5, windowStart: T0 - WINDOW_MS }],
      ["live", { count: 5, windowStart: T0 - 1_000 }],
    ]);
    expect(pruneExpiredEntries(map, T0)).toBe(1);
    expect([...map.keys()]).toEqual(["live"]);
  });

  test("keeps all entries when nothing has expired", () => {
    const map = new Map<string, RateLimitEntry>([
      ["a", { count: 1, windowStart: T0 }],
      ["b", { count: 1, windowStart: T0 }],
    ]);
    expect(pruneExpiredEntries(map, T0 + 1_000)).toBe(0);
    expect(map.size).toBe(2);
  });

  test("handles an empty map", () => {
    expect(pruneExpiredEntries(new Map(), T0)).toBe(0);
  });
});
