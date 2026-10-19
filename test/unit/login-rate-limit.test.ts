import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import {
  resolveClientIp,
  isLoginRateLimited,
  rateLimitBucket,
  recordFailedLogin,
  refundLoginAttempt,
  clearLoginAttempts,
  pruneExpiredLoginAttempts,
  loginAttemptMap,
  shouldAuditLockout,
} from "../../src/middleware/login-rate-limit.ts";
import { logger } from "../../src/utils/logger.ts";

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
       *  client, so the rightmost, not the spoofed leftmost, is used. */
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

describe("throttle buckets (#256)", () => {
  test.each([
    ["192.0.2.1", "192.0.2.1"],
    ["2001:db8:1:2:aaaa:bbbb:cccc:dddd", "2001:db8:1:2::/64"],
    ["2001:DB8:1:2::1", "2001:db8:1:2::/64"],
    ["::ffff:192.0.2.1", "192.0.2.1"],
    ["::ffff:c000:201", "192.0.2.1"],
    ["unknown", "unknown"],
    ["transfer:user:usr_1", "transfer:user:usr_1"],
  ])("%p counts in %p", (ip, bucket) => {
    expect(rateLimitBucket(ip)).toBe(bucket);
  });

  test("rotating addresses inside one IPv6 /64 still hits the limit", () => {
    const windowMs = 60_000;
    for (let i = 1; i <= 5; i++) recordFailedLogin(`2001:db8:1:2::${i}`, windowMs, 1000);
    expect(isLoginRateLimited("2001:db8:1:2::ffff", 5, windowMs, 1000).limited).toBe(
      true,
    );
    expect(isLoginRateLimited("2001:db8:1:3::1", 5, windowMs, 1000).limited).toBe(false);
  });
});

describe("refundLoginAttempt (#256)", () => {
  const windowMs = 60_000;

  test("a successful login keeps the earlier failures", () => {
    for (let i = 0; i < 4; i++) recordFailedLogin("192.0.2.9", windowMs, 1000);
    /** The login counts itself first, then refunds on success. */
    recordFailedLogin("192.0.2.9", windowMs, 1000);
    refundLoginAttempt("192.0.2.9", windowMs, 1000);
    recordFailedLogin("192.0.2.9", windowMs, 1000);
    expect(isLoginRateLimited("192.0.2.9", 5, windowMs, 1000).limited).toBe(true);
  });

  test("successful logins alone never lock an address out", () => {
    for (let i = 0; i < 20; i++) {
      recordFailedLogin("192.0.2.10", windowMs, 1000);
      refundLoginAttempt("192.0.2.10", windowMs, 1000);
    }
    expect(isLoginRateLimited("192.0.2.10", 5, windowMs, 1000).limited).toBe(false);
  });

  test("does nothing once the window has expired", () => {
    recordFailedLogin("192.0.2.11", windowMs, 1000);
    refundLoginAttempt("192.0.2.11", windowMs, 1000 + windowMs);
    expect(loginAttemptMap.get("192.0.2.11")?.count).toBe(1);
  });
});

describe("unproxied request warning (#256)", () => {
  test("warns at most once an hour when a request bypasses the trusted proxy", () => {
    const warn = spyOn(logger, "warn");
    warn.mockClear();
    try {
      const later = Date.now() + 2 * 60 * 60 * 1000;
      const direct = { socketIp: "203.0.113.5", forwardedFor: null, trustedProxyHops: 1 };
      resolveClientIp({ ...direct, now: later });
      resolveClientIp({ ...direct, now: later + 1000 });
      const bypass = warn.mock.calls.filter(([message]) =>
        message.startsWith("Request bypassed the trusted proxy"),
      );
      expect(bypass).toHaveLength(1);

      /** Through the proxy: no warning. */
      warn.mockClear();
      resolveClientIp({
        socketIp: "10.0.0.2",
        forwardedFor: "198.51.100.7",
        trustedProxyHops: 1,
        now: later + 3 * 60 * 60 * 1000,
      });
      expect(warn.mock.calls).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("shouldAuditLockout (#221)", () => {
  const WINDOW = 60_000;

  test("true once per key and window, false without a live window", () => {
    expect(shouldAuditLockout("192.0.2.1", WINDOW, 1_000)).toBe(false);
    recordFailedLogin("192.0.2.1", WINDOW, 1_000);
    expect(shouldAuditLockout("192.0.2.1", WINDOW, 2_000)).toBe(true);
    expect(shouldAuditLockout("192.0.2.1", WINDOW, 3_000)).toBe(false);
    /** Another key has its own flag. */
    recordFailedLogin("192.0.2.2", WINDOW, 1_000);
    expect(shouldAuditLockout("192.0.2.2", WINDOW, 2_000)).toBe(true);
  });

  test("a new window resets the flag; an expired one says false", () => {
    recordFailedLogin("192.0.2.1", WINDOW, 0);
    expect(shouldAuditLockout("192.0.2.1", WINDOW, 1)).toBe(true);
    expect(shouldAuditLockout("192.0.2.1", WINDOW, WINDOW)).toBe(false);
    recordFailedLogin("192.0.2.1", WINDOW, WINDOW + 1);
    expect(shouldAuditLockout("192.0.2.1", WINDOW, WINDOW + 2)).toBe(true);
  });

  test("an IPv6 /64 shares one flag, like its bucket", () => {
    recordFailedLogin("2001:db8::1", WINDOW, 0);
    expect(shouldAuditLockout("2001:db8::1", WINDOW, 1)).toBe(true);
    expect(shouldAuditLockout("2001:db8::ffff", WINDOW, 2)).toBe(false);
  });
});
