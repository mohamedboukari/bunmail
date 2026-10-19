import { describe, test, expect } from "bun:test";
import {
  checkFromName,
  describeFromNameProblem,
  MAX_FROM_NAME_LENGTH,
} from "../../src/modules/emails/services/from-name.ts";

/** The sender display name rules (#250): what a `From:` name may hold. */

describe("checkFromName: accepted", () => {
  test.each([
    "Acme Support",
    "O'Brien & Sons, Ltd.",
    "Zo\u00eb M\u00fcller",
    "\u5c71\u7530\u592a\u90ce",
    "\u0645\u062d\u0645\u062f",
    "Team \u{1f680}",
    "a",
  ])("%p", (name) => {
    expect(checkFromName(name)).toEqual({ ok: true, name });
  });

  test("the name is trimmed", () => {
    expect(checkFromName("  Acme  ")).toEqual({ ok: true, name: "Acme" });
  });

  test("100 characters is the limit, counted in code points", () => {
    expect(checkFromName("a".repeat(MAX_FROM_NAME_LENGTH)).ok).toBe(true);
    /** 100 emoji are 200 UTF-16 units but 100 characters. */
    expect(checkFromName("\u{1f680}".repeat(MAX_FROM_NAME_LENGTH)).ok).toBe(true);
    expect(checkFromName(` ${"a".repeat(MAX_FROM_NAME_LENGTH)} `).ok).toBe(true);
  });
});

describe("checkFromName: refused", () => {
  test.each(["", "   ", "\u00a0"])("empty %p", (name) => {
    expect(checkFromName(name)).toEqual({ ok: false, problem: "empty" });
  });

  test("over 100 characters", () => {
    expect(checkFromName("a".repeat(MAX_FROM_NAME_LENGTH + 1))).toEqual({
      ok: false,
      problem: "too_long",
    });
    expect(checkFromName("\u{1f680}".repeat(MAX_FROM_NAME_LENGTH + 1)).ok).toBe(false);
  });

  test("a huge raw value is refused before it is trimmed", () => {
    expect(checkFromName(" ".repeat(5000) + "a")).toEqual({
      ok: false,
      problem: "too_long",
    });
  });

  test.each([
    ["CR", "Acme\rBcc: x"],
    ["LF", "Acme\nBcc: x"],
    ["NUL", "Acme\u0000"],
    ["tab", "Acme\tSupport"],
    ["DEL", "Acme\u007f"],
    ["C1 control", "Acme\u0085"],
    ["line separator", "Ac\u2028me"],
    ["paragraph separator", "Ac\u2029me"],
    ["LRE", "\u202aAcme"],
    ["RLE", "\u202bAcme"],
    ["PDF", "Acme\u202c"],
    ["LRO", "\u202dAcme"],
    ["RLO", "\u202emoc.lapyap@troppus"],
    ["LRI", "\u2066Acme"],
    ["RLI", "\u2067Acme"],
    ["FSI", "\u2068Acme"],
    ["PDI", "Acme\u2069"],
    ["@ (an address as the name)", "support@paypal.com"],
    ["<", "Acme <support@paypal.com"],
    [">", "Acme>"],
    ['"', 'Acme" <evil@example.com>'],
  ])("%s", (_label, name) => {
    expect(checkFromName(name)).toEqual({ ok: false, problem: "forbidden_character" });
  });
});

describe("describeFromNameProblem", () => {
  test("names the field, never a value", () => {
    for (const problem of ["empty", "too_long", "forbidden_character"] as const) {
      expect(describeFromNameProblem(problem)).toStartWith("fromName ");
    }
  });
});
