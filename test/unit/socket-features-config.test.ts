import { describe, test, expect } from "bun:test";
import {
  readInboundTls,
  readSourceIps,
  runtimeHasSocketFeatures,
  sourceIpProblem,
  sourceIpWarnings,
  SOCKET_FEATURES_MIN_BUN,
} from "../../src/config.ts";

/**
 * Settings that need a Bun able to run server-side STARTTLS and bind a
 * source address (#414): Bun 1.4.4 and later, or Node.
 */
describe("runtimeHasSocketFeatures", () => {
  test("the minimum is 1.4.4", () => {
    expect(SOCKET_FEATURES_MIN_BUN).toBe("1.4.4");
  });

  test.each([null, "1.4.4", "1.4.10", "1.5.0", "2.0.0", "1.4.5-canary.3+abc"])(
    "%p has them",
    (version) => {
      expect(runtimeHasSocketFeatures(version)).toBe(true);
    },
  );

  test.each(["1.3.14", "1.4.0", "1.4.3", "0.9.99", "1.3.99", "not a version"])(
    "%p does not",
    (version) => {
      expect(runtimeHasSocketFeatures(version)).toBe(false);
    },
  );
});

/** `SMTP_TLS_CERT` / `SMTP_TLS_KEY` (#414): inbound STARTTLS, off by default. */
describe("readInboundTls", () => {
  const CERT = "/etc/bunmail/tls/mx.cert.pem";
  const KEY = "/etc/bunmail/tls/mx.key.pem";

  test("unset or blank: no STARTTLS, on any runtime", () => {
    expect(
      readInboundTls({ certPath: undefined, keyPath: undefined }, "1.3.14"),
    ).toBeNull();
    expect(readInboundTls({ certPath: " ", keyPath: "" }, "1.3.14")).toBeNull();
  });

  test.each([null, "1.4.4"])(
    "a cert and key under %p: their paths, trimmed",
    (version) => {
      expect(readInboundTls({ certPath: ` ${CERT} `, keyPath: KEY }, version)).toEqual({
        certPath: CERT,
        keyPath: KEY,
      });
    },
  );

  test.each(["1.3.14", "1.4.3"])("a cert under Bun %s refuses to boot", (version) => {
    /** A substring match, so the version needs no regex escaping. */
    expect(() => readInboundTls({ certPath: CERT, keyPath: KEY }, version)).toThrow(
      `SMTP_TLS_CERT needs Bun 1.4.4 or later, running ${version}`,
    );
  });

  test("a cert without a key, and a key without a cert, refuse to boot", () => {
    expect(() => readInboundTls({ certPath: CERT, keyPath: undefined }, null)).toThrow(
      /SMTP_TLS_CERT and SMTP_TLS_KEY must be set together/,
    );
    expect(() => readInboundTls({ certPath: "", keyPath: KEY }, null)).toThrow(
      /must be set together/,
    );
  });
});

/** `MAIL_SOURCE_IP` (#414): the local address outbound SMTP binds, per family. */
describe("readSourceIps", () => {
  test("unset or blank: no binding, on any runtime", () => {
    expect(readSourceIps(undefined, "1.3.14")).toEqual({ v4: null, v6: null });
    expect(readSourceIps(" , ", "1.3.14")).toEqual({ v4: null, v6: null });
  });

  test("one IPv4, one IPv6, or one of each, trimmed", () => {
    expect(readSourceIps("203.0.113.5", "1.4.4")).toEqual({
      v4: "203.0.113.5",
      v6: null,
    });
    expect(readSourceIps("2001:db8::5", null)).toEqual({ v4: null, v6: "2001:db8::5" });
    expect(readSourceIps(" 2001:db8::5 , 203.0.113.5 ", "1.4.4")).toEqual({
      v4: "203.0.113.5",
      v6: "2001:db8::5",
    });
  });

  test.each(["mail.example.com", "203.0.113.300", "203.0.113.5/32", "1.2.3"])(
    "refuses %p",
    (raw) => {
      expect(() => readSourceIps(raw, null)).toThrow(
        /MAIL_SOURCE_IP must be one IPv4 and\/or one IPv6 address/,
      );
    },
  );

  test.each([
    ["0.0.0.0", /unspecified/],
    ["0.1.2.3", /unspecified/],
    ["::", /unspecified/],
    ["0:0:0:0:0:0:0:0", /unspecified/],
    ["127.0.0.1", /loopback/],
    ["127.10.0.5", /loopback/],
    ["::1", /loopback/],
    ["169.254.10.1", /link-local/],
    ["fe80::1", /link-local/],
    ["FE80::abcd", /link-local/],
    ["fe80::1%eth0", /zone id/],
    ["224.0.0.1", /multicast/],
    ["239.255.255.250", /multicast/],
    ["ff02::1", /multicast/],
    ["255.255.255.255", /broadcast/],
    ["240.0.0.1", /broadcast or reserved/],
    ["::ffff:203.0.113.5", /IPv4-mapped/],
    ["::ffff:cb00:7105", /IPv4-mapped/],
    ["::203.0.113.5", /IPv4-compatible/],
  ])("refuses %p at boot", (raw, why) => {
    expect(() => readSourceIps(raw, null)).toThrow(
      /MAIL_SOURCE_IP must be a unicast address mail can leave from/,
    );
    expect(sourceIpProblem(raw)).toMatch(why);
  });

  test.each([
    "203.0.113.5",
    "10.0.0.5",
    "172.16.3.4",
    "192.168.1.20",
    "100.64.0.9",
    "2001:db8::5",
    "fd00::5",
  ])("accepts %p (private ranges too: they are right behind a 1:1 NAT)", (raw) => {
    expect(sourceIpProblem(raw)).toBeNull();
    expect(() => readSourceIps(raw, null)).not.toThrow();
  });

  test("refuses two addresses of one family", () => {
    expect(() => readSourceIps("203.0.113.5,203.0.113.6", null)).toThrow(
      /at most one IPv4 address/,
    );
    expect(() => readSourceIps("2001:db8::5,2001:db8::6", null)).toThrow(
      /at most one IPv6 address/,
    );
  });

  test.each(["1.3.14", "1.4.3"])("set under Bun %s refuses to boot", (version) => {
    expect(() => readSourceIps("203.0.113.5", version)).toThrow(
      /MAIL_SOURCE_IP needs Bun 1\.4\.4 or later[\s\S]*ignores the local address/,
    );
  });
});

/** Boot warnings about `MAIL_SOURCE_IP` (#414): never fatal. */
describe("sourceIpWarnings", () => {
  const LOCAL = ["127.0.0.1", "203.0.113.5", "::1", "2001:db8::5", "fe80::1%en0"];

  test("no setting: no warning", () => {
    expect(sourceIpWarnings({ v4: null, v6: null }, ["198.51.100.1"], LOCAL)).toEqual([]);
  });

  test("on an interface and equal to MAIL_PUBLIC_IP (or no MAIL_PUBLIC_IP): no warning", () => {
    const ips = { v4: "203.0.113.5", v6: "2001:DB8:0::5" };
    expect(sourceIpWarnings(ips, [], LOCAL)).toEqual([]);
    expect(sourceIpWarnings(ips, ["203.0.113.5", "2001:db8::5"], LOCAL)).toEqual([]);
  });

  test("on no interface: warns that outbound SMTP will fail", () => {
    const warnings = sourceIpWarnings({ v4: "192.0.2.1", v6: null }, [], LOCAL);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toMatch(/not an address of this host/);
    expect(warnings[0]?.fields["sourceIp"]).toBe("192.0.2.1");
  });

  test("not MAIL_PUBLIC_IP of its family: warns, naming the public addresses", () => {
    const warnings = sourceIpWarnings(
      { v4: "203.0.113.5", v6: "2001:db8::5" },
      ["198.51.100.1", "2001:db8::5"],
      LOCAL,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toMatch(/differs from MAIL_PUBLIC_IP/);
    expect(warnings[0]?.fields["publicIps"]).toEqual(["198.51.100.1"]);
  });

  test("MAIL_PUBLIC_IP of the other family only: no mismatch warning", () => {
    expect(
      sourceIpWarnings({ v4: "203.0.113.5", v6: null }, ["2001:db8::9"], LOCAL),
    ).toEqual([]);
  });
});
