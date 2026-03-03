import { describe, test, expect } from "bun:test";
import { hashApiKey, generateApiKey } from "../../src/utils/crypto.ts";

/**
 * Unit tests for crypto utilities.
 *
 * Tests API key generation and hashing — these are pure functions
 * with no dependencies, so no mocking needed.
 */

describe("hashApiKey", () => {
  test("returns a 64-char hex string (SHA-256)", () => {
    const hash = hashApiKey("bm_live_test123");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("is deterministic — same input always produces same hash", () => {
    const hash1 = hashApiKey("bm_live_test123");
    const hash2 = hashApiKey("bm_live_test123");
    expect(hash1).toBe(hash2);
  });

  test("different inputs produce different hashes", () => {
    const hash1 = hashApiKey("bm_live_aaa");
    const hash2 = hashApiKey("bm_live_bbb");
    expect(hash1).not.toBe(hash2);
  });
});

describe("generateApiKey", () => {
  test("raw key starts with bm_live_ prefix", () => {
    const { raw } = generateApiKey();
    expect(raw.startsWith("bm_live_")).toBe(true);
  });

  test("raw key has bm_live_ prefix + 32 hex chars", () => {
    const { raw } = generateApiKey();
    /** "bm_live_" = 8 chars, then 32 hex chars */
    expect(raw).toHaveLength(40);
    expect(raw.slice(8)).toMatch(/^[a-f0-9]{32}$/);
  });

  test("hash is a valid SHA-256 of the raw key", () => {
    const { raw, hash } = generateApiKey();
    expect(hash).toBe(hashApiKey(raw));
  });

  test("prefix is the first 12 chars of the raw key", () => {
    const { raw, prefix } = generateApiKey();
    expect(prefix).toBe(raw.slice(0, 12));
  });

  test("generates unique keys on each call", () => {
    const key1 = generateApiKey();
    const key2 = generateApiKey();
    expect(key1.raw).not.toBe(key2.raw);
  });
});
