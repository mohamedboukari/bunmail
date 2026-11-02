import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  setSystemTime,
  test,
} from "bun:test";
import { RedisClient } from "bun";
import { randomBytes } from "crypto";
import {
  resetSubmissionLimits,
  submissionAuthMap,
  submissionConnectionMap,
  takeSubmissionConnection,
  throttledAuth,
  type AuthRateLimit,
} from "../../src/modules/smtp-submission/services/submission-limits.ts";
import {
  inboundConnectionMap,
  takeInboundConnection,
} from "../../src/modules/inbound/services/connection-limit.ts";
import {
  dnsVerifyMap,
  isDnsVerifyThrottled,
} from "../../src/pages/lib/dns-verify-throttle.ts";
import {
  claimLastUsedWrite,
  lastUsedClaimMap,
} from "../../src/middleware/last-used-throttle.ts";
import {
  MemoryOneTimeStore,
  MemoryWindowCounter,
  SharedStoreError,
  pruneLocalCounters,
  sharedWindowCounter,
  useSharedBackend,
  type SharedStoreBackend,
} from "../../src/utils/shared-store.ts";
import { connectRedisBackend } from "../../src/utils/redis-store.ts";
import { logger } from "../../src/utils/logger.ts";

/**
 * The limiters moved onto the shared store in #185 part 2: the SMTP
 * submission connection and failed-AUTH throttles, the inbound connection
 * limit, the dashboard DNS-verify throttle and the `last_used_at` write
 * claim. Each with the in-memory store (the default: exact limits and
 * windows, driven by `setSystemTime`), with one store shared by two
 * "replicas" (the module's own function, and a second counter in the same
 * namespace, as another process would hold), and during an outage. The
 * AUTH throttle also runs against Redis when `REDIS_TEST_URL` is set.
 */

/** Moves the clock to `ms` (Unix epoch). */
function at(ms: number): void {
  setSystemTime(new Date(ms));
}

/** The start of every test's clock. */
const T0 = 1_000_000;

/**
 * A shared backend held in this process's memory: what Redis is to
 * several replicas, without a Redis. One counter per namespace.
 */
function memoryBackend(): SharedStoreBackend {
  const counters = new Map<string, MemoryWindowCounter>();
  return {
    counter(namespace) {
      let counter = counters.get(namespace);
      if (!counter) {
        counter = new MemoryWindowCounter();
        counters.set(namespace, counter);
      }
      return counter;
    },
    oneTime: () => new MemoryOneTimeStore(10),
    close: () => {},
  };
}

/** A backend whose every operation fails, like Redis during an outage. */
const down: SharedStoreBackend = {
  counter: () => ({
    take: () => Promise.reject(new SharedStoreError("REDIS_UNAVAILABLE", "down")),
    peek: () => Promise.reject(new SharedStoreError("REDIS_UNAVAILABLE", "down")),
    refund: () => Promise.reject(new SharedStoreError("REDIS_UNAVAILABLE", "down")),
    delete: () => Promise.reject(new SharedStoreError("REDIS_UNAVAILABLE", "down")),
    markOnce: () => Promise.reject(new SharedStoreError("REDIS_UNAVAILABLE", "down")),
  }),
  oneTime: () => new MemoryOneTimeStore(10),
  close: () => {},
};

beforeEach(() => {
  resetSubmissionLimits();
  inboundConnectionMap.clear();
  dnsVerifyMap.clear();
  lastUsedClaimMap.clear();
  at(T0);
});

afterEach(() => {
  useSharedBackend(null);
  setSystemTime();
});

/* ─── SMTP submission: failed-AUTH throttle (map 7) ─── */

/** The defaults: `SMTP_SUBMISSION_AUTH_RATE_LIMIT_MAX` 10 per 900 s. */
const AUTH_LIMIT: AuthRateLimit = { enabled: true, maxAttempts: 10, windowSec: 900 };

/** The API key a fake lookup knows. */
const VALID = "bm_live_valid";

/** A key row as the lookup returns it. */
interface FakeKey {
  id: string;
  isActive: boolean;
}

/** A lookup that knows {@link VALID} only, counting its calls. */
function fakeLookup(): {
  lookup: (candidate: string) => Promise<FakeKey | undefined>;
  calls: () => number;
} {
  let calls = 0;
  return {
    lookup: (candidate) => {
      calls += 1;
      return Promise.resolve(
        candidate === VALID ? { id: "key_1", isActive: true } : undefined,
      );
    },
    calls: () => calls,
  };
}

/** One AUTH from `ip` with `password`, through the throttle. */
async function auth(
  ip: string,
  password: string,
  lookup = fakeLookup().lookup,
  limit = AUTH_LIMIT,
): Promise<string> {
  return (await throttledAuth(ip, password, limit, lookup)).status;
}

describe("SMTP submission failed-AUTH throttle", () => {
  test("10 failures per IP, then 454 before any lookup, valid key included", async () => {
    const { lookup, calls } = fakeLookup();
    for (let i = 0; i < 10; i++) {
      expect(await auth("198.51.100.1", `bm_live_guess_${i}`, lookup)).toBe("invalid");
    }
    expect(await auth("198.51.100.1", VALID, lookup)).toBe("rate_limited");
    expect(calls()).toBe(10);
    /** Another IP has its own budget. */
    expect(await auth("198.51.100.2", VALID, lookup)).toBe("authenticated");
  });

  test("a refused attempt counts nothing more: the window still ends 900 s after it began", async () => {
    for (let i = 0; i < 10; i++) await auth("198.51.100.1", "bm_live_wrong");
    at(T0 + 899_999);
    expect(await auth("198.51.100.1", VALID)).toBe("rate_limited");
    expect(submissionAuthMap.get("198.51.100.1")?.count).toBe(10);
    at(T0 + 900_000);
    expect(await auth("198.51.100.1", VALID)).toBe("authenticated");
  });

  test("a success gives back only its own count: earlier failures stay (#190)", async () => {
    for (let i = 0; i < 3; i++) await auth("198.51.100.1", "bm_live_wrong");
    for (let i = 0; i < 20; i++)
      expect(await auth("198.51.100.1", VALID)).toBe("authenticated");
    expect(submissionAuthMap.get("198.51.100.1")?.count).toBe(3);
    for (let i = 0; i < 7; i++) {
      expect(await auth("198.51.100.1", "bm_live_wrong")).toBe("invalid");
    }
    expect(await auth("198.51.100.1", VALID)).toBe("rate_limited");
  });

  test("missing credentials count as a failure; a failed lookup does not", async () => {
    expect(await auth("198.51.100.1", "")).toBe("no_credentials");
    expect(submissionAuthMap.get("198.51.100.1")?.count).toBe(1);
    const failing = (): Promise<FakeKey | undefined> =>
      Promise.reject(new Error("connection refused"));
    expect(await auth("198.51.100.1", VALID, failing)).toBe("lookup_failed");
    expect(submissionAuthMap.get("198.51.100.1")?.count).toBe(1);
  });

  test("an inactive key is a failure", async () => {
    const inactive = (): Promise<FakeKey | undefined> =>
      Promise.resolve({ id: "key_2", isActive: false });
    expect(await auth("198.51.100.1", "bm_live_revoked", inactive)).toBe("invalid");
    expect(submissionAuthMap.get("198.51.100.1")?.count).toBe(1);
  });

  test("a parallel burst of guesses reaches the lookup exactly 10 times", async () => {
    let calls = 0;
    /** A slow lookup: every guess is in flight before any of them fails. */
    const slow = async (): Promise<FakeKey | undefined> => {
      calls += 1;
      await Bun.sleep(5);
      return undefined;
    };
    const outcomes = await Promise.all(
      Array.from({ length: 50 }, (_, i) => auth("198.51.100.1", `bm_live_${i}`, slow)),
    );
    expect(calls).toBe(10);
    expect(outcomes.filter((o) => o === "invalid")).toHaveLength(10);
    expect(outcomes.filter((o) => o === "rate_limited")).toHaveLength(40);
  });

  test("a success straddling the end of a window never refunds a failure of the next (review L1)", async () => {
    const limit = { enabled: true, maxAttempts: 3, windowSec: 10 };
    /** A slow valid lookup: counted in the first window, refunded in the second. */
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = async (): Promise<FakeKey | undefined> => {
      await gate;
      return { id: "key_1", isActive: true };
    };
    const valid = throttledAuth("198.51.100.1", VALID, limit, slow);
    await Promise.resolve();
    at(T0 + 10_001);
    let guesses = 0;
    for (let i = 0; i < 3; i++) {
      if ((await auth("198.51.100.1", "bm_live_wrong", undefined, limit)) === "invalid") {
        guesses += 1;
      }
    }
    release();
    expect((await valid).status).toBe("authenticated");
    expect(await auth("198.51.100.1", "bm_live_wrong", undefined, limit)).toBe(
      "rate_limited",
    );
    expect(guesses).toBe(3);
    expect(submissionAuthMap.get("198.51.100.1")?.count).toBe(3);
  });

  test("an IPv6 client is counted per /64: two addresses in one /64 share a budget (review L2)", async () => {
    for (let i = 1; i <= 10; i++) {
      expect(await auth(`2001:db8:7:7::${i}`, "bm_live_wrong")).toBe("invalid");
    }
    expect(await auth("2001:db8:7:7:ffff:ffff:ffff:ffff", VALID)).toBe("rate_limited");
    expect(await auth("2001:db8:7:8::1", VALID)).toBe("authenticated");
    /** An IPv4-mapped address counts as its IPv4. */
    for (let i = 0; i < 10; i++) await auth("::ffff:192.0.2.50", "bm_live_wrong");
    expect(await auth("192.0.2.50", VALID)).toBe("rate_limited");
  });

  test("disabled: nothing counted, never limited", async () => {
    const off = { ...AUTH_LIMIT, enabled: false };
    for (let i = 0; i < 30; i++) {
      expect(await auth("198.51.100.1", "bm_live_wrong", undefined, off)).toBe("invalid");
    }
    expect(submissionAuthMap.size).toBe(0);
  });

  test("two replicas over one store share one budget per IP", async () => {
    useSharedBackend(memoryBackend());
    /** The other replica's counter: same namespace, its own process. */
    const replicaB = sharedWindowCounter("rl:smtp-auth");
    for (let i = 0; i < 5; i++) await auth("198.51.100.1", "bm_live_wrong");
    for (let i = 0; i < 5; i++) {
      await replicaB.take(["198.51.100.1"], { max: 10, windowMs: 900_000 });
    }
    expect(await auth("198.51.100.1", VALID)).toBe("rate_limited");
    /** Nothing went to this replica's memory. */
    expect(submissionAuthMap.size).toBe(0);
  });

  test("without a shared store, each replica has its own budget", async () => {
    const replicaB = sharedWindowCounter("rl:smtp-auth");
    for (let i = 0; i < 10; i++) {
      await replicaB.take(["198.51.100.1"], { max: 10, windowMs: 900_000 });
    }
    expect(await auth("198.51.100.1", VALID)).toBe("authenticated");
  });

  test("a Redis outage falls back to this replica's memory: still throttled", async () => {
    const error = spyOn(logger, "error").mockImplementation(() => {});
    try {
      useSharedBackend(down);
      for (let i = 0; i < 10; i++) await auth("198.51.100.1", "bm_live_wrong");
      expect(await auth("198.51.100.1", VALID)).toBe("rate_limited");
      expect(submissionAuthMap.get("198.51.100.1")?.count).toBe(10);
    } finally {
      error.mockRestore();
    }
  });
});

/* ─── SMTP submission: connection rate (map 6) ─── */

describe("SMTP submission connection rate", () => {
  /** The defaults: `SMTP_SUBMISSION_RATE_LIMIT_MAX` 30 per 60 s. */
  const take = (ip: string): Promise<boolean> => takeSubmissionConnection(ip, 30, 60);

  test("30 connections per IP per 60 s; every connection counts", async () => {
    for (let i = 0; i < 30; i++) expect(await take("203.0.113.1")).toBe(false);
    expect(await take("203.0.113.1")).toBe(true);
    expect(await take("203.0.113.2")).toBe(false);
    at(T0 + 59_999);
    expect(await take("203.0.113.1")).toBe(true);
    at(T0 + 60_000);
    expect(await take("203.0.113.1")).toBe(false);
  });

  test("two replicas over one store share one budget per IP", async () => {
    useSharedBackend(memoryBackend());
    const replicaB = sharedWindowCounter("rl:smtp-submission");
    for (let i = 0; i < 20; i++) await take("203.0.113.1");
    for (let i = 0; i < 10; i++) {
      await replicaB.take(["203.0.113.1"], { max: 30, windowMs: 60_000 });
    }
    expect(await take("203.0.113.1")).toBe(true);
    expect(submissionConnectionMap.size).toBe(0);
  });

  test("an IPv6 client is counted per /64 (review L2)", async () => {
    for (let i = 1; i <= 30; i++) expect(await take(`2001:db8:6:6::${i}`)).toBe(false);
    expect(await take("2001:db8:6:6::abcd")).toBe(true);
    expect(submissionConnectionMap.has("2001:db8:6:6::/64")).toBe(true);
  });

  test("resetSubmissionLimits forgets this process's counts", async () => {
    for (let i = 0; i < 31; i++) await take("203.0.113.1");
    resetSubmissionLimits();
    expect(await take("203.0.113.1")).toBe(false);
  });
});

/* ─── Inbound SMTP: connection rate (map 5) ─── */

describe("inbound SMTP connection rate", () => {
  /** The defaults: `SMTP_RATE_LIMIT_MAX` 10 per `SMTP_RATE_LIMIT_WINDOW` 60 s. */
  const take = (ip: string): Promise<boolean> => takeInboundConnection(ip, 10, 60);

  test("10 connections per IP per 60 s", async () => {
    for (let i = 0; i < 10; i++) expect(await take("192.0.2.1")).toBe(false);
    expect(await take("192.0.2.1")).toBe(true);
    expect(await take("192.0.2.2")).toBe(false);
    at(T0 + 60_000);
    expect(await take("192.0.2.1")).toBe(false);
  });

  test("two replicas over one store share one budget per IP", async () => {
    useSharedBackend(memoryBackend());
    const replicaB = sharedWindowCounter("rl:smtp-inbound");
    for (let i = 0; i < 6; i++) await take("192.0.2.1");
    for (let i = 0; i < 4; i++) {
      await replicaB.take(["192.0.2.1"], { max: 10, windowMs: 60_000 });
    }
    expect(await take("192.0.2.1")).toBe(true);
    expect(inboundConnectionMap.size).toBe(0);
  });
});

/* ─── Dashboard: DNS-verify throttle (map 4) ─── */

describe("DNS-verify throttle", () => {
  test("5 checks per domain per 60 s, from the first one", async () => {
    for (let i = 0; i < 5; i++) expect(await isDnsVerifyThrottled("dom_a")).toBe(false);
    expect(await isDnsVerifyThrottled("dom_a")).toBe(true);
    expect(await isDnsVerifyThrottled("dom_b")).toBe(false);
    at(T0 + 59_999);
    expect(await isDnsVerifyThrottled("dom_a")).toBe(true);
    at(T0 + 60_000);
    expect(await isDnsVerifyThrottled("dom_a")).toBe(false);
  });

  test("ended windows are swept: ids never seen again do not stay", async () => {
    for (let i = 0; i < 100; i++) await isDnsVerifyThrottled(`dom_unknown_${i}`);
    expect(dnsVerifyMap.size).toBe(100);
    at(T0 + 60_000);
    expect(pruneLocalCounters()).toBeGreaterThanOrEqual(100);
    expect(dnsVerifyMap.size).toBe(0);
  });

  test("two replicas over one store share one budget per domain", async () => {
    useSharedBackend(memoryBackend());
    const replicaB = sharedWindowCounter("rl:dns-verify");
    for (let i = 0; i < 3; i++) await isDnsVerifyThrottled("dom_a");
    for (let i = 0; i < 2; i++) {
      await replicaB.take(["dom_a"], { max: 5, windowMs: 60_000 });
    }
    expect(await isDnsVerifyThrottled("dom_a")).toBe(true);
    expect(dnsVerifyMap.size).toBe(0);
  });
});

/* ─── API keys: `last_used_at` write claim (map 8) ─── */

describe("last_used_at write claim", () => {
  test("the first use of a key in a minute claims the write, later uses do not", async () => {
    expect(await claimLastUsedWrite("key_a")).toBe(true);
    expect(await claimLastUsedWrite("key_a")).toBe(false);
    expect(await claimLastUsedWrite("key_b")).toBe(true);
    at(T0 + 59_999);
    expect(await claimLastUsedWrite("key_a")).toBe(false);
    at(T0 + 60_000);
    expect(await claimLastUsedWrite("key_a")).toBe(true);
  });

  test("claims expire: the map no longer grows with every key ever used", async () => {
    for (let i = 0; i < 50; i++) await claimLastUsedWrite(`key_${i}`);
    expect(lastUsedClaimMap.size).toBe(50);
    at(T0 + 60_000);
    pruneLocalCounters();
    expect(lastUsedClaimMap.size).toBe(0);
  });

  test("two replicas over one store write once a minute per key, not once each", async () => {
    useSharedBackend(memoryBackend());
    const replicaB = sharedWindowCounter("throttle:last-used");
    const b = await replicaB.take(["key_a"], { max: 1, windowMs: 60_000 });
    expect(b.limited).toBe(false);
    expect(await claimLastUsedWrite("key_a")).toBe(false);
    expect(lastUsedClaimMap.size).toBe(0);
  });
});

/* ─── Against Redis (REDIS_TEST_URL) ─── */

const REDIS_TEST_URL = process.env["REDIS_TEST_URL"];

describe.skipIf(!REDIS_TEST_URL)("failed-AUTH throttle in Redis (REDIS_TEST_URL)", () => {
  /** Every key of this run lives under its own prefix, removed at the end. */
  const prefix = `bunmail-test:${randomBytes(6).toString("hex")}:`;
  let backend: SharedStoreBackend | null = null;

  beforeAll(async () => {
    if (!REDIS_TEST_URL) return;
    backend = await connectRedisBackend(REDIS_TEST_URL, {
      secretKey: randomBytes(32),
      keyPrefix: prefix,
    });
  });

  afterAll(async () => {
    backend?.close();
    if (!REDIS_TEST_URL) return;
    const raw = new RedisClient(REDIS_TEST_URL);
    await raw.connect();
    const keys: unknown = await raw.send("KEYS", [`${prefix}*`]);
    if (Array.isArray(keys) && keys.length > 0) {
      await raw.send(
        "DEL",
        keys.filter((k): k is string => typeof k === "string"),
      );
    }
    raw.close();
  });

  test("two replicas share one budget, and every key expires with its window", async () => {
    if (!backend || !REDIS_TEST_URL) throw new Error("no Redis backend");
    /** The real clock: Redis keeps its own time. */
    setSystemTime();
    useSharedBackend(backend);
    const ip = "198.51.100.7";
    const replicaB = sharedWindowCounter("rl:smtp-auth");
    for (let i = 0; i < 6; i++) await auth(ip, "bm_live_wrong");
    for (let i = 0; i < 4; i++) {
      await replicaB.take([ip], { max: 10, windowMs: 900_000 });
    }
    expect(await auth(ip, VALID)).toBe("rate_limited");
    expect(submissionAuthMap.size).toBe(0);

    const raw = new RedisClient(REDIS_TEST_URL);
    await raw.connect();
    try {
      const ttl = await raw.pttl(`${prefix}rl:smtp-auth:${ip}`);
      expect(ttl).toBeGreaterThan(890_000);
      expect(ttl).toBeLessThanOrEqual(900_000);
    } finally {
      raw.close();
    }
  });
});
