import { describe, test, expect } from "bun:test";
import { serializeDomain } from "../../src/modules/domains/serializations/domain.serialization.ts";

/**
 * Unit tests for domain serialization.
 *
 * Verifies that sensitive fields (DKIM private key) are stripped
 * from the public API response shape.
 */

describe("serializeDomain", () => {
  const domain = {
    id: "dom_abc123",
    name: "example.com",
    dkimPrivateKey: "-----BEGIN RSA PRIVATE KEY-----\nSECRET\n-----END RSA PRIVATE KEY-----",
    dkimPublicKey: "-----BEGIN PUBLIC KEY-----\nPUBLIC\n-----END PUBLIC KEY-----",
    dkimSelector: "bunmail",
    spfVerified: true,
    dkimVerified: false,
    dmarcVerified: false,
    verifiedAt: new Date("2024-06-01"),
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
  };

  test("includes public fields", () => {
    const result = serializeDomain(domain);
    expect(result.id).toBe("dom_abc123");
    expect(result.name).toBe("example.com");
    expect(result.dkimSelector).toBe("bunmail");
    expect(result.spfVerified).toBe(true);
    expect(result.dkimVerified).toBe(false);
    expect(result.dmarcVerified).toBe(false);
    expect(result.verifiedAt).toEqual(new Date("2024-06-01"));
    expect(result.createdAt).toEqual(new Date("2024-01-01"));
  });

  test("strips dkimPrivateKey from output", () => {
    const result = serializeDomain(domain);
    expect("dkimPrivateKey" in result).toBe(false);
  });

  test("strips dkimPublicKey from output", () => {
    const result = serializeDomain(domain);
    expect("dkimPublicKey" in result).toBe(false);
  });

  test("strips updatedAt from output", () => {
    const result = serializeDomain(domain);
    expect("updatedAt" in result).toBe(false);
  });
});
