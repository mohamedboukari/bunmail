import { describe, test, expect } from "bun:test";
import {
  checkClickLink,
  createTtlCache,
  TRACKING_EPOCH_TTL_MS,
  type ClickLinkDeps,
} from "../../src/modules/tracking/services/tracking-epoch.service.ts";
import type { VerifiedClickToken } from "../../src/modules/tracking/services/tracking-token.ts";

/**
 * Per-domain revocation of click links (#424): the epoch check of a
 * verified click token (v2 against its own epoch, v1 against epoch 0 of
 * its email's domain), and the in-process cache behind the epochs and
 * the v1 email domains (TTL, cleared by a bump or a delete, one load per
 * key at a time, a load racing a bump never stored, failures not cached).
 */

const DOMAIN_ID = "dom_00112233445566778899aabb";
const EMAIL_ID = "msg_0123456789abcdef01234567";
const subject = { emailId: EMAIL_ID, position: 0, url: "https://example.com/" };

function v2(epoch: number, domainId = DOMAIN_ID): VerifiedClickToken {
  return { ...subject, domainId, epoch, version: 2 };
}
const v1: VerifiedClickToken = { ...subject, version: 1 };

/** Deps over fixed epochs and email domains; records the email lookups. */
function deps(
  epochs: Record<string, number>,
  emailDomains: Record<string, string | null> = {},
): ClickLinkDeps & { emailLookups: string[] } {
  const emailLookups: string[] = [];
  return {
    emailLookups,
    epochOf: async (domainId) => epochs[domainId] ?? null,
    emailDomainOf: async (emailId) => {
      emailLookups.push(emailId);
      return Object.hasOwn(emailDomains, emailId) ? emailDomains[emailId] : undefined;
    },
  };
}

describe("checkClickLink", () => {
  test("a v2 token at the domain's current epoch redirects, without the email row", async () => {
    const d = deps({ [DOMAIN_ID]: 3 });
    expect(await checkClickLink(v2(3), d)).toEqual({ ok: true, domainId: DOMAIN_ID });
    expect(d.emailLookups).toEqual([]);
  });

  test("a v2 token of another epoch is revoked, of a deleted domain refused", async () => {
    const d = deps({ [DOMAIN_ID]: 3 });
    expect(await checkClickLink(v2(2), d)).toEqual({
      ok: false,
      reason: "revoked",
      domainId: DOMAIN_ID,
    });
    expect(await checkClickLink(v2(4), d)).toMatchObject({
      ok: false,
      reason: "revoked",
    });
    const other = "dom_ffeeddccbbaa998877665544";
    expect(await checkClickLink(v2(3, other), d)).toEqual({
      ok: false,
      reason: "unknown_domain",
      domainId: other,
    });
  });

  test("a v1 token counts as epoch 0 of its email's domain", async () => {
    expect(
      await checkClickLink(v1, deps({ [DOMAIN_ID]: 0 }, { [EMAIL_ID]: DOMAIN_ID })),
    ).toEqual({ ok: true, domainId: DOMAIN_ID });
    expect(
      await checkClickLink(v1, deps({ [DOMAIN_ID]: 1 }, { [EMAIL_ID]: DOMAIN_ID })),
    ).toEqual({ ok: false, reason: "revoked", domainId: DOMAIN_ID });
  });

  test("a v1 token whose email row is gone, or has no domain, is refused", async () => {
    expect(await checkClickLink(v1, deps({ [DOMAIN_ID]: 0 }))).toEqual({
      ok: false,
      reason: "email_gone",
      domainId: null,
    });
    expect(await checkClickLink(v1, deps({}, { [EMAIL_ID]: null }))).toEqual({
      ok: false,
      reason: "no_domain",
      domainId: null,
    });
  });
});

describe("createTtlCache", () => {
  /** A cache over a mutable epoch table, a manual clock and a load counter. */
  function setup(): {
    epochs: Map<string, number>;
    clock: { now: number };
    loads: string[];
    cache: ReturnType<typeof createTtlCache>;
  } {
    const epochs = new Map([[DOMAIN_ID, 0]]);
    const clock = { now: 1_000_000 };
    const loads: string[] = [];
    const cache = createTtlCache(
      async (domainId) => {
        loads.push(domainId);
        return epochs.get(domainId) ?? null;
      },
      { now: () => clock.now },
    );
    return { epochs, clock, loads, cache };
  }

  test("caches an epoch for the TTL, then reads it again", async () => {
    const { epochs, clock, loads, cache } = setup();
    expect(await cache.get(DOMAIN_ID)).toBe(0);
    epochs.set(DOMAIN_ID, 1);
    clock.now += TRACKING_EPOCH_TTL_MS - 1;
    /** A bump made elsewhere is not seen before the TTL is up. */
    expect(await cache.get(DOMAIN_ID)).toBe(0);
    clock.now += 1;
    expect(await cache.get(DOMAIN_ID)).toBe(1);
    expect(loads).toHaveLength(2);
  });

  test("forget (a bump in this process) takes effect at once", async () => {
    const { epochs, cache } = setup();
    expect(await cache.get(DOMAIN_ID)).toBe(0);
    epochs.set(DOMAIN_ID, 1);
    cache.forget(DOMAIN_ID);
    expect(await cache.get(DOMAIN_ID)).toBe(1);
  });

  test("an unknown domain is cached too (null)", async () => {
    const { loads, cache } = setup();
    const other = "dom_ffeeddccbbaa998877665544";
    expect(await cache.get(other)).toBeNull();
    expect(await cache.get(other)).toBeNull();
    expect(loads).toEqual([other]);
  });

  test("a load that raced a bump is returned but not stored", async () => {
    let release: (epoch: number) => void = () => {};
    let calls = 0;
    const cache = createTtlCache(async () => {
      calls += 1;
      if (calls === 1) return new Promise<number>((resolve) => (release = resolve));
      return 1;
    });
    const racing = cache.get(DOMAIN_ID);
    cache.forget(DOMAIN_ID);
    release(0);
    expect(await racing).toBe(0);
    /** Not stored: the next read loads the bumped epoch. */
    expect(await cache.get(DOMAIN_ID)).toBe(1);
  });

  test("starts over past its size bound", async () => {
    const loads: string[] = [];
    const cache = createTtlCache(
      async (id) => {
        loads.push(id);
        return 0;
      },
      { maxEntries: 2 },
    );
    for (const id of ["a", "b", "c", "a"]) await cache.get(id);
    /** "c" cleared the cache: "a" is loaded again. */
    expect(loads).toEqual(["a", "b", "c", "a"]);
  });

  test("concurrent misses of one key share one load", async () => {
    let release: (epoch: number) => void = () => {};
    let calls = 0;
    const cache = createTtlCache(() => {
      calls += 1;
      return new Promise<number>((resolve) => (release = resolve));
    });
    const reads = [cache.get(DOMAIN_ID), cache.get(DOMAIN_ID), cache.get(DOMAIN_ID)];
    release(5);
    expect(await Promise.all(reads)).toEqual([5, 5, 5]);
    expect(calls).toBe(1);
    expect(await cache.get(DOMAIN_ID)).toBe(5);
    expect(calls).toBe(1);
  });

  test("a forget during a shared load: later reads start a new load", async () => {
    const releases: Array<(epoch: number) => void> = [];
    const cache = createTtlCache(
      () => new Promise<number>((resolve) => releases.push(resolve)),
    );
    const before = cache.get(DOMAIN_ID);
    cache.forget(DOMAIN_ID);
    const after = cache.get(DOMAIN_ID);
    expect(releases).toHaveLength(2);
    releases[0]?.(0);
    releases[1]?.(1);
    expect([await before, await after]).toEqual([0, 1]);
    /** Only the load started after the forget was stored. */
    expect(await cache.get(DOMAIN_ID)).toBe(1);
    expect(releases).toHaveLength(2);
  });

  test("a failed load is not cached and not shared with later reads", async () => {
    let calls = 0;
    const cache = createTtlCache(async () => {
      calls += 1;
      if (calls === 1) throw new Error("database down");
      return 2;
    });
    const failed = await cache.get(DOMAIN_ID).then(
      () => "loaded",
      (error: unknown) => (error instanceof Error ? error.message : "unknown"),
    );
    expect(failed).toBe("database down");
    expect(await cache.get(DOMAIN_ID)).toBe(2);
    expect(calls).toBe(2);
  });

  test("an undefined value (an email row that is gone) is cached like any other", async () => {
    let calls = 0;
    const cache = createTtlCache(async (): Promise<string | undefined> => {
      calls += 1;
      return undefined;
    });
    expect(await cache.get(EMAIL_ID)).toBeUndefined();
    expect(await cache.get(EMAIL_ID)).toBeUndefined();
    expect(calls).toBe(1);
  });
});
