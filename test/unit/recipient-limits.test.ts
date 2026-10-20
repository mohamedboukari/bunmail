import { describe, test, expect } from "bun:test";
import {
  joinToList,
  MAX_TO_RECIPIENTS,
  MAX_TOTAL_RECIPIENTS,
  normalizeToList,
  recipientCapProblem,
  splitToList,
} from "../../src/modules/emails/services/recipient-limits.ts";

/**
 * The `to` list and the recipient caps (#178): normalization of a string
 * or an array, case-insensitive deduplication, the 50 `to` cap and the 100
 * combined cap across to, cc and bcc.
 */

/** `n` distinct addresses at `domain`. */
function addresses(n: number, domain = "example.com"): string[] {
  return Array.from({ length: n }, (_, i) => `u${i}@${domain}`);
}

describe("normalizeToList", () => {
  test("one address as a string", () => {
    expect(normalizeToList("a@example.com")).toEqual(["a@example.com"]);
  });

  test("an array keeps its order", () => {
    expect(normalizeToList(["b@example.com", "a@example.com"])).toEqual([
      "b@example.com",
      "a@example.com",
    ]);
  });

  test("a comma-separated string (SMTP submission, stored rows) is split and trimmed", () => {
    expect(normalizeToList(" a@example.com ,b@example.org,, ")).toEqual([
      "a@example.com",
      "b@example.org",
    ]);
  });

  test("deduplicates ignoring case, the first spelling wins", () => {
    expect(
      normalizeToList([
        "Bob@Example.com",
        "a@example.com",
        "bob@example.COM",
        "A@example.com",
      ]),
    ).toEqual(["Bob@Example.com", "a@example.com"]);
  });

  test("drops empty and whitespace items", () => {
    expect(normalizeToList(["", "  ", "a@example.com"])).toEqual(["a@example.com"]);
  });
});

describe("joinToList / splitToList", () => {
  test("round-trip through the stored form", () => {
    const list = ["a@example.com", "b@example.org"];
    expect(joinToList(list)).toBe("a@example.com, b@example.org");
    expect(splitToList(joinToList(list))).toEqual(list);
  });

  test("a single stored address is one item", () => {
    expect(splitToList("a@example.com")).toEqual(["a@example.com"]);
  });
});

describe("recipientCapProblem", () => {
  test("exactly 50 to addresses and 100 recipients in total pass", () => {
    expect(recipientCapProblem(addresses(MAX_TO_RECIPIENTS), null, null)).toBeNull();
    expect(
      recipientCapProblem(
        addresses(50),
        addresses(25, "cc.example").join(", "),
        addresses(25, "bcc.example").join(","),
      ),
    ).toBeNull();
  });

  test("51 to addresses break the to cap", () => {
    expect(recipientCapProblem(addresses(MAX_TO_RECIPIENTS + 1), null, null)).toBe("to");
  });

  test("101 unique recipients across to, cc and bcc break the total cap", () => {
    expect(
      recipientCapProblem(
        addresses(50),
        addresses(26, "cc.example").join(","),
        addresses(25, "bcc.example").join(","),
      ),
    ).toBe("total");
    expect(MAX_TOTAL_RECIPIENTS).toBe(100);
  });

  test("an address repeated across fields counts once", () => {
    const to = addresses(50);
    expect(
      recipientCapProblem(to, to.join(","), addresses(50, "bcc.example").join(",")),
    ).toBeNull();
  });
});
