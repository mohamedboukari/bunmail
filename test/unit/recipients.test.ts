import { describe, test, expect } from "bun:test";
import {
  MAX_ADDRESS_LENGTH,
  isEmailAddress,
  parseRecipients,
  groupByDomain,
} from "../../src/utils/recipients.ts";

/**
 * Unit tests for the recipient parser + MX grouper (#87 phase 1).
 *
 * No network involved: the MX resolver is a plain function the
 * caller injects, so tests can drive any topology (success, partial
 * failure, multiple domains sharing an MX) without touching DNS.
 */

describe("parseRecipients", () => {
  test("parses a single `to` address into one recipient", () => {
    expect(parseRecipients("alice@example.com", null, null)).toEqual([
      { kind: "to", address: "alice@example.com", domain: "example.com" },
    ]);
  });

  test("splits comma-separated lists across all three fields", () => {
    const result = parseRecipients(
      "alice@a.com, bob@b.com",
      "carol@c.com",
      "dave@d.com, eve@e.com",
    );
    expect(result.map((r) => `${r.kind}:${r.address}`)).toEqual([
      "to:alice@a.com",
      "to:bob@b.com",
      "cc:carol@c.com",
      "bcc:dave@d.com",
      "bcc:eve@e.com",
    ]);
  });

  test("trims surrounding whitespace from each address", () => {
    const result = parseRecipients(
      "  alice@example.com  ,  bob@example.com ",
      null,
      null,
    );
    expect(result.map((r) => r.address)).toEqual([
      "alice@example.com",
      "bob@example.com",
    ]);
  });

  test("drops empty entries (trailing commas, double commas)", () => {
    const result = parseRecipients("alice@example.com,,, ", null, "");
    expect(result.map((r) => r.address)).toEqual(["alice@example.com"]);
  });

  test("drops syntactically invalid emails silently", () => {
    const result = parseRecipients("ok@example.com, not-an-email, also bad", null, null);
    expect(result.map((r) => r.address)).toEqual(["ok@example.com"]);
  });

  test("dedupes case-insensitively, keeping the first occurrence", () => {
    const result = parseRecipients(
      "Alice@Example.COM",
      "alice@example.com, bob@example.com",
      null,
    );
    /** Only one Alice, and she stays `to` (first occurrence wins),
     *  with the original case preserved on the address. */
    expect(result).toEqual([
      { kind: "to", address: "Alice@Example.COM", domain: "example.com" },
      { kind: "cc", address: "bob@example.com", domain: "example.com" },
    ]);
  });

  test("kind precedence on dedup: to > cc > bcc", () => {
    const result = parseRecipients("a@x.com", "a@x.com", "a@x.com");
    expect(result).toEqual([{ kind: "to", address: "a@x.com", domain: "x.com" }]);
  });

  test("kind precedence: cc beats bcc when no `to`", () => {
    const result = parseRecipients("primary@x.com", "shared@y.com", "shared@y.com");
    expect(result.find((r) => r.address === "shared@y.com")?.kind).toBe("cc");
  });

  test("domain is lowercased even when the address isn't", () => {
    const result = parseRecipients("User@Example.COM", null, null);
    expect(result[0]!.domain).toBe("example.com");
    expect(result[0]!.address).toBe("User@Example.COM");
  });

  test("returns empty array when no inputs parse", () => {
    expect(parseRecipients("", null, undefined)).toEqual([]);
    expect(parseRecipients("not-an-email", null, null)).toEqual([]);
  });
});

describe("groupByDomain (#250)", () => {
  test("buckets recipients by their domain, in first-seen order", () => {
    const recipients = parseRecipients(
      "a@gmail.com, c@outlook.com, b@GMAIL.com",
      null,
      null,
    );
    const groups = groupByDomain(recipients);
    expect([...groups.keys()]).toEqual(["gmail.com", "outlook.com"]);
    expect(groups.get("gmail.com")!.map((r) => r.address)).toEqual([
      "a@gmail.com",
      "b@GMAIL.com",
    ]);
    expect(groups.get("outlook.com")!.map((r) => r.address)).toEqual(["c@outlook.com"]);
  });

  test("keeps domains apart even when they would share an MX", () => {
    const groups = groupByDomain(parseRecipients("a@hello.com, b@world.com", null, null));
    expect(groups.size).toBe(2);
  });

  test("returns no groups for an empty input", () => {
    expect(groupByDomain([]).size).toBe(0);
  });
});

describe("parseRecipients: address length and shape limits", () => {
  test("accepts an address exactly at the RFC 5321 limit and drops a longer one", () => {
    const domain = "@example.org";
    const atLimit = "a".repeat(MAX_ADDRESS_LENGTH - domain.length) + domain;
    expect(parseRecipients(atLimit, null, null)).toHaveLength(1);
    expect(parseRecipients("a" + atLimit, null, null)).toHaveLength(0);
  });

  test("still accepts common shapes", () => {
    const list = "first.last+tag@mail.example.co.uk, x_y@sub-domain.example, u@h.io";
    expect(parseRecipients(list, null, null).map((r) => r.address)).toEqual([
      "first.last+tag@mail.example.co.uk",
      "x_y@sub-domain.example",
      "u@h.io",
    ]);
  });

  test("rejects empty domain labels and dotless domains", () => {
    expect(parseRecipients("a@b..c, a@b., a@.b, a@localhost", null, null)).toHaveLength(
      0,
    );
  });
});

describe("isEmailAddress (shared with BUNMAIL_OWNER_EMAIL, #215)", () => {
  test("accepts the shapes parseRecipients accepts, up to the length cap", () => {
    const domain = "@example.org";
    const atLimit = "a".repeat(MAX_ADDRESS_LENGTH - domain.length) + domain;
    expect(isEmailAddress("owner@example.com")).toBe(true);
    expect(isEmailAddress("first.last+tag@mail.example.co.uk")).toBe(true);
    expect(isEmailAddress(atLimit)).toBe(true);
    expect(isEmailAddress("a" + atLimit)).toBe(false);
  });

  test("rejects lists, display names, whitespace and dotless domains", () => {
    for (const value of [
      "",
      "a@b.com,c@d.com",
      "Owner <owner@example.com>",
      " owner@example.com",
      "a b@c.d",
      "a@localhost",
      "no-at",
    ]) {
      expect(isEmailAddress(value)).toBe(false);
    }
  });
});

/**
 * The previous `EMAIL_RE` backtracked quadratically on a malformed piece
 * with many dots (about 1 s at 40 KB, 7 s at 100 KB). Pieces are now
 * length-capped before the regex runs, and the regex is linear, so even an
 * uncapped caller cannot stall the event loop. The budget is loose on
 * purpose (the old regex took 1 to 10 s on these inputs, the new one takes
 * milliseconds) so CI load never makes it flaky; a warm-up call keeps JIT
 * start-up out of the measurement.
 */
describe("parseRecipients: bounded time on adversarial input", () => {
  const BUDGET_MS = 1_000;

  function timed(to: string): number {
    parseRecipients("warm@example.org", null, null);
    const start = performance.now();
    parseRecipients(to, null, null);
    return performance.now() - start;
  }

  test.each([
    ["dot run", () => "a@" + ".".repeat(100_000) + "@"],
    ["dot-spaced", () => "a@" + "xxxxxxxxx.".repeat(10_000) + "@"],
    ["b. repeats", () => "a@" + "b.".repeat(50_000) + "@"],
    [
      "fifty 16 KB pieces",
      () =>
        Array(50)
          .fill("a@" + ".".repeat(16_000) + "@")
          .join(","),
    ],
  ])("%s", (_name, build) => {
    expect(timed(build())).toBeLessThan(BUDGET_MS);
  });

  test("a 10 MB benign recipient list stays fast", () => {
    const list = Array.from({ length: 400_000 }, (_, i) => `user${i}@example.org`).join(
      ",",
    );
    expect(list.length).toBeGreaterThan(8_000_000);
    expect(timed(list)).toBeLessThan(2_000);
  });
});
