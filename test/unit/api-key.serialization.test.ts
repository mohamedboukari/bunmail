import { describe, test, expect } from "bun:test";
import { serializeApiKey } from "../../src/modules/api-keys/serializations/api-key.serialization.ts";

/**
 * Unit tests for API key serialization.
 *
 * Verifies that the key hash is stripped from the public response
 * and only safe-to-expose fields are included.
 */

describe("serializeApiKey", () => {
  const apiKey = {
    id: "key_abc123",
    name: "Production Key",
    keyHash: "deadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678",
    keyPrefix: "bm_live_abcd",
    isActive: true,
    lastUsedAt: new Date("2024-06-15"),
    createdAt: new Date("2024-01-01"),
  };

  test("includes public fields", () => {
    const result = serializeApiKey(apiKey);
    expect(result.id).toBe("key_abc123");
    expect(result.name).toBe("Production Key");
    expect(result.keyPrefix).toBe("bm_live_abcd");
    expect(result.isActive).toBe(true);
    expect(result.lastUsedAt).toEqual(new Date("2024-06-15"));
    expect(result.createdAt).toEqual(new Date("2024-01-01"));
  });

  test("strips keyHash from output", () => {
    const result = serializeApiKey(apiKey);
    expect("keyHash" in result).toBe(false);
  });
});
