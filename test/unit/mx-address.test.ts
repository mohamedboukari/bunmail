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

/**
 * Awaits `promise` and returns what it rejected with (`undefined` if it
 * resolved), so every rejection assertion is awaited explicitly.
 */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return err;
  }
}

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
    ["IPv4-mapped loopback, hex groups", "::ffff:7f00:1"],
    ["IPv4-mapped metadata, hex groups", "::ffff:a9fe:a9fe"],
  ])("refuses %s", async (_label, address) => {
    expect(
      await rejectionOf(resolveMxAddress("mx.example.org", strict(answers(address)))),
    ).toBeInstanceOf(BlockedMxError);
  });

  test("refuses when any one of several addresses is private", async () => {
    expect(
      await rejectionOf(
        resolveMxAddress("mx.example.org", strict(answers("203.0.113.10", "10.0.0.5"))),
      ),
    ).toBeInstanceOf(BlockedMxError);
  });

  test("checks an IP-literal MX without DNS", async () => {
    const lookup = async (): Promise<{ address: string }[]> => {
      throw new Error("lookup must not be called");
    };
    expect(
      await rejectionOf(resolveMxAddress("127.0.0.1", { allowPrivate: false, lookup })),
    ).toBeInstanceOf(BlockedMxError);
    expect(await resolveMxAddress("203.0.113.10", { allowPrivate: false, lookup })).toBe(
      "203.0.113.10",
    );
  });

  test("refuses a null MX instead of falling back to a default host", async () => {
    expect(
      await rejectionOf(resolveMxAddress("", strict(answers("203.0.113.10")))),
    ).toEqual(expect.objectContaining({ message: expect.stringContaining("null MX") }));
    expect(
      await rejectionOf(resolveMxAddress(".", strict(answers("203.0.113.10")))),
    ).toEqual(expect.objectContaining({ message: expect.stringContaining("null MX") }));
  });

  test("refuses an unresolvable host or an empty answer", async () => {
    const failing = async (): Promise<{ address: string }[]> => {
      throw new Error("ENOTFOUND");
    };
    expect(
      await rejectionOf(resolveMxAddress("mx.example.org", strict(failing))),
    ).toBeInstanceOf(BlockedMxError);
    expect(
      await rejectionOf(resolveMxAddress("mx.example.org", strict(answers()))),
    ).toBeInstanceOf(BlockedMxError);
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
      await rejectionOf(resolveMxAddress("mx.example.org", strict(answers("10.9.8.7")))),
    ).toEqual(
      expect.objectContaining({
        message: expect.stringMatching(/^(?!.*10\.9\.8\.7).*non-public/),
      }),
    );
  });
});
