import { describe, test, expect } from "bun:test";
import {
  recordReplay,
  REPLAYS_PER_DELIVERY_PER_HOUR,
} from "../../src/modules/webhooks/services/replay-limit.service.ts";

/**
 * Replay budget per webhook delivery (#258): 5 per delivery in a fixed
 * one-hour window from the first replay, on the API limiter's primitive.
 */
describe("recordReplay", () => {
  const HOUR = 60 * 60 * 1000;

  test("allows 5 replays, refuses the 6th with the seconds left in the window", () => {
    const t0 = 1_000_000_000;
    for (let i = 0; i < REPLAYS_PER_DELIVERY_PER_HOUR; i++) {
      expect(recordReplay("wdl_unit_a", t0 + i * 1000)).toEqual({ limited: false });
    }
    expect(recordReplay("wdl_unit_a", t0 + 10 * 60 * 1000)).toEqual({
      limited: true,
      retryAfterSec: 50 * 60,
    });
  });

  test("counts each delivery on its own", () => {
    const t0 = 2_000_000_000;
    for (let i = 0; i < REPLAYS_PER_DELIVERY_PER_HOUR; i++)
      recordReplay("wdl_unit_b", t0);
    expect(recordReplay("wdl_unit_b", t0).limited).toBe(true);
    expect(recordReplay("wdl_unit_c", t0).limited).toBe(false);
  });

  test("a new window starts once the hour has passed", () => {
    const t0 = 3_000_000_000;
    for (let i = 0; i <= REPLAYS_PER_DELIVERY_PER_HOUR; i++)
      recordReplay("wdl_unit_d", t0);
    expect(recordReplay("wdl_unit_d", t0 + HOUR - 1).limited).toBe(true);
    expect(recordReplay("wdl_unit_d", t0 + HOUR).limited).toBe(false);
  });
});
