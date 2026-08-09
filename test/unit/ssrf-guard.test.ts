import { describe, test, expect } from "bun:test";
import {
  isBlockedIp,
  assertPublicWebhookUrl,
  BlockedUrlError,
} from "../../src/utils/ssrf-guard.ts";

/**
 * Unit tests for the webhook SSRF guard (#128). The IP checks and the
 * scheme / literal-IP-host branches are pure (no DNS), so they're tested
 * directly. Hostname DNS-resolution is exercised in the integration tier.
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

  test("allows public IPv6", () => {
    expect(isBlockedIp("2606:4700:4700::1111")).toBe(false);
  });

  test("refuses garbage", () => {
    expect(isBlockedIp("not-an-ip")).toBe(true);
    expect(isBlockedIp("999.1.1.1")).toBe(true);
  });
});

describe("assertPublicWebhookUrl — scheme & literal-IP checks", () => {
  test("rejects a literal metadata IP", async () => {
    await expect(
      assertPublicWebhookUrl("http://169.254.169.254/latest/meta-data/", true),
    ).rejects.toBeInstanceOf(BlockedUrlError);
  });

  test("rejects loopback and private literals", async () => {
    await expect(
      assertPublicWebhookUrl("http://127.0.0.1:5432/", true),
    ).rejects.toThrow();
    await expect(assertPublicWebhookUrl("https://10.0.0.5/hook", true)).rejects.toThrow();
    await expect(assertPublicWebhookUrl("http://[::1]/x", true)).rejects.toThrow();
  });

  test("rejects http when not allowed; message points at the opt-in", async () => {
    await expect(assertPublicWebhookUrl("http://8.8.8.8/hook", false)).rejects.toThrow(
      /https/,
    );
  });

  test("allows http to a public literal IP when opted in", async () => {
    await expect(
      assertPublicWebhookUrl("http://8.8.8.8/hook", true),
    ).resolves.toBeUndefined();
  });

  test("rejects non-http(s) schemes", async () => {
    await expect(assertPublicWebhookUrl("file:///etc/passwd", true)).rejects.toThrow();
    await expect(assertPublicWebhookUrl("gopher://127.0.0.1/", true)).rejects.toThrow();
  });

  test("rejects a non-URL", async () => {
    await expect(assertPublicWebhookUrl("not a url", true)).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
  });

  test("allows a public https literal IP", async () => {
    await expect(
      assertPublicWebhookUrl("https://1.1.1.1/hook", false),
    ).resolves.toBeUndefined();
  });
});
