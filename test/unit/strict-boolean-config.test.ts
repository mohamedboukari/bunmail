import { describe, test, expect } from "bun:test";
import { optionalStrictBoolean } from "../../src/config.ts";

/**
 * `REQUIRE_VERIFIED_DOMAIN` (#245) is read strictly: only `true`, `false`
 * or unset. Anything else refuses to boot, so a typo cannot leave the
 * guard silently off.
 */
describe("optionalStrictBoolean", () => {
  const read = (raw: string | undefined): boolean =>
    optionalStrictBoolean("REQUIRE_VERIFIED_DOMAIN", false, raw);

  test("unset or blank: the default", () => {
    expect(read(undefined)).toBe(false);
    expect(read("")).toBe(false);
    expect(read("  ")).toBe(false);
    expect(optionalStrictBoolean("REQUIRE_VERIFIED_DOMAIN", true, undefined)).toBe(true);
  });

  test("accepts true and false, surrounding spaces ignored", () => {
    expect(read("true")).toBe(true);
    expect(read("false")).toBe(false);
    expect(read(" true ")).toBe(true);
  });

  test.each(["TRUE", "True", "1", "0", "yes", "no", "on", "off", "truthy"])(
    "refuses %p, naming the variable",
    (raw) => {
      expect(() => read(raw)).toThrow(
        /REQUIRE_VERIFIED_DOMAIN must be "true" or "false"/,
      );
    },
  );
});
