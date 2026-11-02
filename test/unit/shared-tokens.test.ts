import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { RedisClient } from "bun";
import { randomBytes } from "crypto";
import {
  MemoryTokenBuckets,
  sharedTokenBuckets,
  type TokenBucketStore,
} from "../../src/utils/shared-tokens.ts";
import {
  MemoryOneTimeStore,
  MemoryWindowCounter,
  SharedStoreError,
  useSharedBackend,
  type SharedStoreBackend,
} from "../../src/utils/shared-store.ts";
import { MemorySlotSemaphore } from "../../src/utils/shared-slots.ts";
import { connectRedisBackend } from "../../src/utils/redis-store.ts";
import {
  mxRateBudget,
  setMxRateBudget,
} from "../../src/modules/emails/services/rate-budget.ts";
import { logger } from "../../src/utils/logger.ts";

/**
 * The shared token buckets (#391) behind the per-MX rate budget
 * (`MAIL_MX_RATE_PER_MIN`). One contract, run against the in-memory
 * implementation always and against Redis when `REDIS_TEST_URL` is set
 * (for example `REDIS_TEST_URL=redis://127.0.0.1:6390 bun test
 * test/unit/shared-tokens.test.ts` with a throwaway `redis:7-alpine`).
 * "Two replicas" are two clients of one store: the same memory buckets
 * twice, or two Redis connections. Refills are fast and real (the Redis
 * clock is the server's); the exact arithmetic on an injected clock is in
 * `rate-budget.test.ts`.
 */

const REDIS_TEST_URL = process.env["REDIS_TEST_URL"];

/** Every key of this run lives under its own prefix, removed at the end. */
const PREFIX = `bunmail-test:${randomBytes(6).toString("hex")}:`;

/** A fresh, unique name. */
function unique(name: string): string {
  return `${name}-${randomBytes(4).toString("hex")}`;
}

/** How to get two replicas' views of one fresh set of buckets. */
interface Implementation {
  pair(): [TokenBucketStore, TokenBucketStore];
}

let redisA: SharedStoreBackend | null = null;
let redisB: SharedStoreBackend | null = null;
let redisRaw: RedisClient | null = null;

const memory: Implementation = {
  pair: () => {
    const shared = new MemoryTokenBuckets();
    return [shared, shared];
  },
};

const redis: Implementation = {
  pair: () => {
    if (!redisA || !redisB) throw new Error("no Redis backend");
    const ns = unique("tokens");
    return [redisA.tokens(ns), redisB.tokens(ns)];
  },
};

beforeAll(async () => {
  if (!REDIS_TEST_URL) return;
  const options = { secretKey: randomBytes(32), keyPrefix: PREFIX };
  redisA = await connectRedisBackend(REDIS_TEST_URL, options);
  redisB = await connectRedisBackend(REDIS_TEST_URL, options);
  redisRaw = new RedisClient(REDIS_TEST_URL);
  await redisRaw.connect();
});

afterAll(async () => {
  if (redisRaw) {
    const keys: unknown = await redisRaw.send("KEYS", [`${PREFIX}*`]);
    if (Array.isArray(keys) && keys.length > 0) {
      await redisRaw.send(
        "DEL",
        keys.filter((k): k is string => typeof k === "string"),
      );
    }
    redisRaw.close();
  }
  redisA?.close();
  redisB?.close();
});

afterEach(() => {
  useSharedBackend(null);
  setMxRateBudget(null);
});

/** A slow bucket: `n` tokens, `n` a minute (the rate budget's shape). */
function perMinute(n: number) {
  return { capacity: n, perMinute: n };
}

/** The token bucket contract, for one implementation. */
function contract(impl: Implementation): void {
  test("starts full; the next token is due in a minute over the rate", async () => {
    const [a] = impl.pair();
    const k = unique("google");
    expect(await a.take(k, 3, perMinute(3))).toEqual({ granted: 3, waitMs: 0 });
    const refused = await a.take(k, 1, perMinute(3));
    expect(refused.granted).toBe(0);
    expect(refused.waitMs).toBeGreaterThan(19_000);
    expect(refused.waitMs).toBeLessThanOrEqual(20_000);
  });

  test("grants what is there and says when the next token is due", async () => {
    const [a] = impl.pair();
    const k = unique("microsoft");
    const grant = await a.take(k, 3, perMinute(2));
    expect(grant.granted).toBe(2);
    expect(grant.waitMs).toBeGreaterThan(29_000);
    expect(grant.waitMs).toBeLessThanOrEqual(30_000);
  });

  test("two replicas share one bucket", async () => {
    const [a, b] = impl.pair();
    const k = unique("yahoo");
    expect((await a.take(k, 2, perMinute(3))).granted).toBe(2);
    expect(await b.take(k, 2, perMinute(3))).toMatchObject({ granted: 1 });
    expect((await a.take(k, 1, perMinute(3))).granted).toBe(0);
  });

  test("buckets are independent, and an empty request takes nothing", async () => {
    const [a, b] = impl.pair();
    const k = unique("apple");
    expect((await a.take(k, 1, perMinute(1))).granted).toBe(1);
    expect(await b.take(k, 0, perMinute(1))).toEqual({ granted: 0, waitMs: 0 });
    expect((await b.take(unique("other"), 1, perMinute(1))).granted).toBe(1);
  });

  test("refills continuously, keeping fractions, never past capacity", async () => {
    const [a, b] = impl.pair();
    const k = unique("refill");
    /** One token a second. */
    const rate = { capacity: 1, perMinute: 60 };
    expect((await a.take(k, 1, rate)).granted).toBe(1);
    await Bun.sleep(300);
    const partial = await b.take(k, 1, rate);
    /** About 0.3 of a token back: the wait shrank and was kept. */
    expect(partial.granted).toBe(0);
    expect(partial.waitMs).toBeLessThan(800);
    expect(partial.waitMs).toBeGreaterThan(500);
    /** A fast bucket idle for a while refills to its capacity of 2, not more. */
    const fast = { capacity: 2, perMinute: 6_000 };
    const f = unique("fast");
    expect((await a.take(f, 2, fast)).granted).toBe(2);
    await Bun.sleep(200);
    const capped = await b.take(f, 5, fast);
    expect(capped.granted).toBe(2);
    expect(capped.waitMs).toBeGreaterThan(0);
    expect(capped.waitMs).toBeLessThanOrEqual(10);
  });

  test("a parallel burst from two replicas gets exactly the capacity", async () => {
    const [a, b] = impl.pair();
    const k = unique("burst");
    const grants = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        (i % 2 === 0 ? a : b).take(k, 1, perMinute(10)),
      ),
    );
    expect(grants.reduce((sum, g) => sum + g.granted, 0)).toBe(10);
  });
}

describe("in-memory token buckets", () => {
  contract(memory);

  test("past 1000 buckets, the full ones are dropped", () => {
    let at = 1_000_000;
    const buckets = new MemoryTokenBuckets(() => at);
    for (let i = 0; i < 1_001; i++) buckets.takeNow(`b${i}`, 1, perMinute(1));
    buckets.takeNow("held", 1, { capacity: 1, perMinute: 1 / 60 });
    at += 60_000;
    /** The next take sweeps: every bucket refilled but the slow one. */
    buckets.takeNow("new", 0, perMinute(1));
    expect(buckets.entries.has("held")).toBe(true);
    expect(buckets.entries.has("b0")).toBe(false);
    expect(buckets.entries.size).toBe(2);
  });
});

describe.skipIf(!REDIS_TEST_URL)("Redis token buckets (REDIS_TEST_URL)", () => {
  contract(redis);

  /** The raw client, for looking at what Redis holds. */
  function raw(): RedisClient {
    if (!redisRaw) throw new Error("no raw Redis client");
    return redisRaw;
  }

  /** The names of this run's keys containing `part`. */
  async function keysWith(part: string): Promise<string[]> {
    const keys: unknown = await raw().send("KEYS", [`${PREFIX}*${part}*`]);
    return Array.isArray(keys)
      ? keys.filter((k): k is string => typeof k === "string")
      : [];
  }

  test("a bucket's key expires when it would be full again", async () => {
    const [a] = redis.pair();
    const k = unique("ttl");
    await a.take(k, 1, perMinute(60));
    const [name] = await keysWith(k);
    if (name === undefined) throw new Error("bucket key not found");
    const ttl = await raw().pttl(name);
    /** One token of 60 back at one a second. */
    expect(ttl).toBeGreaterThan(900);
    expect(ttl).toBeLessThanOrEqual(1_000);
    const fast = unique("gone");
    await a.take(fast, 1, { capacity: 1, perMinute: 6_000 });
    await Bun.sleep(60);
    expect(await keysWith(fast)).toEqual([]);
  });

  test("the mailer's budget shares Redis with another replica", async () => {
    if (!redisA || !redisB) throw new Error("no Redis backend");
    useSharedBackend(redisA);
    const bucket = unique("google");
    /** Another replica spent the bucket's only token. */
    await redisB.tokens("rate:mx").take(bucket, 1, perMinute(1));
    const grant = await mxRateBudget(1)?.take(bucket, 1);
    expect(grant?.granted).toBe(0);
    expect(grant?.waitMs).toBeGreaterThan(55_000);
  });
});

describe("the shared facade and the mailer's budget", () => {
  /** A backend whose token buckets fail, like Redis during an outage. */
  const down: SharedStoreBackend = {
    counter: () => new MemoryWindowCounter(),
    oneTime: () => new MemoryOneTimeStore(10),
    slots: () => new MemorySlotSemaphore(),
    tokens: () => ({
      take: () => Promise.reject(new SharedStoreError("REDIS_UNAVAILABLE", "down")),
    }),
    close: () => {},
  };

  /** A healthy backend held in memory: what Redis is to several replicas. */
  function healthyBackend(): { backend: SharedStoreBackend; tokens: MemoryTokenBuckets } {
    const tokens = new MemoryTokenBuckets();
    return {
      tokens,
      backend: {
        counter: () => new MemoryWindowCounter(),
        oneTime: () => new MemoryOneTimeStore(10),
        slots: () => new MemorySlotSemaphore(),
        tokens: () => tokens,
        close: () => {},
      },
    };
  }

  test("without a backend, process memory answers", async () => {
    const t = sharedTokenBuckets(unique("mem"));
    expect((await t.take("k", 1, perMinute(1))).granted).toBe(1);
    expect(t.local.entries.has("k")).toBe(true);
  });

  test("with a backend, it answers and memory stays empty", async () => {
    const healthy = healthyBackend();
    useSharedBackend(healthy.backend);
    const t = sharedTokenBuckets(unique("shared"));
    expect((await t.take("k", 1, perMinute(1))).granted).toBe(1);
    expect(healthy.tokens.entries.has("k")).toBe(true);
    expect(t.local.entries.size).toBe(0);
  });

  test("an outage falls back to memory, logging once a minute", async () => {
    const error = spyOn(logger, "error").mockImplementation(() => {});
    error.mockClear();
    try {
      useSharedBackend(down);
      const t = sharedTokenBuckets(unique("fallback"));
      expect((await t.take("k", 1, perMinute(1))).granted).toBe(1);
      /** Still paced during the outage: the memory bucket counts. */
      expect((await t.take("k", 1, perMinute(1))).granted).toBe(0);
      const lines = error.mock.calls.filter(([message]) =>
        message.startsWith("Shared store unavailable"),
      );
      expect(lines).toHaveLength(1);
      expect(lines[0]?.[1]).toMatchObject({ code: "REDIS_UNAVAILABLE" });
    } finally {
      error.mockRestore();
    }
  });

  test("two replicas' mailer budgets share one bucket through the store", async () => {
    const healthy = healthyBackend();
    useSharedBackend(healthy.backend);
    const budget = mxRateBudget(2);
    if (budget === null) throw new Error("no budget");
    expect((await budget.take("google", 1)).granted).toBe(1);
    /** Another replica takes the other token from the same store. */
    expect((await healthy.tokens.take("google", 1, perMinute(2))).granted).toBe(1);
    const refused = await budget.take("google", 1);
    expect(refused.granted).toBe(0);
    expect(refused.waitMs).toBeGreaterThan(25_000);
  });

  test("without a backend the mailer's budget is per replica, as before", async () => {
    const budget = mxRateBudget(1);
    if (budget === null) throw new Error("no budget");
    expect((await budget.take("google", 1)).granted).toBe(1);
    expect((await budget.take("google", 1)).granted).toBe(0);
  });
});
