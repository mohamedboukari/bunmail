import { describe, test, expect, afterEach } from "bun:test";
import {
  createRateBudget,
  deferralDelayMs,
  mxRateBudget,
  setMxRateBudget,
} from "../../src/modules/emails/services/rate-budget.ts";

/**
 * The per-provider rate budget (#250, `MAIL_MX_RATE_PER_MIN`): a token
 * bucket per provider bucket, driven by an injected clock.
 */

/** A clock the test moves by hand. */
function fakeClock(start = 1_000_000) {
  let at = start;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

describe("createRateBudget", () => {
  test("starts full: capacity is the per-minute rate", () => {
    const clock = fakeClock();
    const budget = createRateBudget(3, clock.now);
    expect(budget.take("google", 3)).toEqual({ granted: 3, waitMs: 0 });
    expect(budget.take("google", 1)).toEqual({ granted: 0, waitMs: 20_000 });
  });

  test("grants what is there and says when the next token is due", () => {
    const clock = fakeClock();
    const budget = createRateBudget(2, clock.now);
    /** Two tokens, three asked: two granted, the third due in 30 s (60 s / 2). */
    expect(budget.take("microsoft", 3)).toEqual({ granted: 2, waitMs: 30_000 });
  });

  test("refills continuously, never past capacity", () => {
    const clock = fakeClock();
    const budget = createRateBudget(1, clock.now);
    expect(budget.take("yahoo", 1).granted).toBe(1);
    clock.advance(15_000);
    /** A quarter of a token back: 45 s to go. */
    expect(budget.take("yahoo", 1)).toEqual({ granted: 0, waitMs: 45_000 });
    clock.advance(45_000);
    expect(budget.take("yahoo", 1)).toEqual({ granted: 1, waitMs: 0 });
    /** A long idle period refills to the capacity of 1, not more. */
    clock.advance(10 * 60_000);
    expect(budget.take("yahoo", 2)).toEqual({ granted: 1, waitMs: 60_000 });
  });

  test("buckets are independent", () => {
    const clock = fakeClock();
    const budget = createRateBudget(1, clock.now);
    expect(budget.take("google", 1).granted).toBe(1);
    expect(budget.take("google", 1).granted).toBe(0);
    expect(budget.take("example.org", 1).granted).toBe(1);
  });

  test("an empty request takes nothing and waits for nothing", () => {
    const budget = createRateBudget(1, fakeClock().now);
    expect(budget.take("google", 0)).toEqual({ granted: 0, waitMs: 0 });
    expect(budget.take("google", 1).granted).toBe(1);
  });

  test("a limited bucket logs at most once a minute", () => {
    const clock = fakeClock();
    const budget = createRateBudget(1, clock.now);
    expect(budget.shouldLog("google")).toBe(true);
    expect(budget.shouldLog("google")).toBe(false);
    expect(budget.shouldLog("apple")).toBe(true);
    clock.advance(59_999);
    expect(budget.shouldLog("google")).toBe(false);
    clock.advance(1);
    expect(budget.shouldLog("google")).toBe(true);
  });
});

describe("deferralDelayMs", () => {
  test("the wait plus a small jitter", () => {
    expect(deferralDelayMs(60_000, () => 0)).toBe(60_000);
    expect(deferralDelayMs(60_000, () => 1)).toBe(66_000);
    /** Short waits still spread over up to 250 ms. */
    expect(deferralDelayMs(100, () => 1)).toBe(350);
    expect(deferralDelayMs(0, () => 0)).toBe(1);
  });
});

describe("mxRateBudget", () => {
  afterEach(() => {
    setMxRateBudget(null);
  });

  test("none without a rate; one kept per rate", () => {
    expect(mxRateBudget(null)).toBeNull();
    const budget = mxRateBudget(5);
    expect(budget?.ratePerMin).toBe(5);
    expect(mxRateBudget(5)).toBe(budget);
    expect(mxRateBudget(6)?.ratePerMin).toBe(6);
  });

  test("a test's budget replaces the configured one", () => {
    const injected = createRateBudget(1, fakeClock().now);
    setMxRateBudget(injected);
    expect(mxRateBudget(null)).toBe(injected);
    setMxRateBudget(null);
    expect(mxRateBudget(null)).toBeNull();
  });
});
