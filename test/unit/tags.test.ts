import { describe, test, expect } from "bun:test";
import {
  checkTags,
  describeTagProblem,
  parseTagFilters,
  MAX_TAGS,
  MAX_TAG_VALUE_LENGTH,
} from "../../src/modules/emails/services/tags.ts";

/**
 * Tag rules (#189): what a send's `tags`, an `X-BunMail-Tag` header and
 * a `tag` list filter must look like. Pure, so every rule is checked
 * directly.
 */

/** `n` tags `k0=v` .. `k<n-1>=v`. */
function manyTags(n: number): [string, string][] {
  return Array.from({ length: n }, (_, i): [string, string] => [`k${i}`, "v"]);
}

describe("checkTags", () => {
  test("accepts valid tags and trims the values", () => {
    expect(
      checkTags([
        ["flow", "  reset "],
        ["Tenant_ID-2", "t:42"],
      ]),
    ).toEqual({
      ok: true,
      tags: { flow: "reset", "Tenant_ID-2": "t:42" },
    });
  });

  test("accepts no tags", () => {
    expect(checkTags([])).toEqual({ ok: true, tags: {} });
  });

  test("accepts unicode values, counting code points", () => {
    const emoji = "\u{1F600}".repeat(MAX_TAG_VALUE_LENGTH);
    expect(
      checkTags([["name", "Zo\u00e9 \u5e97 \u0627\u0644\u0639\u0631\u0628\u064a\u0629"]])
        .ok,
    ).toBe(true);
    expect(checkTags([["e", emoji]]).ok).toBe(true);
    expect(checkTags([["e", `${emoji}x`]])).toEqual({
      ok: false,
      problem: "value_too_long",
      key: "e",
    });
  });

  test("a value of exactly 256 characters passes, 257 does not", () => {
    expect(checkTags([["v", "a".repeat(256)]]).ok).toBe(true);
    expect(checkTags([["v", "a".repeat(257)]])).toMatchObject({
      problem: "value_too_long",
    });
  });

  test("a huge raw value is refused before it is scanned", () => {
    expect(checkTags([["v", " ".repeat(5000)]])).toMatchObject({
      problem: "value_too_long",
    });
  });

  test(`at most ${MAX_TAGS} tags`, () => {
    expect(checkTags(manyTags(MAX_TAGS)).ok).toBe(true);
    expect(checkTags(manyTags(MAX_TAGS + 1))).toEqual({
      ok: false,
      problem: "too_many",
      key: null,
    });
  });

  test.each([
    "",
    "a".repeat(41),
    "has space",
    "dot.ted",
    "col:on",
    "\u00e9",
    "a\nb",
    "a=b",
  ])("key %p is refused without being named", (key) => {
    expect(checkTags([[key, "v"]])).toEqual({
      ok: false,
      problem: "invalid_key",
      key: null,
    });
  });

  test("a 40-character key passes", () => {
    expect(checkTags([["a".repeat(40), "v"]]).ok).toBe(true);
  });

  test("keys that differ only in case are duplicates", () => {
    expect(
      checkTags([
        ["Flow", "a"],
        ["flow", "b"],
      ]),
    ).toEqual({
      ok: false,
      problem: "duplicate_key",
      key: "flow",
    });
  });

  test.each(["", "   ", "\t"])("empty value %p is refused", (value) => {
    expect(checkTags([["k", value]])).toMatchObject({
      ok: false,
      problem: "empty_value",
    });
  });

  test.each([
    ["NUL", "a\u0000b"],
    ["CR", "a\rb"],
    ["LF", "a\nb"],
    ["tab", "a\tb"],
    ["DEL", "a\u007fb"],
    ["C1", "a\u0085b"],
    ["line separator", "a\u2028b"],
    ["paragraph separator", "a\u2029b"],
    ["RLO", "a\u202eb"],
    ["LRE", "a\u202ab"],
    ["RLI", "a\u2067b"],
    ["PDI", "a\u2069b"],
    ["RLM", "a\u200fb"],
    ["LRM", "a\u200eb"],
    ["ALM", "a\u061cb"],
    ["lone surrogate", "a\ud800b"],
  ])("a value with %s is refused", (_name, value) => {
    expect(checkTags([["k", value]])).toEqual({
      ok: false,
      problem: "forbidden_character",
      key: "k",
    });
  });

  test("a __proto__ key stays an ordinary own key", () => {
    const checked = checkTags([["__proto__", "x"]]);
    if (!checked.ok) throw new Error("expected ok");
    expect(Object.keys(checked.tags)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(checked.tags)).toBe(Object.prototype);
  });
});

describe("parseTagFilters", () => {
  test("splits on the first colon only", () => {
    expect(parseTagFilters(["order:a:b:c"])).toEqual({
      ok: true,
      filters: [{ key: "order", value: "a:b:c" }],
    });
  });

  test("keeps every filter, in order", () => {
    expect(parseTagFilters(["a:1", "b:2,3"])).toEqual({
      ok: true,
      filters: [
        { key: "a", value: "1" },
        { key: "b", value: "2,3" },
      ],
    });
  });

  test.each([
    ["no colon", "flow", "malformed"],
    ["empty key", ":v", "invalid_key"],
    ["bad key", "a b:v", "invalid_key"],
    ["empty value", "k:", "empty_value"],
    ["control character", "k:a\u0000", "forbidden_character"],
    ["bidi control", "k:\u202ex", "forbidden_character"],
    ["too long", `k:${"a".repeat(257)}`, "value_too_long"],
  ])("refuses %s", (_name, raw, problem) => {
    expect(parseTagFilters([raw])).toMatchObject({ ok: false, problem });
  });

  test(`at most ${MAX_TAGS} filters`, () => {
    const raws = manyTags(MAX_TAGS + 1).map(([k, v]) => `${k}:${v}`);
    expect(parseTagFilters(raws)).toMatchObject({ ok: false, problem: "too_many" });
  });
});

describe("describeTagProblem", () => {
  test("names a valid key, never the value", () => {
    const refusal = checkTags([["flow", "secret\u0000value"]]);
    if (refusal.ok) throw new Error("expected a refusal");
    const message = describeTagProblem(refusal, "tags");
    expect(message).toContain('"flow"');
    expect(message).not.toContain("secret");
  });

  test("never names an invalid key", () => {
    const refusal = checkTags([["<script>", "v"]]);
    if (refusal.ok) throw new Error("expected a refusal");
    expect(describeTagProblem(refusal, "tags")).not.toContain("<script>");
  });
});
