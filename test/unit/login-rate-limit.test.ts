import { describe, test, expect, beforeEach } from "bun:test";
import {
  resolveClientIp,
  isLoginRateLimited,
  recordFailedLogin,
  clearLoginAttempts,
  pruneExpiredLoginAttempts,
  loginAttemptMap,
} from "../../src/middleware/login-rate-limit.ts";

/**
 * Unit tests for the dashboard login brute-force limiter (#109).
 *
 * The module is config-free, so we import it directly and drive thresholds
 * and the clock explicitly. The attempt map is module-level shared state,
 * so each test starts from a clean map.
 */

beforeEach(() => {
  loginAttemptMap.clear();
});

describe("resolveClientIp", () => {
  describe("trustedProxyHops = 0 (don't trust the header)", () => {
    test("uses the socket IP and ignores X-Forwarded-For entirely", () => {
      const ip = resolveClientIp({
        socketIp: "203.0.113.5",
        forwardedFor: "1.2.3.4, 5.6.7.8",
        trustedProxyHops: 0,
      });
      expect(ip).toBe("203.0.113.5");
    });

    test("returns 'unknown' when there is no socket IP", () => {
      const ip = resolveClientIp({
        socketIp: undefined,
        forwardedFor: null,
        trustedProxyHops: 0,
      });
      expect(ip).toBe("unknown");
    });
  });

  describe("trustedProxyHops >= 1 (count from the right)", () => {
    test("one hop → takes the rightmost X-Forwarded-For entry", () => {
      const ip = resolveClientIp({
        socketIp: "10.0.0.1",
        forwardedFor: "1.2.3.4, 9.9.9.9",
        trustedProxyHops: 1,
      });
      expect(ip).toBe("9.9.9.9");
    });

    test("two hops → takes the 2nd entry from the right", () => {
      const ip = resolveClientIp({
        socketIp: "10.0.0.1",
        forwardedFor: "1.1.1.1, 2.2.2.2, 3.3.3.3",
        trustedProxyHops: 2,
      });
      expect(ip).toBe("2.2.2.2");
    });

    test("ignores a spoofed leftmost entry (single trusted hop)", () => {
      /** Attacker sends a forged XFF; the trusted proxy appends the real
       *  client, so the rightmost — not the spoofed leftmost — is used. */
      const ip = resolveClientIp({
        socketIp: "10.0.0.1",
        forwardedFor: "6.6.6.6, 203.0.113.9",
        trustedProxyHops: 1,
      });
      expect(ip).toBe("203.0.113.9");
    });

    test("falls back to socket IP when the header has fewer entries than hops", () => {
      const ip = resolveClientIp({
        socketIp: "10.0.0.1",
        forwardedFor: "9.9.9.9",
        trustedProxyHops: 2,
      });
      expect(ip).toBe("10.0.0.1");
    });

    test("falls back to socket IP when the header is absent", () => {
      const ip = resolveClientIp({
        socketIp: "10.0.0.1",
        forwardedFor: null,
        trustedProxyHops: 1,
      });
      expect(ip).toBe("10.0.0.1");
    });

    test("tolerates extra whitespace and empty segments", () => {
      const ip = resolveClientIp({
        socketIp: "10.0.0.1",
        forwardedFor: " 1.2.3.4 ,  9.9.9.9 , ",
        trustedProxyHops: 1,
      });
      expect(ip).toBe("9.9.9.9");
    });

    test("returns 'unknown' when neither header nor socket yields an IP", () => {
      const ip = resolveClientIp({
        socketIp: undefined,
        forwardedFor: null,
        trustedProxyHops: 1,
      });
      expect(ip).toBe("unknown");
    });
  });
});

describe("login rate limiter", () => {
  const MAX = 5;
  const WINDOW_MS = 900_000; // 15 minutes

  test("an IP with no record is not limited", () => {
    expect(isLoginRateLimited("1.1.1.1", MAX, WINDOW_MS).limited).toBe(false);
  });

  test("is not limited until maxAttempts failures accumulate", () => {
    const now = 1_000_000;
    for (let i = 0; i < MAX; i++) {
      expect(isLoginRateLimited("2.2.2.2", MAX, WINDOW_MS, now).limited).toBe(false);
      recordFailedLogin("2.2.2.2", WINDOW_MS, now);
    }
    /** 5 failures recorded → the 6th check is limited. */
    const result = isLoginRateLimited("2.2.2.2", MAX, WINDOW_MS, now);
    expect(result.limited).toBe(true);
    expect(result.retryAfterSec).toBeGreaterThan(0);
    expect(result.retryAfterSec).toBeLessThanOrEqual(900);
  });

  test("retryAfterSec counts down within the window", () => {
    const start = 1_000_000;
    for (let i = 0; i < MAX; i++) recordFailedLogin("3.3.3.3", WINDOW_MS, start);

    /** 600s into a 900s window → ~300s remaining. */
    const result = isLoginRateLimited("3.3.3.3", MAX, WINDOW_MS, start + 600_000);
    expect(result.limited).toBe(true);
    expect(result.retryAfterSec).toBe(300);
  });

  test("lockout clears once the window expires", () => {
    const start = 1_000_000;
    for (let i = 0; i < MAX; i++) recordFailedLogin("4.4.4.4", WINDOW_MS, start);
    expect(isLoginRateLimited("4.4.4.4", MAX, WINDOW_MS, start).limited).toBe(true);

    /** Exactly one window later → window expired, not limited. */
    expect(isLoginRateLimited("4.4.4.4", MAX, WINDOW_MS, start + WINDOW_MS).limited).toBe(
      false,
    );
  });

  test("recordFailedLogin starts a fresh window after expiry", () => {
    const start = 1_000_000;
    for (let i = 0; i < MAX; i++) recordFailedLogin("5.5.5.5", WINDOW_MS, start);

    /** A failure after the window resets the count to 1 → not limited. */
    recordFailedLogin("5.5.5.5", WINDOW_MS, start + WINDOW_MS + 1);
    expect(
      isLoginRateLimited("5.5.5.5", MAX, WINDOW_MS, start + WINDOW_MS + 1).limited,
    ).toBe(false);
  });

  test("clearLoginAttempts resets an IP's counter", () => {
    const now = 1_000_000;
    for (let i = 0; i < MAX; i++) recordFailedLogin("6.6.6.6", WINDOW_MS, now);
    expect(isLoginRateLimited("6.6.6.6", MAX, WINDOW_MS, now).limited).toBe(true);

    clearLoginAttempts("6.6.6.6");
    expect(isLoginRateLimited("6.6.6.6", MAX, WINDOW_MS, now).limited).toBe(false);
  });

  test("counters are independent per IP", () => {
    const now = 1_000_000;
    for (let i = 0; i < MAX; i++) recordFailedLogin("7.7.7.7", WINDOW_MS, now);
    expect(isLoginRateLimited("7.7.7.7", MAX, WINDOW_MS, now).limited).toBe(true);
    expect(isLoginRateLimited("8.8.8.8", MAX, WINDOW_MS, now).limited).toBe(false);
  });
});

describe("pruneExpiredLoginAttempts", () => {
  const WINDOW_MS = 900_000;

  test("removes only entries whose window has expired", () => {
    const start = 1_000_000;
    recordFailedLogin("old.ip", WINDOW_MS, start);
    recordFailedLogin("fresh.ip", WINDOW_MS, start + WINDOW_MS); // newer window

    /** Sweep one window after the first entry started. */
    const removed = pruneExpiredLoginAttempts(WINDOW_MS, start + WINDOW_MS);
    expect(removed).toBe(1);
    expect(loginAttemptMap.has("old.ip")).toBe(false);
    expect(loginAttemptMap.has("fresh.ip")).toBe(true);
  });

  test("returns 0 when nothing has expired", () => {
    const now = 1_000_000;
    recordFailedLogin("a.b.c.d", WINDOW_MS, now);
    expect(pruneExpiredLoginAttempts(WINDOW_MS, now)).toBe(0);
  });
});
