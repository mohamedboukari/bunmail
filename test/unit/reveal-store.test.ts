import { describe, test, expect, setSystemTime, spyOn } from "bun:test";
import {
  consumeRevealSecret,
  stashRevealSecret,
  type RevealOwner,
} from "../../src/pages/reveal-store.ts";
import { logger } from "../../src/utils/logger.ts";

/**
 * One-time secret reveal bound to its creator (#280): a token is redeemable
 * once, within its lifetime, on the page of its kind, by the user and
 * session that created it. Everything else answers like an unknown token
 * and leaves the entry for its owner.
 */

const ANN: RevealOwner = { userId: "usr_ann", sessionId: "ses_ann" };
const ANN_OTHER_DEVICE: RevealOwner = { userId: "usr_ann", sessionId: "ses_ann_phone" };
const BOB: RevealOwner = { userId: "usr_bob", sessionId: "ses_bob" };

describe("reveal store", () => {
  test("the creator redeems it once, on the right page", async () => {
    const token = await stashRevealSecret("bm_live_secret", "api_key", ANN);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await consumeRevealSecret(token, "api_key", ANN)).toBe("bm_live_secret");
    expect(await consumeRevealSecret(token, "api_key", ANN)).toBeUndefined();
  });

  test("two concurrent redemptions: exactly one gets the secret", async () => {
    const token = await stashRevealSecret("bm_live_once", "api_key", ANN);
    const results = await Promise.all([
      consumeRevealSecret(token, "api_key", ANN),
      consumeRevealSecret(token, "api_key", ANN),
    ]);
    expect(results.filter((r) => r === "bm_live_once")).toHaveLength(1);
  });

  test("another user, another session of the same user, or the wrong page get nothing and do not burn it", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    /** Start from zero: a spy left on logger.warn by another file keeps its history. */
    warn.mockClear();
    try {
      const token = await stashRevealSecret("whsec_value", "webhook_secret", ANN);
      expect(await consumeRevealSecret(token, "webhook_secret", BOB)).toBeUndefined();
      expect(
        await consumeRevealSecret(token, "webhook_secret", ANN_OTHER_DEVICE),
      ).toBeUndefined();
      expect(await consumeRevealSecret(token, "api_key", ANN)).toBeUndefined();
      /** Only our refusals: other files' background work may log too (shared process). */
      const refusals = warn.mock.calls.filter(([message]) =>
        message.startsWith("One-time reveal refused"),
      );
      expect(refusals).toHaveLength(3);
      const logged = JSON.stringify(refusals);
      expect(logged).not.toContain(token);
      expect(logged).not.toContain("whsec_value");
      /** The refusal names the stored binding's IDs, nothing else. */
      expect(refusals[0]?.[1]).toMatchObject({
        ownerUserId: "usr_ann",
        ownerSessionId: "ses_ann",
        entryKind: "webhook_secret",
      });
      /** Still there for its owner. */
      expect(await consumeRevealSecret(token, "webhook_secret", ANN)).toBe("whsec_value");
    } finally {
      warn.mockRestore();
    }
  });

  test("expired, unknown and missing tokens get nothing", async () => {
    try {
      setSystemTime(new Date(1_000_000));
      const token = await stashRevealSecret("late", "api_key", ANN);
      setSystemTime(new Date(1_000_000 + 60_001));
      expect(await consumeRevealSecret(token, "api_key", ANN)).toBeUndefined();
      setSystemTime(new Date(1_000_000));
      expect(await consumeRevealSecret(token, "api_key", ANN)).toBeUndefined();
    } finally {
      setSystemTime();
    }
    expect(await consumeRevealSecret("f".repeat(64), "api_key", ANN)).toBeUndefined();
    expect(await consumeRevealSecret(undefined, "api_key", ANN)).toBeUndefined();
  });

  test("the owner is bound at stash time, so mutating the caller's object changes nothing", async () => {
    const owner: RevealOwner = { userId: "usr_carl", sessionId: "ses_carl" };
    const token = await stashRevealSecret("k", "api_key", owner);
    owner.userId = "usr_mallory";
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(
        await consumeRevealSecret(token, "api_key", {
          userId: "usr_mallory",
          sessionId: "ses_carl",
        }),
      ).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
    expect(
      await consumeRevealSecret(token, "api_key", {
        userId: "usr_carl",
        sessionId: "ses_carl",
      }),
    ).toBe("k");
  });
});
