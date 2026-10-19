import { describe, test, expect } from "bun:test";
import {
  MAX_DOMAIN_REVERIFY_INTERVAL_HOURS,
  MIN_DOMAIN_REVERIFY_INTERVAL_HOURS,
  optionalStrictBoolean,
  readDomainReverifyIntervalHours,
} from "../../src/config.ts";

/**
 * The re-verification loop's env vars (#250). `DOMAIN_REVERIFY_INTERVAL_HOURS`
 * defaults to 24 and refuses anything but a whole number of hours from 6
 * to 168; `DOMAIN_REVERIFY_ENABLED` is a strict boolean, default true. A
 * malformed value stops the boot.
 */

describe("readDomainReverifyIntervalHours", () => {
  test("unset or blank: 24 hours", () => {
    expect(readDomainReverifyIntervalHours(undefined)).toBe(24);
    expect(readDomainReverifyIntervalHours("")).toBe(24);
    expect(readDomainReverifyIntervalHours("  ")).toBe(24);
  });

  test.each([
    [String(MIN_DOMAIN_REVERIFY_INTERVAL_HOURS), 6],
    ["12", 12],
    [" 48 ", 48],
    [String(MAX_DOMAIN_REVERIFY_INTERVAL_HOURS), 168],
  ])("accepts %p", (raw, hours) => {
    expect(readDomainReverifyIntervalHours(raw)).toBe(hours);
  });

  test.each(["0", "5", "169", "-1", "1.5", "24h", "abc", "1e2", "0x10"])(
    "refuses %p",
    (raw) => {
      expect(() => readDomainReverifyIntervalHours(raw)).toThrow(
        /DOMAIN_REVERIFY_INTERVAL_HOURS must be a whole number from 6 to 168/,
      );
    },
  );
});

describe("DOMAIN_REVERIFY_ENABLED", () => {
  test("defaults to true", () => {
    expect(optionalStrictBoolean("DOMAIN_REVERIFY_ENABLED", true, undefined)).toBe(true);
    expect(optionalStrictBoolean("DOMAIN_REVERIFY_ENABLED", true, "")).toBe(true);
  });

  test("false turns the loop off", () => {
    expect(optionalStrictBoolean("DOMAIN_REVERIFY_ENABLED", true, "false")).toBe(false);
  });

  test.each(["0", "no", "TRUE", "off"])("refuses %p", (raw) => {
    expect(() => optionalStrictBoolean("DOMAIN_REVERIFY_ENABLED", true, raw)).toThrow(
      /DOMAIN_REVERIFY_ENABLED must be "true" or "false"/,
    );
  });
});
