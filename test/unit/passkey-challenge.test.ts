import { describe, test, expect } from "bun:test";
import { createChallengeStore } from "../../src/modules/users/services/passkey-challenge.service.ts";
import { PASSKEY_CHALLENGE_TTL_SECONDS } from "../../src/modules/users/services/passkey-policy.service.ts";

/**
 * The WebAuthn challenge store (#223): random, single use, 5 minutes,
 * bound to what started the ceremony, and bounded in size.
 */

/** A store on a clock the test moves. */
function storeAt(start: number, options: { maxEntries?: number } = {}) {
  let now = start;
  const store = createChallengeStore({ now: () => now, ...options });
  return {
    store,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("passkey challenge store", () => {
  test("a challenge is 32 random bytes, base64url, different every time", () => {
    const { store } = storeAt(0);
    const a = store.issue("register", "ses_a", { userId: "usr_1", name: "Key" });
    const b = store.issue("register", "ses_b", { userId: "usr_1", name: "Key" });
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a, "base64url")).toHaveLength(32);
    expect(a).not.toBe(b);
  });

  test("single use: taken once, then gone, whatever the outcome", () => {
    const { store } = storeAt(0);
    const challenge = store.issue("sign_in", "binding", { userId: null });
    expect(store.take("sign_in", "binding")).toEqual({
      challenge,
      userId: null,
      name: undefined,
    });
    expect(store.take("sign_in", "binding")).toBeNull();
    expect(store.size()).toBe(0);
  });

  test("bound to its purpose and its binding", () => {
    const { store } = storeAt(0);
    store.issue("second_factor", "ses_1", { userId: "usr_1" });
    expect(store.take("register", "ses_1")).toBeNull();
    expect(store.take("sign_in", "ses_1")).toBeNull();
    expect(store.take("second_factor", "ses_2")).toBeNull();
    expect(store.take("second_factor", "ses_1")?.userId).toBe("usr_1");
  });

  test("five minutes: alive just before, dead at the TTL (and the dead entry is dropped)", () => {
    const ttl = PASSKEY_CHALLENGE_TTL_SECONDS * 1000;
    expect(ttl).toBe(5 * 60 * 1000);
    const { store, advance } = storeAt(1_000);
    store.issue("register", "ses_1", { userId: "usr_1", name: "Key" });
    advance(ttl - 1);
    expect(store.take("register", "ses_1")).not.toBeNull();

    store.issue("register", "ses_1", { userId: "usr_1", name: "Key" });
    advance(ttl);
    expect(store.take("register", "ses_1")).toBeNull();
    expect(store.size()).toBe(0);
  });

  test("a new challenge for the same binding replaces the earlier one", () => {
    const { store } = storeAt(0);
    const first = store.issue("register", "ses_1", { userId: "usr_1", name: "One" });
    const second = store.issue("register", "ses_1", { userId: "usr_1", name: "Two" });
    expect(store.size()).toBe(1);
    const taken = store.take("register", "ses_1");
    expect(taken?.challenge).toBe(second);
    expect(taken?.challenge).not.toBe(first);
    expect(taken?.name).toBe("Two");
  });

  test("bounded: when full, expired entries go first, then the oldest", () => {
    const { store, advance } = storeAt(0, { maxEntries: 3 });
    store.issue("sign_in", "old", { userId: null });
    advance(PASSKEY_CHALLENGE_TTL_SECONDS * 1000);
    store.issue("sign_in", "a", { userId: null });
    store.issue("sign_in", "b", { userId: null });
    /** Full: the expired `old` is dropped, nothing live is lost. */
    store.issue("sign_in", "c", { userId: null });
    expect(store.size()).toBe(3);
    expect(store.take("sign_in", "a")).not.toBeNull();
    store.issue("sign_in", "a", { userId: null });
    /** Full of live entries: the oldest (`b`) makes room. */
    store.issue("sign_in", "d", { userId: null });
    expect(store.size()).toBe(3);
    expect(store.take("sign_in", "b")).toBeNull();
    expect(store.take("sign_in", "c")).not.toBeNull();
    expect(store.take("sign_in", "d")).not.toBeNull();
  });
});
