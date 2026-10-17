import { describe, test, expect } from "bun:test";
import {
  nextRetryDelayMs,
  RETRY_SCHEDULE_MINUTES,
} from "../../src/modules/emails/services/retry-schedule.ts";

/** Retry timing for temporarily failed mail (#180). Pure function. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("nextRetryDelayMs", () => {
  test("follows the escalating schedule: 5, 15, 30, 60, 120, 240 minutes", () => {
    const delays = [1, 2, 3, 4, 5, 6].map(
      (attempt) => nextRetryDelayMs(attempt, MINUTE, 48 * HOUR)! / MINUTE,
    );
    expect(delays).toEqual([...RETRY_SCHEDULE_MINUTES]);
  });

  test("repeats the last interval (4 hours) after the schedule runs out", () => {
    expect(nextRetryDelayMs(12, HOUR, 48 * HOUR)).toBe(240 * MINUTE);
  });

  test("gives up once the next retry would pass the maximum age", () => {
    /** 46 h + 4 h = 50 h > 48 h. */
    expect(nextRetryDelayMs(10, 46 * HOUR, 48 * HOUR)).toBeNull();
    /** Still inside a longer window. */
    expect(nextRetryDelayMs(10, 46 * HOUR, 72 * HOUR)).toBe(240 * MINUTE);
  });

  test("treats attempt numbers below 1 as the first attempt", () => {
    expect(nextRetryDelayMs(0, MINUTE, 48 * HOUR)).toBe(5 * MINUTE);
  });
});
