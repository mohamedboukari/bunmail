import { describe, test, expect } from "bun:test";
import { randomBytes } from "crypto";
import {
  hashApiKey,
  generateApiKey,
  encryptSecret,
  decryptSecret,
  isEncryptedSecret,
} from "../../src/utils/crypto.ts";

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

/**
 * Tests for the AES-256-GCM secret encryption helpers used to protect
 * `domains.dkim_private_key` at rest (#23).
 */
describe("encryptSecret / decryptSecret", () => {
  const key = randomBytes(32);
  /**
   * Synthetic plaintext fixture. Encryption is byte-agnostic — the
   * helpers don't care whether the input is PEM, JSON, or arbitrary
   * UTF-8 — so we deliberately avoid a PEM-shaped string here to keep
   * static-analysis scanners (gitleaks, etc.) from flagging the test
   * file as containing a literal key.
   */
  const samplePlaintext =
    "DKIM-PRIVATE-KEY-FAKE-FIXTURE — encryption is byte-agnostic and this is not a real key.";

  test("round-trips a UTF-8 plaintext", () => {
    const ciphertext = encryptSecret(samplePlaintext, key);
    expect(decryptSecret(ciphertext, key)).toBe(samplePlaintext);
  });

  test("output uses the v1: versioned prefix and 4-segment shape", () => {
    const ciphertext = encryptSecret(samplePlaintext, key);
    const segments = ciphertext.split(":");
    expect(segments).toHaveLength(4);
    expect(segments[0]).toBe("v1");
  });

  test("two encryptions of the same plaintext produce different ciphertexts (random IV)", () => {
    const a = encryptSecret(samplePlaintext, key);
    const b = encryptSecret(samplePlaintext, key);
    expect(a).not.toBe(b);
  });

  test("tampering with the ciphertext segment fails decryption", () => {
    const original = encryptSecret(samplePlaintext, key);
    const [version, iv, ct, tag] = original.split(":");
    /** Flip a single byte inside the ciphertext segment. */
    const tampered = Buffer.from(ct!, "base64");
    tampered[0] = tampered[0]! ^ 0x01;
    const broken = [version, iv, tampered.toString("base64"), tag].join(":");
    expect(() => decryptSecret(broken, key)).toThrow();
  });

  test("a different key cannot decrypt", () => {
    const ciphertext = encryptSecret(samplePlaintext, key);
    const otherKey = randomBytes(32);
    expect(() => decryptSecret(ciphertext, otherKey)).toThrow();
  });

  test("rejects keys of the wrong length", () => {
    expect(() => encryptSecret("anything", randomBytes(16))).toThrow(/32-byte key/);
    expect(() => decryptSecret("v1:a:b:c", randomBytes(16))).toThrow(/32-byte key/);
  });

  test("decrypt rejects malformed input shapes", () => {
    expect(() => decryptSecret("not-encrypted", key)).toThrow(/segment count/);
    expect(() => decryptSecret("v2:a:b:c", key)).toThrow(/version/);
  });
});

describe("isEncryptedSecret", () => {
  test("returns true only for the v1 4-segment shape", () => {
    expect(isEncryptedSecret("v1:abc:def:ghi")).toBe(true);
  });

  test("returns false for arbitrary plaintext that doesn't match the v1 shape", () => {
    expect(isEncryptedSecret("just a regular string")).toBe(false);
    expect(isEncryptedSecret("plaintext key material")).toBe(false);
  });

  test("returns false for unknown versions or wrong segment counts", () => {
    expect(isEncryptedSecret("v2:a:b:c")).toBe(false);
    expect(isEncryptedSecret("v1:a:b")).toBe(false);
    expect(isEncryptedSecret("v1:a:b:c:d")).toBe(false);
  });
});
