import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { RedisClient } from "bun";
import { createHash, randomBytes } from "crypto";
import {
  MemoryOneTimeStore,
  MemoryWindowCounter,
  SharedStoreError,
  pruneLocalCounters,
  sharedOneTimeStore,
  sharedStoreErrorCode,
  sharedWindowCounter,
  useSharedBackend,
  type OneTimeStore,
  type SharedStoreBackend,
  type WindowCounter,
} from "../../src/utils/shared-store.ts";
import { MemorySlotSemaphore } from "../../src/utils/shared-slots.ts";
import { MemoryTokenBuckets } from "../../src/utils/shared-tokens.ts";
import { connectRedisBackend, describeRedisUrl } from "../../src/utils/redis-store.ts";
import { logger } from "../../src/utils/logger.ts";

/**
 * The shared stores (#185): one contract, run against the in-memory
 * implementation always and against Redis when `REDIS_TEST_URL` is set
 * (for example `REDIS_TEST_URL=redis://127.0.0.1:6390 bun test
 * test/unit/shared-store.test.ts` with a throwaway `redis:7-alpine`).
 * Without it the Redis suites are skipped, so CI and other machines need
 * no Redis. Windows are short and real (the Redis clock is the server's).
 */

const REDIS_TEST_URL = process.env["REDIS_TEST_URL"];

/** A random 32-byte key, as `DKIM_ENCRYPTION_KEY` would be. */
const SECRET_KEY = randomBytes(32);

/** Every key of this run lives under its own prefix, removed at the end. */
const PREFIX = `bunmail-test:${randomBytes(6).toString("hex")}:`;

/** A fresh, unique key name. */
function key(name: string): string {
  return `${name}:${randomBytes(4).toString("hex")}`;
}

/** A store pair under test; `fresh` gives stores no other test touches. */
interface Implementation {
  counter(): WindowCounter;
  oneTime(): OneTimeStore;
}

let redisBackend: SharedStoreBackend | null = null;
let redisRaw: RedisClient | null = null;
let namespaceSeq = 0;

const memory: Implementation = {
  counter: () => new MemoryWindowCounter(),
  oneTime: () => new MemoryOneTimeStore(1000),
};

const redis: Implementation = {
  counter: () => {
    if (!redisBackend) throw new Error("no Redis backend");
    namespaceSeq += 1;
    return redisBackend.counter(`ns${namespaceSeq}`);
  },
  oneTime: () => {
    if (!redisBackend) throw new Error("no Redis backend");
    namespaceSeq += 1;
    return redisBackend.oneTime(`ns${namespaceSeq}`);
  },
};

beforeAll(async () => {
  if (!REDIS_TEST_URL) return;
  redisBackend = await connectRedisBackend(REDIS_TEST_URL, {
    secretKey: SECRET_KEY,
    keyPrefix: PREFIX,
  });
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
  redisBackend?.close();
});

/** The window and one-time contract, for one implementation. */
function contract(impl: Implementation): void {
  describe("window counter", () => {
    const WINDOW = 60_000;

    test("counts up to max, then refuses without counting", async () => {
      const c = impl.counter();
      const k = key("a");
      for (let i = 1; i <= 3; i++) {
        expect(await c.take([k], { max: 3, windowMs: WINDOW })).toMatchObject({
          limited: false,
          count: i,
        });
      }
      const refused = await c.take([k], { max: 3, windowMs: WINDOW });
      expect(refused.limited).toBe(true);
      if (!refused.limited) return;
      expect(refused.count).toBe(3);
      expect(refused.retryAfterMs).toBeGreaterThan(WINDOW - 5_000);
      expect(refused.retryAfterMs).toBeLessThanOrEqual(WINDOW);
      expect((await c.peek(k))?.count).toBe(3);
    });

    test("weights, and a refused request that still counts once", async () => {
      const c = impl.counter();
      const k = key("w");
      const opts = { max: 5, windowMs: WINDOW, refusedWeight: 1 };
      expect(await c.take([k], { ...opts, weight: 3 })).toMatchObject({
        limited: false,
        count: 3,
      });
      expect((await c.take([k], { ...opts, weight: 3 })).limited).toBe(true);
      expect((await c.peek(k))?.count).toBe(4);
      expect(await c.take([k], opts)).toMatchObject({ limited: false, count: 5 });
      expect((await c.take([k], opts)).limited).toBe(true);
    });

    test("a request heavier than max on a fresh key is refused and starts a window", async () => {
      const c = impl.counter();
      const k = key("heavy");
      const refused = await c.take([k], {
        max: 2,
        windowMs: WINDOW,
        weight: 3,
        refusedWeight: 1,
      });
      expect(refused).toMatchObject({ limited: true, count: 1 });
      const window = await c.peek(k);
      expect(window?.count).toBe(1);
      expect(window?.resetInMs).toBeGreaterThan(WINDOW - 5_000);
    });

    test("several keys: one spent key refuses and nothing is counted", async () => {
      const c = impl.counter();
      const spent = key("spent");
      const other = key("other");
      await c.take([spent], { max: 1, windowMs: WINDOW });
      expect((await c.take([spent, other], { max: 1, windowMs: WINDOW })).limited).toBe(
        true,
      );
      expect(await c.peek(other)).toBeNull();
      const a = key("a");
      const b = key("b");
      expect(await c.take([a, b], { max: 2, windowMs: WINDOW })).toMatchObject({
        limited: false,
        count: 1,
      });
      expect((await c.peek(a))?.count).toBe(1);
      expect((await c.peek(b))?.count).toBe(1);
    });

    test("a parallel burst passes exactly max", async () => {
      const c = impl.counter();
      const k = key("burst");
      const results = await Promise.all(
        Array.from({ length: 50 }, () => c.take([k], { max: 10, windowMs: WINDOW })),
      );
      expect(results.filter((r) => !r.limited)).toHaveLength(10);
      expect((await c.peek(k))?.count).toBe(10);
    });

    test("a window ends after windowMs, and the next request starts a new one", async () => {
      const c = impl.counter();
      const k = key("expiry");
      await c.take([k], { max: 1, windowMs: 150 });
      expect((await c.take([k], { max: 1, windowMs: 150 })).limited).toBe(true);
      await Bun.sleep(250);
      expect(await c.peek(k)).toBeNull();
      expect(await c.take([k], { max: 1, windowMs: 150 })).toMatchObject({
        limited: false,
        count: 1,
      });
    });

    test("peek: null without a window, else count and time left", async () => {
      const c = impl.counter();
      const k = key("peek");
      expect(await c.peek(k)).toBeNull();
      await c.take([k], { max: 9, windowMs: WINDOW, weight: 2 });
      const window = await c.peek(k);
      expect(window?.count).toBe(2);
      expect(window?.resetInMs).toBeGreaterThan(0);
      expect(window?.resetInMs).toBeLessThanOrEqual(WINDOW);
    });

    test("refund: one back, never below zero, no window started", async () => {
      const c = impl.counter();
      const k = key("refund");
      const first = await c.take([k], { max: 9, windowMs: WINDOW });
      await c.take([k], { max: 9, windowMs: WINDOW });
      const id = first.windows.get(k);
      if (id === undefined) throw new Error("no window id");
      await c.refund(k, id);
      expect((await c.peek(k))?.count).toBe(1);
      await c.refund(k, id);
      await c.refund(k, id);
      expect((await c.peek(k))?.count).toBe(0);
      const none = key("none");
      await c.refund(none, id);
      expect(await c.peek(none)).toBeNull();
    });

    test("take names each key's window: the same id within a window, a new one after", async () => {
      const c = impl.counter();
      const a = key("ida");
      const b = key("idb");
      const first = await c.take([a, b], { max: 9, windowMs: 150 });
      const second = await c.take([a], { max: 9, windowMs: 150 });
      expect(first.windows.get(a)).toBeDefined();
      expect(first.windows.get(a)).toBe(second.windows.get(a));
      /** Ids are per key: two keys may share one, a refund names its key too. */
      expect(first.windows.get(b)).toBeDefined();
      /** A refused take that counts nothing names no window for a fresh key. */
      const fresh = key("idfresh");
      const refused = await c.take([a, fresh], { max: 2, windowMs: 150 });
      expect(refused.limited).toBe(true);
      expect(refused.windows.has(fresh)).toBe(false);
      await Bun.sleep(250);
      const next = await c.take([a], { max: 9, windowMs: 150 });
      expect(next.windows.get(a)).not.toBe(first.windows.get(a));
    });

    test("a refund with an ended window's id never reaches the next window", async () => {
      const c = impl.counter();
      const k = key("late");
      const taken = await c.take([k], { max: 9, windowMs: 150 });
      const id = taken.windows.get(k);
      if (id === undefined) throw new Error("no window id");
      await Bun.sleep(250);
      await c.take([k], { max: 9, windowMs: 60_000 });
      await c.refund(k, id);
      expect((await c.peek(k))?.count).toBe(1);
      await c.refund(k, "not-a-window");
      expect((await c.peek(k))?.count).toBe(1);
    });

    test("delete forgets the keys", async () => {
      const c = impl.counter();
      const a = key("del-a");
      const b = key("del-b");
      await c.take([a, b], { max: 9, windowMs: WINDOW });
      await c.delete([a, b]);
      expect(await c.peek(a)).toBeNull();
      expect(await c.peek(b)).toBeNull();
      await c.delete([]);
    });

    test("markOnce: once per live window", async () => {
      const c = impl.counter();
      const k = key("mark");
      expect(await c.markOnce(k)).toBe(false);
      await c.take([k], { max: 9, windowMs: 150 });
      expect(await c.markOnce(k)).toBe(true);
      expect(await c.markOnce(k)).toBe(false);
      await Bun.sleep(250);
      expect(await c.markOnce(k)).toBe(false);
      await c.take([k], { max: 9, windowMs: 150 });
      expect(await c.markOnce(k)).toBe(true);
    });

    test("two counters never share keys", async () => {
      const a = impl.counter();
      const b = impl.counter();
      await a.take(["same"], { max: 1, windowMs: WINDOW });
      expect(await b.peek("same")).toBeNull();
    });
  });

  describe("one-time store", () => {
    test("the matching guard takes it once", async () => {
      const s = impl.oneTime();
      const k = key("tok");
      await s.put(k, { guard: "g1", value: "secret-1" }, 60_000);
      expect(await s.take(k, "g1")).toEqual({ status: "taken", value: "secret-1" });
      expect(await s.take(k, "g1")).toEqual({ status: "missing" });
    });

    test("a wrong guard gets the stored guard back and leaves the entry", async () => {
      const s = impl.oneTime();
      const k = key("tok");
      await s.put(k, { guard: "owner", value: "secret-2" }, 60_000);
      expect(await s.take(k, "intruder")).toEqual({ status: "mismatch", guard: "owner" });
      expect(await s.take(k, "owner")).toEqual({ status: "taken", value: "secret-2" });
    });

    test("unknown and expired entries are missing", async () => {
      const s = impl.oneTime();
      expect(await s.take(key("unknown"), "g")).toEqual({ status: "missing" });
      const k = key("short");
      await s.put(k, { guard: "g", value: "v" }, 100);
      await Bun.sleep(200);
      expect(await s.take(k, "g")).toEqual({ status: "missing" });
    });

    test("concurrent takes: exactly one gets the value", async () => {
      const s = impl.oneTime();
      const k = key("race");
      await s.put(k, { guard: "g", value: "only-once" }, 60_000);
      const results = await Promise.all(Array.from({ length: 10 }, () => s.take(k, "g")));
      expect(results.filter((r) => r.status === "taken")).toHaveLength(1);
    });

    test("claim (#224): true once while the key lives, then again once it expired", async () => {
      const s = impl.oneTime();
      const k = key("claim");
      expect(await s.claim(k, 150)).toBe(true);
      expect(await s.claim(k, 150)).toBe(false);
      await Bun.sleep(250);
      expect(await s.claim(k, 60_000)).toBe(true);
    });

    test("claim: concurrent claims of one key, exactly one wins", async () => {
      const s = impl.oneTime();
      const k = key("claim-race");
      const wins = await Promise.all(
        Array.from({ length: 10 }, () => s.claim(k, 60_000)),
      );
      expect(wins.filter(Boolean)).toHaveLength(1);
    });

    test("claim: a stored entry blocks the claim of its key", async () => {
      const s = impl.oneTime();
      const k = key("claim-held");
      await s.put(k, { guard: "g", value: "v" }, 60_000);
      expect(await s.claim(k, 60_000)).toBe(false);
      expect(await s.take(k, "g")).toEqual({ status: "taken", value: "v" });
    });

    test("a value with newlines and unicode round-trips", async () => {
      const s = impl.oneTime();
      const k = key("codes");
      const value = "abcd-efgh\nijkl-mnop\né\u{1F511}";
      await s.put(k, { guard: '["recovery_codes","usr_1","ses_1"]', value }, 60_000);
      expect(await s.take(k, '["recovery_codes","usr_1","ses_1"]')).toEqual({
        status: "taken",
        value,
      });
    });
  });
}

describe("in-memory stores", () => {
  contract(memory);

  test("the one-time store evicts the oldest entry past its cap", async () => {
    const s = new MemoryOneTimeStore(2);
    await s.put("a", { guard: "g", value: "1" }, 60_000);
    await s.put("b", { guard: "g", value: "2" }, 60_000);
    await s.put("c", { guard: "g", value: "3" }, 60_000);
    expect(await s.take("a", "g")).toEqual({ status: "missing" });
    expect(await s.take("c", "g")).toEqual({ status: "taken", value: "3" });
  });

  test("claim (#224): a store full of live entries refuses, never evicts a live claim", async () => {
    const s = new MemoryOneTimeStore(2);
    expect(await s.claim("a", 60_000)).toBe(true);
    expect(await s.claim("b", 60_000)).toBe(true);
    const error = await s.claim("c", 60_000).catch((e: unknown) => e);
    expect(sharedStoreErrorCode(error)).toBe("ONE_TIME_FULL");
    /** Both live claims still hold. */
    expect(await s.claim("a", 60_000)).toBe(false);
    expect(await s.claim("b", 60_000)).toBe(false);
  });

  test("claim: expired entries are swept to make room", async () => {
    const s = new MemoryOneTimeStore(2);
    expect(await s.claim("short", 50)).toBe(true);
    expect(await s.claim("long", 60_000)).toBe(true);
    await Bun.sleep(100);
    expect(await s.claim("new", 60_000)).toBe(true);
    expect(s.entries.has("short")).toBe(false);
    expect(await s.claim("long", 60_000)).toBe(false);
  });

  test("prune drops only ended windows", async () => {
    const c = new MemoryWindowCounter();
    await c.take(["short"], { max: 9, windowMs: 50 });
    await c.take(["long"], { max: 9, windowMs: 60_000 });
    await Bun.sleep(100);
    expect(c.prune()).toBe(1);
    expect(c.entries.has("long")).toBe(true);
  });
});

describe.skipIf(!REDIS_TEST_URL)("Redis stores (REDIS_TEST_URL)", () => {
  contract(redis);

  /** The raw client, for looking at what Redis holds. */
  function raw(): RedisClient {
    if (!redisRaw) throw new Error("no raw Redis client");
    return redisRaw;
  }

  test("every counter key expires with its window", async () => {
    const c = redis.counter();
    const k = key("ttl");
    await c.take([k], { max: 9, windowMs: 30_000 });
    const keys: unknown = await raw().send("KEYS", [`${PREFIX}*${k}`]);
    expect(Array.isArray(keys) && keys.length === 1).toBe(true);
    const name = Array.isArray(keys) ? keys[0] : undefined;
    if (typeof name !== "string") throw new Error("counter key not found");
    const ttl = await raw().pttl(name);
    expect(ttl).toBeGreaterThan(25_000);
    expect(ttl).toBeLessThanOrEqual(30_000);
  });

  test("a one-time entry is stored under the token's hash, encrypted, with a TTL", async () => {
    const s = redis.oneTime();
    const token = randomBytes(32).toString("hex");
    await s.put(token, { guard: "g", value: "bm_live_plaintext" }, 30_000);
    const all: unknown = await raw().send("KEYS", [`${PREFIX}*`]);
    const names = Array.isArray(all)
      ? all.filter((k): k is string => typeof k === "string")
      : [];
    expect(names.some((n) => n.includes(token))).toBe(false);
    const mine = [];
    for (const name of names) {
      const fields: unknown = await raw().send("HGETALL", [name]);
      if (JSON.stringify(fields).includes('"g"')) mine.push({ name, fields });
    }
    expect(mine.length).toBeGreaterThan(0);
    expect(JSON.stringify(mine)).not.toContain("bm_live_plaintext");
    for (const { name } of mine) expect(await raw().pttl(name)).toBeGreaterThan(0);
  });

  test("a ciphertext moved to another key or owner does not redeem", async () => {
    if (!redisBackend) throw new Error("no Redis backend");
    const ns = `move-${randomBytes(4).toString("hex")}`;
    const store = redisBackend.oneTime(ns);
    /** The Redis key of a token in this namespace. */
    const nameOf = (token: string): string =>
      `${PREFIX}${ns}:${createHash("sha256").update(token).digest("hex")}`;
    const victim = randomBytes(32).toString("hex");
    const attacker = randomBytes(32).toString("hex");
    await store.put(victim, { guard: "victim-guard", value: "bm_live_victim" }, 30_000);
    await store.put(attacker, { guard: "attacker-guard", value: "mine" }, 30_000);
    const stolen: unknown = await raw().send("HGET", [nameOf(victim), "v"]);
    if (typeof stolen !== "string") throw new Error("victim entry not found");

    /** Into the attacker's own entry: another key and another owner. */
    await raw().send("HSET", [nameOf(attacker), "v", stolen]);
    const moved = await store.take(attacker, "attacker-guard").catch((e: unknown) => e);
    expect(sharedStoreErrorCode(moved)).toBe("ONE_TIME_UNDECRYPTABLE");

    /** Guard and value together into another key: the key binding still fails. */
    const other = randomBytes(32).toString("hex");
    await raw().send("HSET", [nameOf(other), "g", "victim-guard", "v", stolen]);
    await raw().send("PEXPIRE", [nameOf(other), "30000"]);
    const rekeyed = await store.take(other, "victim-guard").catch((e: unknown) => e);
    expect(sharedStoreErrorCode(rekeyed)).toBe("ONE_TIME_UNDECRYPTABLE");

    /** Same key, owner rewritten to the attacker: the guard binding fails. */
    await raw().send("HSET", [nameOf(victim), "g", "attacker-guard"]);
    const reowned = await store.take(victim, "attacker-guard").catch((e: unknown) => e);
    expect(sharedStoreErrorCode(reowned)).toBe("ONE_TIME_UNDECRYPTABLE");
  });

  test("an entry encrypted with another key fails closed", async () => {
    if (!REDIS_TEST_URL) return;
    const other = await connectRedisBackend(REDIS_TEST_URL, {
      secretKey: randomBytes(32),
      keyPrefix: PREFIX,
    });
    try {
      const token = key("foreign");
      await other.oneTime("foreign").put(token, { guard: "g", value: "v" }, 30_000);
      const mine = redisBackend?.oneTime("foreign");
      if (!mine) throw new Error("no Redis backend");
      const error = await mine.take(token, "g").catch((e: unknown) => e);
      expect(sharedStoreErrorCode(error)).toBe("ONE_TIME_UNDECRYPTABLE");
    } finally {
      other.close();
    }
  });

  test("a counter written before window ids gets one on its next take", async () => {
    if (!redisBackend) throw new Error("no Redis backend");
    const ns = `legacy-${randomBytes(4).toString("hex")}`;
    const name = `${PREFIX}${ns}:ip`;
    await raw().send("HSET", [name, "c", "2"]);
    await raw().send("PEXPIRE", [name, "60000"]);
    const c = redisBackend.counter(ns);
    const taken = await c.take(["ip"], { max: 9, windowMs: 60_000 });
    const id = taken.windows.get("ip");
    expect(typeof id).toBe("string");
    await c.refund("ip", id ?? "");
    expect((await c.peek("ip"))?.count).toBe(2);
    expect(await raw().pttl(name)).toBeGreaterThan(50_000);
  });

  test("the shared facade uses Redis when installed: two replicas share one budget", async () => {
    if (!redisBackend) throw new Error("no Redis backend");
    const ns = `facade-${randomBytes(4).toString("hex")}`;
    const replicaA = sharedWindowCounter(ns);
    const replicaB = sharedWindowCounter(ns);
    useSharedBackend(redisBackend);
    try {
      await replicaA.take(["ip"], { max: 2, windowMs: 60_000 });
      await replicaB.take(["ip"], { max: 2, windowMs: 60_000 });
      expect((await replicaA.take(["ip"], { max: 2, windowMs: 60_000 })).limited).toBe(
        true,
      );
      /** Nothing went to process memory. */
      expect(replicaA.local.entries.size).toBe(0);
    } finally {
      useSharedBackend(null);
    }
  });
});

describe("backend selection and outage behaviour", () => {
  afterEach(() => {
    useSharedBackend(null);
  });

  /** A backend whose every operation fails, like Redis during an outage. */
  const down: SharedStoreBackend = {
    counter: () => ({
      take: () => Promise.reject(new SharedStoreError("REDIS_UNAVAILABLE", "down")),
      peek: () => Promise.reject(new SharedStoreError("REDIS_UNAVAILABLE", "down")),
      refund: () => Promise.reject(new SharedStoreError("REDIS_UNAVAILABLE", "down")),
      delete: () => Promise.reject(new SharedStoreError("REDIS_UNAVAILABLE", "down")),
      markOnce: () => Promise.reject(new SharedStoreError("REDIS_UNAVAILABLE", "down")),
    }),
    oneTime: () => ({
      put: () => Promise.reject(new SharedStoreError("REDIS_UNAVAILABLE", "down")),
      take: () => Promise.reject(new SharedStoreError("REDIS_UNAVAILABLE", "down")),
      claim: () => Promise.reject(new SharedStoreError("REDIS_UNAVAILABLE", "down")),
    }),
    slots: () => ({
      acquire: () => Promise.reject(new SharedStoreError("REDIS_UNAVAILABLE", "down")),
      renew: () => Promise.reject(new SharedStoreError("REDIS_UNAVAILABLE", "down")),
      release: () => Promise.reject(new SharedStoreError("REDIS_UNAVAILABLE", "down")),
    }),
    tokens: () => new MemoryTokenBuckets(),
    close: () => {},
  };

  test("the sweep drops ended windows from every counter's memory, and only those", async () => {
    const a = sharedWindowCounter(`sweep-a-${randomBytes(4).toString("hex")}`);
    const b = sharedWindowCounter(`sweep-b-${randomBytes(4).toString("hex")}`);
    await a.take(["short"], { max: 9, windowMs: 50 });
    await b.take(["short"], { max: 9, windowMs: 50 });
    await b.take(["long"], { max: 9, windowMs: 60_000 });
    await Bun.sleep(100);
    expect(pruneLocalCounters()).toBeGreaterThanOrEqual(2);
    expect(a.local.entries.size).toBe(0);
    expect([...b.local.entries.keys()]).toEqual(["long"]);
  });

  /** A healthy backend held in memory: what Redis is to several replicas. */
  function memoryBackend(): {
    backend: SharedStoreBackend;
    counter: MemoryWindowCounter;
  } {
    const counter = new MemoryWindowCounter();
    return {
      counter,
      backend: {
        counter: () => counter,
        oneTime: () => new MemoryOneTimeStore(10),
        slots: () => new MemorySlotSemaphore(),
        tokens: () => new MemoryTokenBuckets(),
        close: () => {},
      },
    };
  }

  /** The window id `decision` gives `key`. */
  function idOf(
    decision: { windows: ReadonlyMap<string, string> },
    name: string,
  ): string {
    const id = decision.windows.get(name);
    if (id === undefined) throw new Error("no window id");
    return id;
  }

  test("a refund goes to the store that counted the take, only while it is installed", async () => {
    const error = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const healthy = memoryBackend();
      const c = sharedWindowCounter(`refund-${randomBytes(4).toString("hex")}`);
      const opts = { max: 9, windowMs: 60_000 };

      /** Same backend: refunded there. */
      useSharedBackend(healthy.backend);
      const a = await c.take(["k"], opts);
      await c.take(["k"], opts);
      await c.refund("k", idOf(a, "k"));
      expect(healthy.counter.entries.get("k")?.count).toBe(1);

      /** The backend failed (or changed) since the take: skipped, nothing else touched. */
      const b = await c.take(["k"], opts);
      useSharedBackend(down);
      await c.refund("k", idOf(b, "k"));
      useSharedBackend(healthy.backend);
      await c.refund("k", idOf(b, "k"));
      useSharedBackend(null);
      await c.refund("k", idOf(b, "k"));
      expect(healthy.counter.entries.get("k")?.count).toBe(2);
      expect(c.local.entries.size).toBe(0);

      /** Taken in memory during an outage: refunded in memory, even after recovery. */
      useSharedBackend(down);
      const d = await c.take(["k"], opts);
      await c.take(["k"], opts);
      useSharedBackend(healthy.backend);
      await c.refund("k", idOf(d, "k"));
      expect(c.local.entries.get("k")?.count).toBe(1);
      expect(healthy.counter.entries.get("k")?.count).toBe(2);
    } finally {
      error.mockRestore();
    }
  });

  test("without a backend, process memory answers", async () => {
    const c = sharedWindowCounter("mem-only");
    await c.take(["k"], { max: 1, windowMs: 60_000 });
    expect(c.local.entries.get("k")?.count).toBe(1);
  });

  test("counters fall back to memory when the backend fails, logging once a minute", async () => {
    const error = spyOn(logger, "error").mockImplementation(() => {});
    error.mockClear();
    try {
      useSharedBackend(down);
      const c = sharedWindowCounter(`fallback-${randomBytes(4).toString("hex")}`);
      expect((await c.take(["ip"], { max: 1, windowMs: 60_000 })).limited).toBe(false);
      /** Still limited during the outage: the fallback counts. */
      expect((await c.take(["ip"], { max: 1, windowMs: 60_000 })).limited).toBe(true);
      expect(await c.markOnce("ip")).toBe(true);
      const lines = error.mock.calls.filter(([message]) =>
        message.startsWith("Shared store unavailable"),
      );
      expect(lines).toHaveLength(1);
      expect(lines[0]?.[1]).toMatchObject({ code: "REDIS_UNAVAILABLE" });
    } finally {
      error.mockRestore();
    }
  });

  test("one-time entries fail closed: the error reaches the caller", async () => {
    useSharedBackend(down);
    const s = sharedOneTimeStore("fail-closed", 10);
    const putError = await s
      .put("t", { guard: "g", value: "v" }, 60_000)
      .catch((e: unknown) => e);
    expect(sharedStoreErrorCode(putError)).toBe("REDIS_UNAVAILABLE");
    const takeError = await s.take("t", "g").catch((e: unknown) => e);
    expect(sharedStoreErrorCode(takeError)).toBe("REDIS_UNAVAILABLE");
    const claimError = await s.claim("t", 60_000).catch((e: unknown) => e);
    expect(sharedStoreErrorCode(claimError)).toBe("REDIS_UNAVAILABLE");
    expect(s.local.entries.size).toBe(0);
  });

  test("a Redis that does not answer refuses the boot, without the password in the error", async () => {
    const error = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const failure = await connectRedisBackend("redis://:s3cr3t-pass@127.0.0.1:1", {
        secretKey: SECRET_KEY,
      }).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(SharedStoreError);
      expect(String(failure)).not.toContain("s3cr3t-pass");
      expect(JSON.stringify(error.mock.calls)).not.toContain("s3cr3t-pass");
    } finally {
      error.mockRestore();
    }
  });
});

describe("describeRedisUrl", () => {
  test.each([
    ["redis://redis:6379", "redis://redis:6379"],
    ["redis://:pw@redis:6379/2", "redis://redis:6379/2"],
    ["rediss://user:pw@cache.example.com:6380", "rediss://cache.example.com:6380"],
    ["redis://localhost", "redis://localhost"],
  ])("%p is logged as %p", (url, shown) => {
    expect(describeRedisUrl(url)).toBe(shown);
  });
});

describe("sharedStoreErrorCode", () => {
  test("keeps codes, never messages", () => {
    expect(sharedStoreErrorCode(new SharedStoreError("REDIS_TIMEOUT", "x"))).toBe(
      "REDIS_TIMEOUT",
    );
    expect(
      sharedStoreErrorCode(
        Object.assign(new Error("Connection closed"), {
          code: "ERR_REDIS_CONNECTION_CLOSED",
        }),
      ),
    ).toBe("ERR_REDIS_CONNECTION_CLOSED");
    expect(sharedStoreErrorCode(new Error("WRONGTYPE Operation against a key"))).toBe(
      "WRONGTYPE",
    );
    expect(sharedStoreErrorCode(new Error("bunmail:rl:login:192.0.2.1 broke"))).toBe(
      "UNKNOWN",
    );
  });
});
