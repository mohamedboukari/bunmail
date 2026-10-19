import { describe, test, expect, beforeEach } from "bun:test";
import {
  MX_ANSWER_TTL_MS,
  MX_CACHE_MAX_ENTRIES,
  MX_ERROR_TTL_MS,
  clearMxCache,
  mxCacheSize,
  mxPointsHere,
  type MxCheckDeps,
} from "../../src/modules/bounces/services/return-path-mx.ts";

/**
 * Signed return paths only for domains whose MX points at this server
 * (#236): the decision and its per-domain cache, with a stubbed resolver
 * and clock.
 */

const HOST = "mail.bunmail.test";

/** What the stub resolver answers for every domain. */
type Answer = Array<{ exchange: string }> | { code: string } | "hang";

/** A resolver stub that counts queries, with a controllable clock. */
function stub(
  answer: Answer,
): MxCheckDeps & { queries: string[]; advance: (ms: number) => void } {
  let clock = 1_000_000;
  const queries: string[] = [];
  let current = answer;
  return {
    queries,
    advance: (ms) => {
      clock += ms;
    },
    now: () => clock,
    timeoutMs: 50,
    resolveMx: (domain) => {
      queries.push(domain);
      if (current === "hang") return new Promise(() => {});
      if (!Array.isArray(current)) {
        const code = current.code;
        return Promise.reject(Object.assign(new Error(`queryMx ${code}`), { code }));
      }
      const records = current;
      current = answer;
      return Promise.resolve(records);
    },
  };
}

beforeEach(() => {
  clearMxCache();
});

describe("mxPointsHere: the decision", () => {
  test("an MX set that names this host: yes", async () => {
    const deps = stub([{ exchange: "backup.example.net" }, { exchange: HOST }]);
    expect(await mxPointsHere("acme.io", HOST, deps)).toBe(true);
  });

  test("an MX set that does not name this host: no", async () => {
    const deps = stub([
      { exchange: "aspmx.l.google.com" },
      { exchange: "alt1.aspmx.l.google.com" },
    ]);
    expect(await mxPointsHere("acme.io", HOST, deps)).toBe(false);
  });

  test("case and trailing dots are ignored on both sides", async () => {
    expect(
      await mxPointsHere(
        "ACME.io.",
        `${HOST.toUpperCase()}.`,
        stub([{ exchange: "Mail.BunMail.Test." }]),
      ),
    ).toBe(true);
  });

  test("a host that only shares a suffix does not count", async () => {
    expect(await mxPointsHere("acme.io", HOST, stub([{ exchange: `x${HOST}` }]))).toBe(
      false,
    );
    expect(
      await mxPointsHere("other.io", HOST, stub([{ exchange: `${HOST}.evil.net` }])),
    ).toBe(false);
  });

  test("NXDOMAIN, no MX records, an empty set or a null MX: no", async () => {
    expect(await mxPointsHere("a.io", HOST, stub({ code: "ENOTFOUND" }))).toBe(false);
    expect(await mxPointsHere("b.io", HOST, stub({ code: "ENODATA" }))).toBe(false);
    expect(await mxPointsHere("c.io", HOST, stub([]))).toBe(false);
    expect(await mxPointsHere("d.io", HOST, stub([{ exchange: "" }]))).toBe(false);
  });

  test("a DNS error or a timeout: no (plain envelope, fail safe)", async () => {
    expect(await mxPointsHere("a.io", HOST, stub({ code: "ESERVFAIL" }))).toBe(false);
    expect(await mxPointsHere("b.io", HOST, stub({ code: "ETIMEOUT" }))).toBe(false);
    expect(await mxPointsHere("c.io", HOST, stub("hang"))).toBe(false);
  });

  test("no domain or no hostname: no, without a query", async () => {
    const deps = stub([{ exchange: HOST }]);
    expect(await mxPointsHere("", HOST, deps)).toBe(false);
    expect(await mxPointsHere("acme.io", " ", deps)).toBe(false);
    expect(deps.queries).toEqual([]);
  });
});

describe("mxPointsHere: the cache", () => {
  test("a yes is cached for an hour, then asked again", async () => {
    const deps = stub([{ exchange: HOST }]);
    expect(await mxPointsHere("acme.io", HOST, deps)).toBe(true);
    deps.advance(MX_ANSWER_TTL_MS - 1);
    expect(await mxPointsHere("ACME.IO", HOST, deps)).toBe(true);
    expect(deps.queries).toHaveLength(1);
    deps.advance(1);
    expect(await mxPointsHere("acme.io", HOST, deps)).toBe(true);
    expect(deps.queries).toHaveLength(2);
  });

  test("a no (including NXDOMAIN) is cached for an hour", async () => {
    const deps = stub({ code: "ENOTFOUND" });
    await mxPointsHere("gone.io", HOST, deps);
    deps.advance(MX_ERROR_TTL_MS + 1);
    await mxPointsHere("gone.io", HOST, deps);
    expect(deps.queries).toHaveLength(1);
    deps.advance(MX_ANSWER_TTL_MS);
    await mxPointsHere("gone.io", HOST, deps);
    expect(deps.queries).toHaveLength(2);
  });

  test("an error is cached for five minutes only (so it is logged once per period)", async () => {
    const deps = stub({ code: "ESERVFAIL" });
    await mxPointsHere("flaky.io", HOST, deps);
    deps.advance(MX_ERROR_TTL_MS - 1);
    await mxPointsHere("flaky.io", HOST, deps);
    expect(deps.queries).toHaveLength(1);
    deps.advance(1);
    await mxPointsHere("flaky.io", HOST, deps);
    expect(deps.queries).toHaveLength(2);
  });

  test("an answer that changes is picked up after the TTL", async () => {
    const deps = stub([{ exchange: "elsewhere.example.net" }]);
    expect(await mxPointsHere("moving.io", HOST, deps)).toBe(false);
    const moved = stub([{ exchange: HOST }]);
    moved.advance(MX_ANSWER_TTL_MS);
    expect(await mxPointsHere("moving.io", HOST, moved)).toBe(true);
  });

  test("concurrent checks for one domain share one query", async () => {
    const deps = stub([{ exchange: HOST }]);
    const results = await Promise.all([
      mxPointsHere("acme.io", HOST, deps),
      mxPointsHere("acme.io", HOST, deps),
      mxPointsHere("acme.io", HOST, deps),
    ]);
    expect(results).toEqual([true, true, true]);
    expect(deps.queries).toHaveLength(1);
  });

  test("the answer is per hostname", async () => {
    const deps = stub([{ exchange: HOST }]);
    expect(await mxPointsHere("acme.io", HOST, deps)).toBe(true);
    expect(await mxPointsHere("acme.io", "other.bunmail.test", deps)).toBe(false);
  });

  test("the cache is bounded: the oldest domains are evicted", async () => {
    const deps = stub([{ exchange: HOST }]);
    for (let i = 0; i <= MX_CACHE_MAX_ENTRIES; i += 1) {
      await mxPointsHere(`d${i}.io`, HOST, deps);
    }
    expect(mxCacheSize()).toBe(MX_CACHE_MAX_ENTRIES);
    /** The first domain was evicted, so it is asked again. */
    const before = deps.queries.length;
    await mxPointsHere("d0.io", HOST, deps);
    expect(deps.queries.length).toBe(before + 1);
    /** A recent one is still cached. */
    await mxPointsHere(`d${MX_CACHE_MAX_ENTRIES}.io`, HOST, deps);
    expect(deps.queries.length).toBe(before + 1);
  });
});
