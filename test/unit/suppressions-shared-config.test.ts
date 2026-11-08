import { describe, test, expect } from "bun:test";
import { readFeedbackLoopDomains, readSuppressionsSharedHard } from "../../src/config.ts";

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

/**
 * `FEEDBACK_LOOP_DOMAINS`: the DKIM signing domains whose feedback-loop
 * reports make a complaint shareable. Normalised like a registered domain
 * name; a malformed entry refuses to boot instead of silently verifying
 * nothing (or the wrong thing).
 */
describe("readFeedbackLoopDomains", () => {
  test("unset or blank: empty, nothing is verified", () => {
    expect(readFeedbackLoopDomains(undefined)).toEqual([]);
    expect(readFeedbackLoopDomains("")).toEqual([]);
    expect(readFeedbackLoopDomains(" , ,")).toEqual([]);
  });

  test("comma-separated, trimmed, lower-cased, final dot dropped, duplicates removed", () => {
    expect(
      readFeedbackLoopDomains(
        " FBL.isp.example.net , complaints.example.org., fbl.isp.example.net",
      ),
    ).toEqual(["fbl.isp.example.net", "complaints.example.org"]);
  });

  test("an IDN becomes its A-label", () => {
    expect(readFeedbackLoopDomains("bücher.example")).toEqual(["xn--bcher-kva.example"]);
  });

  test.each([
    "localhost",
    "192.0.2.1",
    "https://isp.example.net",
    "feedback@isp.example.net",
    "isp..example.net",
    "isp.example.net:25",
    "*.example.net",
    "isp example.net",
  ])("refuses %p", (raw) => {
    expect(() => readFeedbackLoopDomains(`ok.example.net, ${raw}`)).toThrow(
      /FEEDBACK_LOOP_DOMAINS must be domain names separated by commas/,
    );
  });
});
