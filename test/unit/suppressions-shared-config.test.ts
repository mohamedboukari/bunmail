import { describe, test, expect } from "bun:test";
import { readSuppressionsSharedHard } from "../../src/config.ts";

/**
 * `SUPPRESSIONS_SHARED_HARD` (#250) is a strict boolean, default false:
 * a typo refuses to boot instead of silently leaving the shared gate off.
 */
describe("readSuppressionsSharedHard", () => {
  test("unset or blank: false", () => {
    expect(readSuppressionsSharedHard(undefined)).toBe(false);
    expect(readSuppressionsSharedHard("")).toBe(false);
    expect(readSuppressionsSharedHard("   ")).toBe(false);
  });

  test("true and false, surrounding spaces ignored", () => {
    expect(readSuppressionsSharedHard("true")).toBe(true);
    expect(readSuppressionsSharedHard(" true ")).toBe(true);
    expect(readSuppressionsSharedHard("false")).toBe(false);
  });

  test.each(["TRUE", "1", "yes", "on", "shared"])("refuses %p", (raw) => {
    expect(() => readSuppressionsSharedHard(raw)).toThrow(
      /SUPPRESSIONS_SHARED_HARD must be "true" or "false"/,
    );
  });
});
