import { describe, expect, test } from "bun:test";
import { readDatabasePoolMax } from "../../src/config.ts";

/**
 * `DATABASE_POOL_MAX` (#423) sizes the app's PostgreSQL pool: unset or
 * blank keeps Bun's default of 10; anything other than a whole number
 * from 1 to 1000 refuses to boot, so a typo never silently shrinks the
 * pool back into the Bun 1.3.14 stall it exists to avoid.
 */
describe("readDatabasePoolMax", () => {
  test("unset or blank: Bun's default of 10", () => {
    expect(readDatabasePoolMax(undefined)).toBe(10);
    expect(readDatabasePoolMax("")).toBe(10);
    expect(readDatabasePoolMax("   ")).toBe(10);
  });

  test.each([
    ["1", 1],
    ["10", 10],
    [" 50 ", 50],
    ["1000", 1000],
  ])("accepts %p", (raw, expected) => {
    expect(readDatabasePoolMax(raw)).toBe(expected);
  });

  test.each(["0", "1001", "-5", "2.5", "1e2", "0x20", "ten"])(
    "refuses %p at boot",
    (raw) => {
      expect(() => readDatabasePoolMax(raw)).toThrow(
        "DATABASE_POOL_MAX must be a whole number from 1 to 1000",
      );
    },
  );
});
