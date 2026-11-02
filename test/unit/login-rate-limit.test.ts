import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  setSystemTime,
  spyOn,
} from "bun:test";
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
  takeLoginAttempt,
} from "../../src/middleware/login-rate-limit.ts";
import { logger } from "../../src/utils/logger.ts";

/**
 * Unit tests for the dashboard login brute-force limiter (#109).
 *
 * The module is config-free, so we import it directly and drive thresholds
 * explicitly, and the clock with `setSystemTime` (the in-memory store reads
 * `Date.now()`). Without `REDIS_URL` the attempt map is the whole state;
 * it is module-level, so each test starts from a clean map. The store's
 * own contract, in memory and in Redis, is in shared-store.test.ts.
 */

/** Moves the clock to `ms` (Unix epoch). */
function at(ms: number): void {
  setSystemTime(new Date(ms));
}

beforeEach(() => {
  loginAttemptMap.clear();
  at(1_000_000);
});

afterEach(() => {
  setSystemTime();
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

  test("an IP with no record is not limited", async () => {
    expect((await isLoginRateLimited("1.1.1.1", MAX)).limited).toBe(false);
  });

  test("is not limited until maxAttempts failures accumulate", async () => {
    for (let i = 0; i < MAX; i++) {
      expect((await isLoginRateLimited("2.2.2.2", MAX)).limited).toBe(false);
      await recordFailedLogin("2.2.2.2", WINDOW_MS);
    }
    /** 5 failures recorded → the 6th check is limited. */
    const result = await isLoginRateLimited("2.2.2.2", MAX);
    expect(result.limited).toBe(true);
    expect(result.retryAfterSec).toBeGreaterThan(0);
    expect(result.retryAfterSec).toBeLessThanOrEqual(900);
  });

  test("retryAfterSec counts down within the window", async () => {
    for (let i = 0; i < MAX; i++) await recordFailedLogin("3.3.3.3", WINDOW_MS);

    /** 600s into a 900s window → ~300s remaining. */
    at(1_000_000 + 600_000);
    const result = await isLoginRateLimited("3.3.3.3", MAX);
    expect(result.limited).toBe(true);
    expect(result.retryAfterSec).toBe(300);
  });

  test("lockout clears once the window expires", async () => {
    for (let i = 0; i < MAX; i++) await recordFailedLogin("4.4.4.4", WINDOW_MS);
    expect((await isLoginRateLimited("4.4.4.4", MAX)).limited).toBe(true);

    /** Exactly one window later → window expired, not limited. */
    at(1_000_000 + WINDOW_MS);
    expect((await isLoginRateLimited("4.4.4.4", MAX)).limited).toBe(false);
  });

  test("recordFailedLogin starts a fresh window after expiry", async () => {
    for (let i = 0; i < MAX; i++) await recordFailedLogin("5.5.5.5", WINDOW_MS);

    /** A failure after the window resets the count to 1 → not limited. */
    at(1_000_000 + WINDOW_MS + 1);
    await recordFailedLogin("5.5.5.5", WINDOW_MS);
    expect((await isLoginRateLimited("5.5.5.5", MAX)).limited).toBe(false);
  });

  test("clearLoginAttempts resets an IP's counter", async () => {
    for (let i = 0; i < MAX; i++) await recordFailedLogin("6.6.6.6", WINDOW_MS);
    expect((await isLoginRateLimited("6.6.6.6", MAX)).limited).toBe(true);

    await clearLoginAttempts(["6.6.6.6"]);
    expect((await isLoginRateLimited("6.6.6.6", MAX)).limited).toBe(false);
  });

  test("counters are independent per IP", async () => {
    for (let i = 0; i < MAX; i++) await recordFailedLogin("7.7.7.7", WINDOW_MS);
    expect((await isLoginRateLimited("7.7.7.7", MAX)).limited).toBe(true);
    expect((await isLoginRateLimited("8.8.8.8", MAX)).limited).toBe(false);
  });
});

describe("takeLoginAttempt (#185)", () => {
  const MAX = 3;
  const WINDOW_MS = 60_000;

  test("counts up to the limit, then refuses without counting", async () => {
    for (let i = 0; i < MAX; i++) {
      expect((await takeLoginAttempt(["192.0.2.20"], MAX, WINDOW_MS)).limited).toBe(
        false,
      );
    }
    const refused = await takeLoginAttempt(["192.0.2.20"], MAX, WINDOW_MS);
    expect(refused).toMatchObject({ limited: true, retryAfterSec: 60 });
    expect(loginAttemptMap.get("192.0.2.20")?.count).toBe(MAX);
  });

  test("a parallel burst passes no more attempts than the budget", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => takeLoginAttempt(["192.0.2.21"], MAX, WINDOW_MS)),
    );
    expect(results.filter((r) => !r.limited)).toHaveLength(MAX);
  });

  test("several keys: one spent key refuses, and nothing is counted on the others", async () => {
    for (let i = 0; i < MAX; i++)
      await recordFailedLogin("password:user:usr_1", WINDOW_MS);
    const keys = ["password:user:usr_1", "password:ip:192.0.2.22"];
    expect((await takeLoginAttempt(keys, MAX, WINDOW_MS)).limited).toBe(true);
    expect(loginAttemptMap.has("password:ip:192.0.2.22")).toBe(false);
  });

  test("buckets each key: an IPv6 /64 is one budget", async () => {
    for (let i = 1; i <= MAX; i++) {
      await takeLoginAttempt([`2001:db8:9:9::${i}`], MAX, WINDOW_MS);
    }
    expect((await takeLoginAttempt(["2001:db8:9:9::ffff"], MAX, WINDOW_MS)).limited).toBe(
      true,
    );
  });
});

describe("pruneExpiredLoginAttempts", () => {
  const WINDOW_MS = 900_000;

  test("removes only entries whose window has expired", async () => {
    await recordFailedLogin("old.ip", WINDOW_MS);
    at(1_000_000 + WINDOW_MS);
    await recordFailedLogin("fresh.ip", WINDOW_MS); // newer window

    /** Sweep one window after the first entry started. */
    expect(pruneExpiredLoginAttempts()).toBe(1);
    expect(loginAttemptMap.has("old.ip")).toBe(false);
    expect(loginAttemptMap.has("fresh.ip")).toBe(true);
  });

  test("returns 0 when nothing has expired", async () => {
    await recordFailedLogin("a.b.c.d", WINDOW_MS);
    expect(pruneExpiredLoginAttempts()).toBe(0);
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

  test("rotating addresses inside one IPv6 /64 still hits the limit", async () => {
    const windowMs = 60_000;
    for (let i = 1; i <= 5; i++) await recordFailedLogin(`2001:db8:1:2::${i}`, windowMs);
    expect((await isLoginRateLimited("2001:db8:1:2::ffff", 5)).limited).toBe(true);
    expect((await isLoginRateLimited("2001:db8:1:3::1", 5)).limited).toBe(false);
  });
});

describe("refundLoginAttempt (#256)", () => {
  const windowMs = 60_000;

  test("a successful login keeps the earlier failures", async () => {
    for (let i = 0; i < 4; i++) await recordFailedLogin("192.0.2.9", windowMs);
    /** The login counts itself first, then refunds on success. */
    const { ticket } = await takeLoginAttempt(["192.0.2.9"], 9, windowMs);
    await refundLoginAttempt("192.0.2.9", ticket);
    await recordFailedLogin("192.0.2.9", windowMs);
    expect((await isLoginRateLimited("192.0.2.9", 5)).limited).toBe(true);
  });

  test("successful logins alone never lock an address out", async () => {
    for (let i = 0; i < 20; i++) {
      const { ticket } = await takeLoginAttempt(["192.0.2.10"], 5, windowMs);
      await refundLoginAttempt("192.0.2.10", ticket);
    }
    expect((await isLoginRateLimited("192.0.2.10", 5)).limited).toBe(false);
  });

  test("does nothing once the window has expired", async () => {
    const { ticket } = await takeLoginAttempt(["192.0.2.11"], 5, windowMs);
    at(1_000_000 + windowMs);
    await refundLoginAttempt("192.0.2.11", ticket);
    /** The expired window is gone; a new one is not started by a refund. */
    expect(loginAttemptMap.has("192.0.2.11")).toBe(false);
  });

  test("a login straddling the end of a window never refunds a failure of the next", async () => {
    const max = 3;
    /** The login is counted in the first window, then its check runs long. */
    const { ticket } = await takeLoginAttempt(["192.0.2.12"], max, windowMs);
    at(1_000_000 + windowMs);
    for (let i = 0; i < max; i++) {
      expect((await takeLoginAttempt(["192.0.2.12"], max, windowMs)).limited).toBe(false);
    }
    /** Its success arrives now: the next window's failures all stay. */
    await refundLoginAttempt("192.0.2.12", ticket);
    expect((await takeLoginAttempt(["192.0.2.12"], max, windowMs)).limited).toBe(true);
  });

  test("an IPv6 client refunds into its /64 bucket", async () => {
    const { ticket } = await takeLoginAttempt(["2001:db8:5:5::1"], 5, windowMs);
    await refundLoginAttempt("2001:db8:5:5::1", ticket);
    expect(loginAttemptMap.get("2001:db8:5:5::/64")?.count).toBe(0);
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

  test("true once per key and window, false without a live window", async () => {
    expect(await shouldAuditLockout("192.0.2.1")).toBe(false);
    await recordFailedLogin("192.0.2.1", WINDOW);
    expect(await shouldAuditLockout("192.0.2.1")).toBe(true);
    expect(await shouldAuditLockout("192.0.2.1")).toBe(false);
    /** Another key has its own flag. */
    await recordFailedLogin("192.0.2.2", WINDOW);
    expect(await shouldAuditLockout("192.0.2.2")).toBe(true);
  });

  test("a new window resets the flag; an expired one says false", async () => {
    const t0 = 2_000_000;
    at(t0);
    await recordFailedLogin("192.0.2.1", WINDOW);
    at(t0 + 1);
    expect(await shouldAuditLockout("192.0.2.1")).toBe(true);
    at(t0 + WINDOW);
    expect(await shouldAuditLockout("192.0.2.1")).toBe(false);
    at(t0 + WINDOW + 1);
    await recordFailedLogin("192.0.2.1", WINDOW);
    at(t0 + WINDOW + 2);
    expect(await shouldAuditLockout("192.0.2.1")).toBe(true);
  });

  test("an IPv6 /64 shares one flag, like its bucket", async () => {
    await recordFailedLogin("2001:db8::1", WINDOW);
    expect(await shouldAuditLockout("2001:db8::1")).toBe(true);
    expect(await shouldAuditLockout("2001:db8::ffff")).toBe(false);
  });
});
