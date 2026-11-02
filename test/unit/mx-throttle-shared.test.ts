import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { RedisClient } from "bun";
import { randomBytes } from "crypto";
import {
  MemorySlotSemaphore,
  sharedSlotSemaphore,
} from "../../src/utils/shared-slots.ts";
import {
  MemoryOneTimeStore,
  MemoryWindowCounter,
  SharedStoreError,
  useSharedBackend,
  type SharedStoreBackend,
} from "../../src/utils/shared-store.ts";
import { MemoryTokenBuckets } from "../../src/utils/shared-tokens.ts";
import { connectRedisBackend } from "../../src/utils/redis-store.ts";
import {
  _resetLocks,
  _setMxSlotTiming,
  withMxLock,
} from "../../src/utils/mx-throttle.ts";
import { logger } from "../../src/utils/logger.ts";

/**
 * The shared slot facade (#185, part 3: store routing, outage fallback)
 * and the per-MX throttle on top of it with a shared store installed. The
 * store contract itself is in `shared-slots.test.ts`. "Another replica" is
 * a second client of the store this process uses: the same memory
 * semaphore, or, with `REDIS_TEST_URL` set, a second Redis connection.
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

let redisA: SharedStoreBackend | null = null;
let redisB: SharedStoreBackend | null = null;
let redisRaw: RedisClient | null = null;

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
  _setMxSlotTiming(null);
  _resetLocks();
});

describe("the shared facade", () => {
  /** A backend whose every operation fails, like Redis during an outage. */
  const down: SharedStoreBackend = {
    counter: () => new MemoryWindowCounter(),
    oneTime: () => new MemoryOneTimeStore(10),
    slots: () => ({
      acquire: () => Promise.reject(new SharedStoreError("REDIS_UNAVAILABLE", "down")),
      renew: () => Promise.reject(new SharedStoreError("REDIS_UNAVAILABLE", "down")),
      release: () => Promise.reject(new SharedStoreError("REDIS_UNAVAILABLE", "down")),
    }),
    tokens: () => new MemoryTokenBuckets(),
    close: () => {},
  };

  /** A healthy backend held in memory: what Redis is to several replicas. */
  function healthyBackend(): { backend: SharedStoreBackend; slots: MemorySlotSemaphore } {
    const slots = new MemorySlotSemaphore();
    return {
      slots,
      backend: {
        counter: () => new MemoryWindowCounter(),
        oneTime: () => new MemoryOneTimeStore(10),
        slots: () => slots,
        tokens: () => new MemoryTokenBuckets(),
        close: () => {},
      },
    };
  }

  test("is not shared without a backend, and shared with one", () => {
    const s = sharedSlotSemaphore(unique("ns"));
    expect(s.isShared()).toBe(false);
    useSharedBackend(healthyBackend().backend);
    expect(s.isShared()).toBe(true);
  });

  test("an outage falls back to memory, logging once a minute", async () => {
    const error = spyOn(logger, "error").mockImplementation(() => {});
    error.mockClear();
    try {
      useSharedBackend(down);
      const s = sharedSlotSemaphore(unique("fallback"));
      expect(await s.acquire("k", "h1", opts(1))).toBe("l");
      /** The fallback still counts: one slot per replica. */
      expect(await s.acquire("k", "h2", opts(1))).toBeNull();
      expect(await s.renew("k", "h1", "l", 60_000)).toBe("renewed");
      await s.release("k", "h1", "l");
      expect(await s.acquire("k", "h2", opts(1))).toBe("l");
      const lines = error.mock.calls.filter(([message]) =>
        message.startsWith("Shared store unavailable"),
      );
      expect(lines).toHaveLength(1);
      expect(lines[0]?.[1]).toMatchObject({ code: "REDIS_UNAVAILABLE" });
    } finally {
      error.mockRestore();
    }
  });

  test("renewals and releases go to the store that granted, only while installed", async () => {
    const error = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const healthy = healthyBackend();
      let failing = false;
      const flaky: SharedStoreBackend = {
        ...healthy.backend,
        slots: () => (failing ? down.slots("x") : healthy.slots),
      };
      const s = sharedSlotSemaphore(unique("route"));
      useSharedBackend(flaky);
      const grant = await s.acquire("k", "h1", opts(1));
      expect(grant).toMatch(/^s\d+$/);
      if (grant === null) throw new Error("not granted");
      expect(healthy.slots.entries.get("k")?.holders.has("h1")).toBe(true);
      expect(await s.renew("k", "h1", grant, 60_000)).toBe("renewed");

      /** The installed store fails now: the lease may still be live, so not lost. */
      failing = true;
      expect(await s.renew("k", "h1", grant, 60_000)).toBe("unavailable");
      await s.release("k", "h1", grant);
      failing = false;

      /** Another backend since the grant: lost, and never released elsewhere. */
      useSharedBackend(down);
      expect(await s.renew("k", "h1", grant, 60_000)).toBe("lost");
      await s.release("k", "h1", grant);

      /** Even the same store installed again is another generation: left to lapse. */
      useSharedBackend(flaky);
      expect(await s.renew("k", "h1", grant, 60_000)).toBe("lost");
      await s.release("k", "h1", grant);
      expect(healthy.slots.entries.get("k")?.holders.has("h1")).toBe(true);
      expect(s.local.entries.size).toBe(0);
    } finally {
      error.mockRestore();
    }
  });

  test("a failed acquire gives back what it may have been granted", async () => {
    const error = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const released: string[] = [];
      const timedOut: SharedStoreBackend = {
        ...down,
        slots: () => ({
          acquire: () => Promise.reject(new SharedStoreError("REDIS_TIMEOUT", "late")),
          renew: () => Promise.resolve(false),
          release: (_key, holder) => {
            released.push(holder);
            return Promise.resolve();
          },
        }),
      };
      useSharedBackend(timedOut);
      const s = sharedSlotSemaphore(unique("timeout"));
      expect(await s.acquire("k", "h1", opts(1))).toBe("l");
      expect(released).toEqual(["h1"]);
    } finally {
      error.mockRestore();
    }
  });
});

describe("withMxLock with a shared store", () => {
  /** The store's semaphore of the MX buckets, as every replica sees it. */
  function install(): MemorySlotSemaphore {
    const slots = new MemorySlotSemaphore();
    useSharedBackend({
      counter: () => new MemoryWindowCounter(),
      oneTime: () => new MemoryOneTimeStore(10),
      slots: () => slots,
      tokens: () => new MemoryTokenBuckets(),
      close: () => {},
    });
    return slots;
  }

  test("waits while another replica holds the bucket's only slot", async () => {
    _setMxSlotTiming({ pollMinMs: 5, pollMaxMs: 10 });
    const store = install();
    expect(await store.acquire("bucket", "replica-b", opts(1))).toBe(true);
    const events: string[] = [];
    const run = withMxLock("bucket", 1, async () => {
      events.push("a-start");
      /** Held in the store under this replica's holder id while fn runs. */
      const holders = [...(store.entries.get("bucket")?.holders.keys() ?? [])];
      expect(holders).toHaveLength(1);
      expect(holders[0]).not.toBe("replica-b");
    });
    await Bun.sleep(60);
    events.push("b-release");
    await store.release("bucket", "replica-b");
    await run;
    expect(events).toEqual(["b-release", "a-start"]);
    /** Released at the end: the key is gone. */
    expect(store.entries.has("bucket")).toBe(false);
  });

  test("a crashed replica's slot frees itself when its lease lapses", async () => {
    _setMxSlotTiming({ pollMinMs: 5, pollMaxMs: 10 });
    const store = install();
    expect(await store.acquire("bucket", "crashed", opts(1, 100))).toBe(true);
    const startedAt = Date.now();
    await withMxLock("bucket", 1, async () => {});
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(90);
  });

  test("a long session keeps its slot by renewing the lease", async () => {
    _setMxSlotTiming({ leaseMs: 80, renewMs: 20, pollMinMs: 5, pollMaxMs: 10 });
    const store = install();
    const refusedDuring: boolean[] = [];
    await withMxLock("bucket", 1, async () => {
      for (let i = 0; i < 4; i++) {
        await Bun.sleep(60);
        refusedDuring.push(
          !(await store.acquire("bucket", `other-${i}`, opts(1, 80, 1))),
        );
      }
    });
    /** 240 ms in a lease of 80 ms: another replica was refused every time. */
    expect(refusedDuring).toEqual([true, true, true, true]);
  });

  test("a lost lease is logged and the session goes on", async () => {
    _setMxSlotTiming({ leaseMs: 40, renewMs: 15, pollMinMs: 5, pollMaxMs: 10 });
    const store = install();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    warn.mockClear();
    try {
      const value = await withMxLock("bucket", 1, async () => {
        /** Another replica's script dropped this lease (as a lapse would). */
        for (const holder of store.entries.get("bucket")?.holders.keys() ?? []) {
          await store.release("bucket", holder);
        }
        await Bun.sleep(60);
        return 7;
      });
      expect(value).toBe(7);
      const lines = warn.mock.calls.filter(([message]) =>
        message.startsWith("MX slot lease lost"),
      );
      expect(lines).toHaveLength(1);
      expect(lines[0]?.[1]).toEqual({ bucket: "bucket" });
    } finally {
      warn.mockRestore();
    }
  });

  test("callers of two replicas never pass the limit together", async () => {
    _setMxSlotTiming({ pollMinMs: 2, pollMaxMs: 5 });
    const store = install();
    const max = 2;
    let active = 0;
    let peak = 0;
    /** This replica, through withMxLock. */
    const local = Array.from({ length: 6 }, () =>
      withMxLock("bucket", max, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await Bun.sleep(10);
        active -= 1;
      }),
    );
    /** Another replica, straight on the store. */
    const remote = Array.from({ length: 6 }, async (_, i) => {
      const holder = `remote-${i}`;
      while (!(await store.acquire("bucket", holder, opts(max, 60_000, 2_000)))) {
        await Bun.sleep(3);
      }
      active += 1;
      peak = Math.max(peak, active);
      await Bun.sleep(10);
      active -= 1;
      await store.release("bucket", holder);
    });
    await Promise.all([...local, ...remote]);
    expect(peak).toBe(max);
    expect(store.entries.has("bucket")).toBe(false);
  });

  test("during an outage the local limit still holds and fn runs", async () => {
    const error = spyOn(logger, "error").mockImplementation(() => {});
    try {
      useSharedBackend({
        counter: () => new MemoryWindowCounter(),
        oneTime: () => new MemoryOneTimeStore(10),
        slots: () => ({
          acquire: () =>
            Promise.reject(new SharedStoreError("REDIS_UNAVAILABLE", "down")),
          renew: () => Promise.reject(new SharedStoreError("REDIS_UNAVAILABLE", "down")),
          release: () =>
            Promise.reject(new SharedStoreError("REDIS_UNAVAILABLE", "down")),
        }),
        tokens: () => new MemoryTokenBuckets(),
        close: () => {},
      });
      const events: string[] = [];
      await Promise.all([
        withMxLock("bucket", 1, async () => {
          events.push("1-start");
          await Bun.sleep(20);
          events.push("1-end");
        }),
        withMxLock("bucket", 1, async () => {
          events.push("2-start");
        }),
      ]);
      expect(events).toEqual(["1-start", "1-end", "2-start"]);
    } finally {
      error.mockRestore();
    }
  });
});

describe.skipIf(!REDIS_TEST_URL)("withMxLock with Redis (REDIS_TEST_URL)", () => {
  test("withMxLock waits for a slot another replica holds in Redis", async () => {
    if (!redisA || !redisB) throw new Error("no Redis backend");
    _setMxSlotTiming({ pollMinMs: 10, pollMaxMs: 20 });
    useSharedBackend(redisA);
    const bucket = unique("bucket");
    /** Replica B holds the only slot; this process is replica A. */
    const other = redisB.slots("slots:mx");
    expect(await other.acquire(bucket, "replica-b", opts(1))).toBe(true);
    const events: string[] = [];
    const run = withMxLock(bucket, 1, async () => {
      events.push("a-start");
    });
    await Bun.sleep(100);
    events.push("b-release");
    await other.release(bucket, "replica-b");
    await run;
    expect(events).toEqual(["b-release", "a-start"]);
    /** And A released its slot: B gets it at once. */
    expect(await other.acquire(bucket, "replica-b-again", opts(1))).toBe(true);
    await other.release(bucket, "replica-b-again");
  });
});
