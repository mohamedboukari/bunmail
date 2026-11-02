import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RedisClient } from "bun";
import { randomBytes } from "crypto";
import {
  MemorySlotSemaphore,
  sharedSlotSemaphore,
  type SlotSemaphore,
} from "../../src/utils/shared-slots.ts";
import {
  pruneLocalCounters,
  type SharedStoreBackend,
} from "../../src/utils/shared-store.ts";
import { connectRedisBackend } from "../../src/utils/redis-store.ts";

/**
 * The leased-slot semaphores (#185, part 3): one contract, run against the
 * in-memory implementation always and against Redis when `REDIS_TEST_URL`
 * is set (for example `REDIS_TEST_URL=redis://127.0.0.1:6390 bun test
 * test/unit/shared-slots.test.ts` with a throwaway `redis:7-alpine`).
 * "Two replicas" are two clients of one store: the same memory semaphore
 * twice, or two Redis connections. Leases are short and real. The facade
 * and the per-MX throttle on top are in `mx-throttle-shared.test.ts`.
 */

const REDIS_TEST_URL = process.env["REDIS_TEST_URL"];

/** Every key of this run lives under its own prefix, removed at the end. */
const PREFIX = `bunmail-test:${randomBytes(6).toString("hex")}:`;

/** A fresh, unique name. */
function unique(name: string): string {
  return `${name}-${randomBytes(4).toString("hex")}`;
}

/** Options with a long lease and place unless a test shortens them. */
function opts(max: number, leaseMs = 60_000, queueTtlMs = 60_000) {
  return { max, leaseMs, queueTtlMs };
}

/** How to get two replicas' views of one fresh semaphore. */
interface Implementation {
  pair(): [SlotSemaphore, SlotSemaphore];
}

let redisA: SharedStoreBackend | null = null;
let redisB: SharedStoreBackend | null = null;
let redisRaw: RedisClient | null = null;

const memory: Implementation = {
  pair: () => {
    const shared = new MemorySlotSemaphore();
    return [shared, shared];
  },
};

const redis: Implementation = {
  pair: () => {
    if (!redisA || !redisB) throw new Error("no Redis backend");
    const ns = unique("slots");
    return [redisA.slots(ns), redisB.slots(ns)];
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

/** The slot contract, for one implementation. */
function contract(impl: Implementation): void {
  test("the limit holds across two replicas", async () => {
    const [a, b] = impl.pair();
    const k = unique("mx");
    expect(await a.acquire(k, "a1", opts(2))).toBe(true);
    expect(await b.acquire(k, "b1", opts(2))).toBe(true);
    expect(await a.acquire(k, "a2", opts(2))).toBe(false);
    expect(await b.acquire(k, "b2", opts(2))).toBe(false);
  });

  test("a release frees a slot, and another key is never affected", async () => {
    const [a, b] = impl.pair();
    const k = unique("mx");
    expect(await a.acquire(k, "a1", opts(1))).toBe(true);
    expect(await b.acquire(unique("other"), "b0", opts(1))).toBe(true);
    expect(await b.acquire(k, "b1", opts(1))).toBe(false);
    await a.release(k, "a1");
    expect(await b.acquire(k, "b1", opts(1))).toBe(true);
  });

  test("asking again while holding renews instead of taking a second slot", async () => {
    const [a, b] = impl.pair();
    const k = unique("mx");
    expect(await a.acquire(k, "a1", opts(2))).toBe(true);
    expect(await a.acquire(k, "a1", opts(2))).toBe(true);
    expect(await b.acquire(k, "b1", opts(2))).toBe(true);
  });

  test("an expired lease frees its slot (a crashed replica)", async () => {
    const [a, b] = impl.pair();
    const k = unique("mx");
    expect(await a.acquire(k, "crashed", opts(1, 150))).toBe(true);
    expect(await b.acquire(k, "b1", opts(1, 150, 150))).toBe(false);
    await Bun.sleep(250);
    /** b1's place lapsed too; nobody is ahead of it. */
    expect(await b.acquire(k, "b1", opts(1, 150, 150))).toBe(true);
    expect(await a.renew(k, "crashed", 60_000)).toBe(false);
  });

  test("a renewal keeps the slot past its first lease", async () => {
    const [a, b] = impl.pair();
    const k = unique("mx");
    expect(await a.acquire(k, "a1", opts(1, 200))).toBe(true);
    await Bun.sleep(120);
    expect(await a.renew(k, "a1", 200)).toBe(true);
    await Bun.sleep(120);
    /** 240 ms after the grant: lapsed without the renewal, still held with it. */
    expect(await b.acquire(k, "b1", opts(1))).toBe(false);
    expect(await a.renew(k, "a1", 200)).toBe(true);
    expect(await b.renew(k, "never-held", 200)).toBe(false);
  });

  test("a release or renewal by a stale holder does nothing", async () => {
    const [a, b] = impl.pair();
    const k = unique("mx");
    expect(await a.acquire(k, "old", opts(1))).toBe(true);
    await a.release(k, "old");
    expect(await b.acquire(k, "new", opts(1))).toBe(true);
    await a.release(k, "old");
    expect(await a.renew(k, "old", 60_000)).toBe(false);
    expect(await a.acquire(k, "other", opts(1))).toBe(false);
    await b.release(k, "new");
    expect(await a.acquire(k, "other", opts(1))).toBe(true);
  });

  test("waiters are served first come, first served across replicas", async () => {
    const [a, b] = impl.pair();
    const k = unique("mx");
    expect(await a.acquire(k, "a1", opts(1))).toBe(true);
    expect(await b.acquire(k, "b-first", opts(1))).toBe(false);
    expect(await a.acquire(k, "a-second", opts(1))).toBe(false);
    await a.release(k, "a1");
    /** Free, but b-first asked earlier: a-second waits its turn. */
    expect(await a.acquire(k, "a-second", opts(1))).toBe(false);
    expect(await b.acquire(k, "b-first", opts(1))).toBe(true);
    await b.release(k, "b-first");
    expect(await a.acquire(k, "a-second", opts(1))).toBe(true);
  });

  test("the line keeps the order of arrival, not of holder names", async () => {
    const [a, b] = impl.pair();
    const k = unique("mx");
    expect(await a.acquire(k, "a1", opts(1))).toBe(true);
    /** Asked within one millisecond, in reverse alphabetical order. */
    const line = ["w5", "w4", "w3", "w2", "w1"];
    for (const [i, holder] of line.entries()) {
      expect(await (i % 2 === 0 ? a : b).acquire(k, holder, opts(1))).toBe(false);
    }
    await a.release(k, "a1");
    for (const [i, holder] of line.entries()) {
      /** Everyone behind the head of the line is refused, then the head gets it. */
      for (const later of line.slice(i + 1)) {
        expect(await b.acquire(k, later, opts(1))).toBe(false);
      }
      expect(await a.acquire(k, holder, opts(1))).toBe(true);
      await a.release(k, holder);
    }
  });

  test("a waiter that stops asking loses its place", async () => {
    const [a, b] = impl.pair();
    const k = unique("mx");
    expect(await a.acquire(k, "a1", opts(1))).toBe(true);
    expect(await b.acquire(k, "gone", opts(1, 60_000, 150))).toBe(false);
    await a.release(k, "a1");
    expect(await a.acquire(k, "late", opts(1))).toBe(false);
    await Bun.sleep(250);
    expect(await a.acquire(k, "late", opts(1))).toBe(true);
  });

  test("a release takes the holder out of the line too", async () => {
    const [a, b] = impl.pair();
    const k = unique("mx");
    expect(await a.acquire(k, "a1", opts(1))).toBe(true);
    expect(await b.acquire(k, "quitter", opts(1))).toBe(false);
    await b.release(k, "quitter");
    await a.release(k, "a1");
    expect(await a.acquire(k, "next", opts(1))).toBe(true);
  });

  test("a parallel burst from two replicas gets exactly max slots", async () => {
    const [a, b] = impl.pair();
    const k = unique("burst");
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        (i % 2 === 0 ? a : b).acquire(k, `h${i}`, opts(3)),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(3);
  });

  test("holders polling from two replicas never pass the limit", async () => {
    const [a, b] = impl.pair();
    const k = unique("poll");
    const max = 2;
    let active = 0;
    let peak = 0;
    let done = 0;
    await Promise.all(
      Array.from({ length: 12 }, async (_, i) => {
        const store = i % 2 === 0 ? a : b;
        const holder = `w${i}`;
        while (!(await store.acquire(k, holder, opts(max, 60_000, 2_000)))) {
          await Bun.sleep(5);
        }
        active += 1;
        peak = Math.max(peak, active);
        await Bun.sleep(10);
        active -= 1;
        await store.release(k, holder);
        done += 1;
      }),
    );
    expect(done).toBe(12);
    expect(peak).toBe(max);
  });
}

describe("in-memory semaphore", () => {
  contract(memory);

  test("prune drops lapsed leases and places, and empty keys", async () => {
    const s = new MemorySlotSemaphore();
    await s.acquire("k", "short", opts(1, 50));
    await s.acquire("k", "waiter", opts(1, 60_000, 50));
    await s.acquire("long", "held", opts(1));
    await Bun.sleep(100);
    expect(s.prune()).toBe(2);
    expect([...s.entries.keys()]).toEqual(["long"]);
  });

  test("the shared-store sweep reaches every semaphore's memory", async () => {
    const slots = sharedSlotSemaphore(unique("sweep"));
    await slots.local.acquire("k", "short", opts(1, 50));
    await Bun.sleep(100);
    expect(pruneLocalCounters()).toBeGreaterThanOrEqual(1);
    expect(slots.local.entries.size).toBe(0);
  });
});

describe.skipIf(!REDIS_TEST_URL)("Redis semaphore (REDIS_TEST_URL)", () => {
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

  test("every key expires with its latest lease or place", async () => {
    const [a, b] = redis.pair();
    const k = unique("ttl");
    await a.acquire(k, "a1", opts(1, 30_000, 5_000));
    await b.acquire(k, "b1", opts(1, 30_000, 5_000));
    const names = await keysWith(k);
    expect(names.map((n) => n.slice(-2)).toSorted()).toEqual([":h", ":q", ":w"]);
    for (const name of names) {
      const ttl = await raw().pttl(name);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(name.endsWith(":h") ? 30_000 : 5_000);
    }
  });

  test("nothing is left once every holder released", async () => {
    const [a, b] = redis.pair();
    const k = unique("empty");
    await a.acquire(k, "a1", opts(1));
    await b.acquire(k, "b1", opts(1));
    await a.release(k, "a1");
    await b.release(k, "b1");
    expect(await keysWith(k)).toEqual([]);
  });
});
