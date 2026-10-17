import { describe, test, expect } from "bun:test";
import { dnsblQueryName } from "../../src/modules/inbound/services/dnsbl.service.ts";

const ZONE = "zen.spamhaus.org";

describe("dnsblQueryName (#166)", () => {
  test("public IPv4 is looked up with reversed octets", () => {
    expect(dnsblQueryName("1.2.3.4", ZONE)).toBe("4.3.2.1.zen.spamhaus.org");
  });

  /** The bug: startsWith("172.") skipped all of 172.0.0.0/8. Only 172.16.0.0/12 is private. */
  test.each([
    ["172.15.1.1", "1.1.15.172.zen.spamhaus.org"],
    ["172.15.255.255", "255.255.15.172.zen.spamhaus.org"],
    ["172.32.0.0", "0.0.32.172.zen.spamhaus.org"],
    ["172.32.1.1", "1.1.32.172.zen.spamhaus.org"],
    ["172.217.0.1", "1.0.217.172.zen.spamhaus.org"],
  ])("public 172.x address %s is checked", (ip, query) => {
    expect(dnsblQueryName(ip, ZONE)).toBe(query);
  });

  test.each([
    "172.16.0.0",
    "172.16.1.1",
    "172.31.255.255",
    "10.0.0.1",
    "192.168.1.1",
    /** all of loopback, not just the 127.0.0.1 literal */
    "127.0.0.1",
    "127.0.0.2",
    "127.255.255.255",
    /** link-local, incl. cloud metadata */
    "169.254.1.1",
    "169.254.169.254",
    /** CGNAT */
    "100.64.0.0",
    "100.127.255.255",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
  ])("non-public address %s is skipped", (ip) => {
    expect(dnsblQueryName(ip, ZONE)).toBeNull();
  });

  test("CGNAT boundaries: just outside 100.64.0.0/10 is checked", () => {
    expect(dnsblQueryName("100.63.255.255", ZONE)).toBe(
      "255.255.63.100.zen.spamhaus.org",
    );
    expect(dnsblQueryName("100.128.0.0", ZONE)).toBe("0.0.128.100.zen.spamhaus.org");
  });

  test("IPv6 is skipped (public and private)", () => {
    expect(dnsblQueryName("2606:4700:4700::1111", ZONE)).toBeNull();
    expect(dnsblQueryName("::1", ZONE)).toBeNull();
    expect(dnsblQueryName("fe80::1", ZONE)).toBeNull();
  });

  test("IPv4-mapped IPv6 is unwrapped before deciding", () => {
    expect(dnsblQueryName("::ffff:1.2.3.4", ZONE)).toBe("4.3.2.1.zen.spamhaus.org");
    expect(dnsblQueryName("::ffff:10.0.0.1", ZONE)).toBeNull();
  });

  test("malformed input is skipped, never queried", () => {
    expect(dnsblQueryName("not-an-ip", ZONE)).toBeNull();
    expect(dnsblQueryName("999.1.1.1", ZONE)).toBeNull();
    expect(dnsblQueryName("", ZONE)).toBeNull();
  });
});
