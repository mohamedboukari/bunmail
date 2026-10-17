import { describe, test, expect } from "bun:test";
import {
  BlockedMxError,
  resolveMxAddress,
} from "../../src/modules/emails/services/mx-address.ts";

/**
 * Outbound SSRF guard for direct-to-MX delivery. Pure: the DNS lookup is
 * injected, so no network and no `mock.module`.
 */

/** A lookup that always answers with `addresses`. */
function answers(...addresses: string[]) {
  return async () => addresses.map((address) => ({ address }));
}

const strict = (lookup: ReturnType<typeof answers>) => ({ allowPrivate: false, lookup });

describe("resolveMxAddress", () => {
  test("returns a public address", async () => {
    expect(
      await resolveMxAddress("mx.example.org", strict(answers("203.0.113.10"))),
    ).toBe("203.0.113.10");
  });

  test.each([
    ["loopback", "127.0.0.1"],
    ["private 10/8", "10.1.2.3"],
    ["private 192.168/16", "192.168.1.25"],
    ["link-local metadata", "169.254.169.254"],
    ["IPv6 loopback", "::1"],
    ["IPv6 ULA", "fd00::25"],
  ])("refuses %s", async (_label, address) => {
    expect(resolveMxAddress("mx.example.org", strict(answers(address)))).rejects.toThrow(
      BlockedMxError,
    );
  });

  test("refuses when any one of several addresses is private", async () => {
    expect(
      resolveMxAddress("mx.example.org", strict(answers("203.0.113.10", "10.0.0.5"))),
    ).rejects.toThrow(BlockedMxError);
  });

  test("checks an IP-literal MX without DNS", async () => {
    const lookup = async (): Promise<{ address: string }[]> => {
      throw new Error("lookup must not be called");
    };
    expect(
      resolveMxAddress("127.0.0.1", { allowPrivate: false, lookup }),
    ).rejects.toThrow(BlockedMxError);
    expect(await resolveMxAddress("203.0.113.10", { allowPrivate: false, lookup })).toBe(
      "203.0.113.10",
    );
  });

  test("refuses a null MX instead of falling back to a default host", async () => {
    expect(resolveMxAddress("", strict(answers("203.0.113.10")))).rejects.toThrow(
      "null MX",
    );
    expect(resolveMxAddress(".", strict(answers("203.0.113.10")))).rejects.toThrow(
      "null MX",
    );
  });

  test("refuses an unresolvable host or an empty answer", async () => {
    const failing = async (): Promise<{ address: string }[]> => {
      throw new Error("ENOTFOUND");
    };
    expect(resolveMxAddress("mx.example.org", strict(failing))).rejects.toThrow(
      BlockedMxError,
    );
    expect(resolveMxAddress("mx.example.org", strict(answers()))).rejects.toThrow(
      BlockedMxError,
    );
  });

  test("prefers IPv4 over IPv6", async () => {
    expect(
      await resolveMxAddress(
        "mx.example.org",
        strict(answers("2001:db8::25", "203.0.113.10")),
      ),
    ).toBe("203.0.113.10");
  });

  test("MAIL_ALLOW_PRIVATE_MX allows private addresses", async () => {
    expect(
      await resolveMxAddress("mail.internal", {
        allowPrivate: true,
        lookup: answers("10.0.0.5"),
      }),
    ).toBe("10.0.0.5");
  });

  test("the error message does not include the resolved address", async () => {
    expect(
      resolveMxAddress("mx.example.org", strict(answers("10.9.8.7"))),
    ).rejects.toThrow(/^(?!.*10\.9\.8\.7).*non-public/);
  });
});
