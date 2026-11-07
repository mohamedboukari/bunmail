import { describe, expect, test } from "bun:test";
import {
  DEFAULT_EMAIL_EVENTS_RETENTION_DAYS,
  MAX_EMAIL_EVENTS_RETENTION_DAYS,
  MIN_EMAIL_EVENTS_RETENTION_DAYS,
  config,
  readEmailEventsRetentionDays,
  readTrackingEnabled,
} from "../../src/config.ts";

/**
 * Open and click tracking's env vars (#187): `TRACKING_ENABLED` is a
 * strict boolean, off by default; `EMAIL_EVENTS_RETENTION_DAYS` is a
 * whole number of days from 1 to 3650, 90 by default. Anything else stops
 * the boot.
 */

describe("readTrackingEnabled", () => {
  test("off by default", () => {
    expect(readTrackingEnabled(undefined)).toBe(false);
    expect(readTrackingEnabled("")).toBe(false);
    expect(readTrackingEnabled("   ")).toBe(false);
  });

  test("true and false only", () => {
    expect(readTrackingEnabled("true")).toBe(true);
    expect(readTrackingEnabled(" false ")).toBe(false);
    for (const raw of ["1", "yes", "TRUE", "on", "0"]) {
      expect(() => readTrackingEnabled(raw)).toThrow(
        /TRACKING_ENABLED must be "true" or "false"/,
      );
    }
  });
});

describe("readEmailEventsRetentionDays", () => {
  test("90 by default", () => {
    expect(DEFAULT_EMAIL_EVENTS_RETENTION_DAYS).toBe(90);
    expect(readEmailEventsRetentionDays(undefined)).toBe(90);
    expect(readEmailEventsRetentionDays("")).toBe(90);
  });

  test("accepts the bounds and anything between", () => {
    expect(MIN_EMAIL_EVENTS_RETENTION_DAYS).toBe(1);
    expect(MAX_EMAIL_EVENTS_RETENTION_DAYS).toBe(3650);
    expect(readEmailEventsRetentionDays("1")).toBe(1);
    expect(readEmailEventsRetentionDays("30")).toBe(30);
    expect(readEmailEventsRetentionDays("3650")).toBe(3650);
  });

  test("anything else refuses to boot", () => {
    for (const raw of ["0", "3651", "-1", "1.5", "1e2", "0x10", "ninety", "90d"]) {
      expect(() => readEmailEventsRetentionDays(raw)).toThrow(
        /EMAIL_EVENTS_RETENTION_DAYS must be a whole number from 1 to 3650/,
      );
    }
  });
});

describe("config.tracking", () => {
  test("is assembled from the readers", () => {
    expect(typeof config.tracking.enabled).toBe("boolean");
    expect(config.tracking.eventsRetentionDays).toBeGreaterThanOrEqual(1);
    expect(config.tracking.eventsRetentionDays).toBeLessThanOrEqual(3650);
  });
});
