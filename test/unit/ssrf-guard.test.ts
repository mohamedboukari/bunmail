import { describe, test, expect } from "bun:test";
import {
  isBlockedIp,
  assertPublicWebhookUrl,
  BlockedUrlError,
  resolvePublicWebhookTarget,
  type ResolveAll,
} from "../../src/utils/ssrf-guard.ts";

/**
 * Unit tests for the webhook SSRF guard (#128). The IP checks and the
 * scheme / literal-IP-host branches are pure (no DNS), so they're tested
 * directly. Hostname resolution goes through an injected resolver.
 */

describe("isBlockedIp", () => {
  test("blocks IPv4 private / loopback / link-local / metadata ranges", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "0.0.0.0",
      "100.64.0.1", // CGNAT
      "224.0.0.1", // multicast
    ]) {
      expect(isBlockedIp(ip)).toBe(true);
    }
  });

  test("allows normal public IPv4", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1"]) {
      expect(isBlockedIp(ip)).toBe(false);
    }
  });

  test("blocks IPv6 loopback / ULA / link-local / v4-mapped-private", () => {
    for (const ip of [
      "::1",
      "::",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isBlockedIp(ip)).toBe(true);
    }
  });

  test("blocks IPv4-mapped / compatible / NAT64 IPv6 in hex-group form too", () => {
    for (const ip of [
      "::ffff:7f00:1", // 127.0.0.1
      "::ffff:7F00:0001",
      "0:0:0:0:0:ffff:7f00:1",
      "::ffff:a9fe:a9fe", // 169.254.169.254
      "::ffff:169.254.169.254",
      "::ffff:a00:5", // 10.0.0.5
      "::ffff:c0a8:101", // 192.168.1.1
      "::ffff:6440:1", // 100.64.0.1 (CGNAT)
      "::7f00:1", // IPv4-compatible 127.0.0.1
      "::127.0.0.1",
      "64:ff9b::a9fe:a9fe", // NAT64 169.254.169.254
      "64:ff9b::10.0.0.5",
    ]) {
      expect({ ip, blocked: isBlockedIp(ip) }).toEqual({ ip, blocked: true });
    }
  });

  test("ULA / link-local stay blocked whatever their low bits", () => {
    for (const ip of ["fc00::8.8.8.8", "fe80::1%eth0", "fe80::808:808", "fd00::1"]) {
      expect({ ip, blocked: isBlockedIp(ip) }).toEqual({ ip, blocked: true });
    }
  });

  test("allows public IPv6, and mapped forms of a public IPv4", () => {
    for (const ip of [
      "2606:4700:4700::1111",
      "::ffff:808:808", // 8.8.8.8
      "::ffff:8.8.8.8",
      "64:ff9b::808:808",
      "2002:808:808::1", // 6to4 of 8.8.8.8
      "2001:0:4136:e378:8000:63bf:3fff:fdd2", // Teredo: not unpacked
    ]) {
      expect({ ip, blocked: isBlockedIp(ip) }).toEqual({ ip, blocked: false });
    }
  });

  test("blocks site-local, multicast and local-use NAT64", () => {
    for (const ip of [
      "fec0::1", // site-local
      "feff::1",
      "ff02::1", // multicast
      "ff05::1:3",
      "ff0e::101",
      "64:ff9b:1::808:808", // local-use NAT64, even with a public IPv4
      "64:ff9b:1:ffff::1",
    ]) {
      expect({ ip, blocked: isBlockedIp(ip) }).toEqual({ ip, blocked: true });
    }
  });

  test("judges 6to4 (2002::/16) by its embedded IPv4", () => {
    for (const ip of [
      "2002:7f00:1::", // 127.0.0.1
      "2002:a9fe:a9fe::1", // 169.254.169.254
      "2002:a00:5::", // 10.0.0.5
      "2002:c0a8:101:1::1", // 192.168.1.1
    ]) {
      expect({ ip, blocked: isBlockedIp(ip) }).toEqual({ ip, blocked: true });
    }
    expect(isBlockedIp("2002:5db8:d822::1")).toBe(false); // 93.184.216.34
  });

  test("refuses garbage", () => {
    expect(isBlockedIp("not-an-ip")).toBe(true);
    expect(isBlockedIp("999.1.1.1")).toBe(true);
  });
});

describe("assertPublicWebhookUrl: scheme & literal-IP checks", () => {
  test("rejects a literal metadata IP", async () => {
    expect(
      assertPublicWebhookUrl("http://169.254.169.254/latest/meta-data/", true),
    ).rejects.toBeInstanceOf(BlockedUrlError);
  });

  test("rejects loopback and private literals", async () => {
    expect(assertPublicWebhookUrl("http://127.0.0.1:5432/", true)).rejects.toThrow();
    expect(assertPublicWebhookUrl("https://10.0.0.5/hook", true)).rejects.toThrow();
    expect(assertPublicWebhookUrl("http://[::1]/x", true)).rejects.toThrow();
  });

  test("rejects http when not allowed; message points at the opt-in", async () => {
    expect(assertPublicWebhookUrl("http://8.8.8.8/hook", false)).rejects.toThrow(/https/);
  });

  test("allows http to a public literal IP when opted in", async () => {
    expect(assertPublicWebhookUrl("http://8.8.8.8/hook", true)).resolves.toBeUndefined();
  });

  test("rejects non-http(s) schemes", async () => {
    expect(assertPublicWebhookUrl("file:///etc/passwd", true)).rejects.toThrow();
    expect(assertPublicWebhookUrl("gopher://127.0.0.1/", true)).rejects.toThrow();
  });

  test("rejects a non-URL", async () => {
    expect(assertPublicWebhookUrl("not a url", true)).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
  });

  test("allows a public https literal IP", async () => {
    expect(
      assertPublicWebhookUrl("https://1.1.1.1/hook", false),
    ).resolves.toBeUndefined();
  });
});

/** Settles `promise` and returns what it rejected with (or `undefined`). */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return err;
  }
}

/** A resolver that answers `addresses` and records every host asked. */
function fakeResolver(addresses: string[]): { resolve: ResolveAll; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    resolve: (host) => {
      calls.push(host);
      return Promise.resolve(addresses.map((address) => ({ address })));
    },
  };
}

describe("resolvePublicWebhookTarget", () => {
  test("returns the URL, host name and the validated public address", async () => {
    const { resolve, calls } = fakeResolver(["93.184.216.34"]);
    const target = await resolvePublicWebhookTarget(
      "https://hook.example.test:8443/x?y=1",
      false,
      resolve,
    );
    expect(calls).toEqual(["hook.example.test"]);
    expect(target.hostname).toBe("hook.example.test");
    expect(target.isIpLiteral).toBe(false);
    expect(target.address).toBe("93.184.216.34");
    expect(target.family).toBe(4);
    expect(target.url.href).toBe("https://hook.example.test:8443/x?y=1");
  });

  test("prefers an IPv4 address, else the first IPv6", async () => {
    const mixed = fakeResolver(["2606:4700:4700::1111", "93.184.216.34"]);
    const v4 = await resolvePublicWebhookTarget(
      "https://h.example.test/",
      false,
      mixed.resolve,
    );
    expect(v4.address).toBe("93.184.216.34");

    const v6only = fakeResolver(["2606:4700:4700::1111"]);
    const v6 = await resolvePublicWebhookTarget(
      "https://h.example.test/",
      false,
      v6only.resolve,
    );
    expect(v6.address).toBe("2606:4700:4700::1111");
    expect(v6.family).toBe(6);
  });

  test("rejects when ANY resolved address is private, without naming it", async () => {
    for (const bad of [
      "127.0.0.1",
      "10.0.0.5",
      "::ffff:7f00:1",
      "::ffff:a9fe:a9fe",
      "fd00::1",
    ]) {
      const { resolve } = fakeResolver(["93.184.216.34", bad]);
      const err = await resolvePublicWebhookTarget(
        "https://h.example.test/",
        false,
        resolve,
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BlockedUrlError);
      expect(err instanceof Error ? err.message : "").not.toContain(bad);
    }
  });

  test("rejects a scoped (zone id) address, even a public-looking one", async () => {
    for (const scoped of ["fe80::1%eth0", "2606:4700:4700::1111%eth0"]) {
      const { resolve } = fakeResolver([scoped]);
      expect(
        await rejectionOf(
          resolvePublicWebhookTarget("https://h.example.test/", false, resolve),
        ),
      ).toBeInstanceOf(BlockedUrlError);
    }
  });

  test("rejects an unresolvable host and an empty answer", async () => {
    const failing: ResolveAll = () => Promise.reject(new Error("ENOTFOUND"));
    expect(
      await rejectionOf(
        resolvePublicWebhookTarget("https://h.example.test/", false, failing),
      ),
    ).toEqual(
      expect.objectContaining({
        message: expect.stringMatching(/could not be resolved/),
      }),
    );
    expect(
      await rejectionOf(
        resolvePublicWebhookTarget(
          "https://h.example.test/",
          false,
          fakeResolver([]).resolve,
        ),
      ),
    ).toEqual(
      expect.objectContaining({ message: expect.stringMatching(/no addresses/) }),
    );
  });

  test("IP-literal hosts are checked directly, never resolved", async () => {
    const { resolve, calls } = fakeResolver(["127.0.0.1"]);
    const v4 = await resolvePublicWebhookTarget("https://1.1.1.1/hook", false, resolve);
    expect(v4).toMatchObject({ address: "1.1.1.1", isIpLiteral: true, family: 4 });

    const v6 = await resolvePublicWebhookTarget(
      "https://[2606:4700:4700::1111]/hook",
      false,
      resolve,
    );
    expect(v6).toMatchObject({
      address: "2606:4700:4700::1111",
      isIpLiteral: true,
      family: 6,
    });
    expect(calls).toEqual([]);

    for (const url of [
      "https://127.0.0.1/",
      "https://[::1]/",
      "https://[::ffff:7f00:1]/",
      "https://[::ffff:169.254.169.254]/",
      "https://[::ffff:a9fe:a9fe]/",
      "https://169.254.169.254/",
    ]) {
      expect(
        await rejectionOf(resolvePublicWebhookTarget(url, false, resolve)),
      ).toBeInstanceOf(BlockedUrlError);
    }
  });

  test("scheme rules are unchanged", async () => {
    const { resolve } = fakeResolver(["93.184.216.34"]);
    expect(
      await rejectionOf(
        resolvePublicWebhookTarget("http://h.example.test/", false, resolve),
      ),
    ).toEqual(expect.objectContaining({ message: expect.stringMatching(/https/) }));
    expect(
      await resolvePublicWebhookTarget("http://h.example.test/", true, resolve),
    ).toMatchObject({ address: "93.184.216.34" });
    expect(
      await rejectionOf(
        resolvePublicWebhookTarget("ftp://h.example.test/", true, resolve),
      ),
    ).toBeInstanceOf(BlockedUrlError);
  });
});
