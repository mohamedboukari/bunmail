import { describe, test, expect } from "bun:test";
import { readIpFamily, readMxRatePerMin } from "../../src/config.ts";

/** `MAIL_IP_FAMILY` and `MAIL_MX_RATE_PER_MIN` (#250): strict, refusing to boot on a typo. */
describe("readIpFamily", () => {
  test("unset or blank: 4", () => {
    expect(readIpFamily(undefined)).toBe(4);
    expect(readIpFamily("")).toBe(4);
    expect(readIpFamily("  ")).toBe(4);
  });

  test("4 or 6", () => {
    expect(readIpFamily("4")).toBe(4);
    expect(readIpFamily(" 6 ")).toBe(6);
  });

  test.each(["auto", "ipv4", "v6", "46", "0", "4.0"])("refuses %p", (raw) => {
    expect(() => readIpFamily(raw)).toThrow(/MAIL_IP_FAMILY/);
  });
});

describe("readMxRatePerMin", () => {
  test("unset or blank: no budget", () => {
    expect(readMxRatePerMin(undefined)).toBeNull();
    expect(readMxRatePerMin("")).toBeNull();
    expect(readMxRatePerMin("   ")).toBeNull();
  });

  test("a whole number from 1 to 100000", () => {
    expect(readMxRatePerMin("1")).toBe(1);
    expect(readMxRatePerMin(" 60 ")).toBe(60);
    expect(readMxRatePerMin("100000")).toBe(100_000);
  });

  test.each(["0", "100001", "-5", "1.5", "1e3", "0x10", "ten"])("refuses %p", (raw) => {
    expect(() => readMxRatePerMin(raw)).toThrow(/MAIL_MX_RATE_PER_MIN/);
  });
});
