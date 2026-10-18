import { describe, test, expect, spyOn } from "bun:test";
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
  test("the creator redeems it once, on the right page", () => {
    const token = stashRevealSecret("bm_live_secret", "api_key", ANN);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(consumeRevealSecret(token, "api_key", ANN)).toBe("bm_live_secret");
    expect(consumeRevealSecret(token, "api_key", ANN)).toBeUndefined();
  });

  test("another user, another session of the same user, or the wrong page get nothing and do not burn it", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    /** Start from zero: a spy left on logger.warn by another file keeps its history. */
    warn.mockClear();
    try {
      const token = stashRevealSecret("whsec_value", "webhook_secret", ANN);
      expect(consumeRevealSecret(token, "webhook_secret", BOB)).toBeUndefined();
      expect(
        consumeRevealSecret(token, "webhook_secret", ANN_OTHER_DEVICE),
      ).toBeUndefined();
      expect(consumeRevealSecret(token, "api_key", ANN)).toBeUndefined();
      /** Only our refusals: other files' background work may log too (shared process). */
      const refusals = warn.mock.calls.filter(([message]) =>
        message.startsWith("One-time reveal refused"),
      );
      expect(refusals).toHaveLength(3);
      const logged = JSON.stringify(refusals);
      expect(logged).not.toContain(token);
      expect(logged).not.toContain("whsec_value");
      /** Still there for its owner. */
      expect(consumeRevealSecret(token, "webhook_secret", ANN)).toBe("whsec_value");
    } finally {
      warn.mockRestore();
    }
  });

  test("expired, unknown and missing tokens get nothing", () => {
    const now = 1_000_000;
    const token = stashRevealSecret("late", "api_key", ANN, now);
    expect(consumeRevealSecret(token, "api_key", ANN, now + 60_001)).toBeUndefined();
    expect(consumeRevealSecret(token, "api_key", ANN, now)).toBeUndefined();
    expect(consumeRevealSecret("f".repeat(64), "api_key", ANN)).toBeUndefined();
    expect(consumeRevealSecret(undefined, "api_key", ANN)).toBeUndefined();
  });

  test("the owner is copied, so mutating the caller's object changes nothing", () => {
    const owner: RevealOwner = { userId: "usr_carl", sessionId: "ses_carl" };
    const token = stashRevealSecret("k", "api_key", owner);
    owner.userId = "usr_mallory";
    expect(
      consumeRevealSecret(token, "api_key", {
        userId: "usr_mallory",
        sessionId: "ses_carl",
      }),
    ).toBeUndefined();
    expect(
      consumeRevealSecret(token, "api_key", {
        userId: "usr_carl",
        sessionId: "ses_carl",
      }),
    ).toBe("k");
  });
});
