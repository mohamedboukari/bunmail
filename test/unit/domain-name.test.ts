import { describe, test, expect } from "bun:test";
import {
  normalizeDomainName,
  parseDomainName,
} from "../../src/modules/domains/services/domain-name.ts";

/**
 * Domain names on create (#406): normalised (trim, lowercase, one final
 * dot dropped, a Unicode IDN to its A-label), then refused unless a host
 * name of at least two LDH labels, 253 characters at most.
 */
describe("parseDomainName", () => {
  test.each([
    ["example.com", "example.com"],
    ["Example.COM.", "example.com"],
    ["  Example.COM  ", "example.com"],
    ["mail.sub.example.co.uk", "mail.sub.example.co.uk"],
    ["bücher.example", "xn--bcher-kva.example"],
    ["BÜCHER.Example.", "xn--bcher-kva.example"],
    ["xn--bcher-kva.example", "xn--bcher-kva.example"],
    ["a-b.example", "a-b.example"],
    ["1and1.com", "1and1.com"],
  ])("accepts %p as %p", (input, stored) => {
    expect(parseDomainName(input)).toBe(stored);
  });

  test.each([
    [""],
    ["   "],
    ["."],
    ["localhost"],
    ["localhost."],
    ["exa mple.com"],
    ["-bad.com"],
    ["bad-.com"],
    ["https://example.com"],
    ["example.com/path"],
    ["example.com:25"],
    ["user@example.com"],
    ["example..com"],
    ["example.com.."],
    [".example.com"],
    ["exa_mple.com"],
    ["exa\tmple.com"],
    ["bü\tcher.example"],
    ["bü cher.example"],
    ["https://bücher.example"],
    ["bücher.example:25"],
    ["192.168.1.1"],
    ["１２７.０.０.１"],
    ["[::1]"],
  ])("refuses %p", (input) => {
    expect(parseDomainName(input)).toBeNull();
  });

  test("refuses a label of 64 characters, accepts one of 63", () => {
    expect(parseDomainName(`${"a".repeat(64)}.com`)).toBeNull();
    expect(parseDomainName(`${"a".repeat(63)}.com`)).toBe(`${"a".repeat(63)}.com`);
  });

  test("refuses a name over 253 characters, accepts one of 253", () => {
    /** Four labels of 63 and one of 1 joined by dots: 4 * 63 + 1 + 4 = 257. */
    const tooLong = [...Array<string>(4).fill("a".repeat(63)), "b"].join(".");
    expect(tooLong.length).toBe(257);
    expect(parseDomainName(tooLong)).toBeNull();

    /** 3 * 63 + 61 + 3 dots = 253. */
    const longest = [...Array<string>(3).fill("a".repeat(63)), "b".repeat(61)].join(".");
    expect(longest.length).toBe(253);
    expect(parseDomainName(longest)).toBe(longest);
    /** The final dot does not count. */
    expect(parseDomainName(`${longest}.`)).toBe(longest);
  });
});

describe("normalizeDomainName", () => {
  test("drops one final dot only", () => {
    expect(normalizeDomainName("example.com.")).toBe("example.com");
    expect(normalizeDomainName("example.com..")).toBe("example.com.");
  });

  test("lowercases an ASCII name", () => {
    expect(normalizeDomainName("EXAMPLE.Com")).toBe("example.com");
  });

  test("maps a Unicode name as IDNA does: the stored form is what DNS resolves", () => {
    /** The Kelvin sign maps to `k` (UTS 46), as in a browser. */
    expect(normalizeDomainName(`${String.fromCharCode(0x212a)}example.com`)).toBe(
      "kexample.com",
    );
    /** Full-width letters map to ASCII ones. */
    expect(normalizeDomainName(`${String.fromCharCode(0xff25, 0xff38)}.com`)).toBe(
      "ex.com",
    );
  });

  test("keeps a Unicode name that does not convert, for the check to refuse", () => {
    expect(normalizeDomainName("bü cher.example")).toBe("bü cher.example");
  });
});
