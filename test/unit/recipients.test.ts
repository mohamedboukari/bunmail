import { describe, test, expect } from "bun:test";
import {
  parseRecipients,
  groupByMx,
  type MxResolver,
} from "../../src/utils/recipients.ts";

/**
 * Unit tests for the recipient parser + MX grouper (#87 phase 1).
 *
 * No network involved — the MX resolver is a plain function the
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
    /** Only one Alice — and she stays `to` (first occurrence wins),
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

describe("groupByMx", () => {
  /**
   * Trivial resolver that maps domain → fixed MX string. Each test
   * builds its own to model the topology it cares about.
   */
  function makeResolver(map: Record<string, string | Error>): MxResolver {
    return async (domain: string) => {
      const v = map[domain];
      if (v instanceof Error) throw v;
      if (!v) throw new Error(`No MX for ${domain}`);
      return v;
    };
  }

  test("buckets recipients by their domain's MX", async () => {
    const recipients = parseRecipients(
      "a@gmail.com, b@gmail.com, c@outlook.com",
      null,
      null,
    );
    const resolver = makeResolver({
      "gmail.com": "smtp.gmail.com",
      "outlook.com": "smtp.outlook.com",
    });
    const { groups, failures } = await groupByMx(recipients, resolver);
    expect(failures).toEqual([]);
    expect(groups.size).toBe(2);
    expect(groups.get("smtp.gmail.com")!.map((r) => r.address)).toEqual([
      "a@gmail.com",
      "b@gmail.com",
    ]);
    expect(groups.get("smtp.outlook.com")!.map((r) => r.address)).toEqual([
      "c@outlook.com",
    ]);
  });

  test("merges recipients on different domains sharing the same MX", async () => {
    const recipients = parseRecipients("a@hello.com, b@world.com", null, null);
    const resolver = makeResolver({
      "hello.com": "shared-mx.example.net",
      "world.com": "shared-mx.example.net",
    });
    const { groups, failures } = await groupByMx(recipients, resolver);
    expect(failures).toEqual([]);
    expect(groups.size).toBe(1);
    expect(groups.get("shared-mx.example.net")!.map((r) => r.address)).toEqual([
      "a@hello.com",
      "b@world.com",
    ]);
  });

  test("reports DNS failures separately without aborting other groups", async () => {
    const recipients = parseRecipients("good@valid.com, bad@nomx.example", null, null);
    const resolver = makeResolver({
      "valid.com": "mx.valid.com",
      "nomx.example": new Error("No MX records found for domain: nomx.example"),
    });
    const { groups, failures } = await groupByMx(recipients, resolver);

    expect(groups.size).toBe(1);
    expect(groups.get("mx.valid.com")!.map((r) => r.address)).toEqual(["good@valid.com"]);

    expect(failures).toHaveLength(1);
    expect(failures[0]!.domain).toBe("nomx.example");
    expect(failures[0]!.recipients.map((r) => r.address)).toEqual(["bad@nomx.example"]);
    expect(failures[0]!.error).toMatch(/No MX records/);
  });

  test("issues exactly one resolution per unique domain", async () => {
    /** 4 recipients across only 2 domains → 2 resolver calls, not 4. */
    const recipients = parseRecipients("a@x.com, b@x.com", "c@y.com, d@y.com", null);
    let callCount = 0;
    const resolver: MxResolver = async (d) => {
      callCount++;
      return `mx.${d}`;
    };
    await groupByMx(recipients, resolver);
    expect(callCount).toBe(2);
  });

  test("returns empty groups + empty failures for an empty input", async () => {
    const { groups, failures } = await groupByMx([], async () => "mx.unused");
    expect(groups.size).toBe(0);
    expect(failures).toEqual([]);
  });
});
