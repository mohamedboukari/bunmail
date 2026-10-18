import { describe, test, expect } from "bun:test";
import { readPublicIps } from "../../src/config.ts";

/** `MAIL_PUBLIC_IP` (#247, #248): optional list of the server's public sending IPs. */
describe("readPublicIps", () => {
  test("unset or blank: none", () => {
    expect(readPublicIps(undefined)).toEqual([]);
    expect(readPublicIps("  ")).toEqual([]);
  });

  test("IPv4 and IPv6, trimmed, deduplicated", () => {
    expect(readPublicIps(" 203.0.113.10, 2001:db8::10 ,203.0.113.10")).toEqual([
      "203.0.113.10",
      "2001:db8::10",
    ]);
  });

  test.each(["mail.example.com", "203.0.113.300", "203.0.113.10/32", "1.2.3"])(
    "refuses %p",
    (raw) => {
      expect(() => readPublicIps(raw)).toThrow(/MAIL_PUBLIC_IP/);
    },
  );
});
