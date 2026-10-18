import { describe, test, expect } from "bun:test";
import {
  hashPassword,
  verifyPassword,
} from "../../src/modules/users/services/password.service.ts";
import { hashToken, mintToken } from "../../src/modules/users/services/token.service.ts";

/**
 * Pure helpers behind dashboard accounts (#214): argon2id password hashing
 * on `Bun.password`, and opaque tokens stored only as SHA-256 hashes.
 */

describe("hashPassword / verifyPassword", () => {
  test("produces an argon2id hash that verifies, with a fresh salt each time", async () => {
    const first = await hashPassword("correct horse battery staple");
    const second = await hashPassword("correct horse battery staple");

    expect(first.startsWith("$argon2id$")).toBe(true);
    expect(first).not.toBe(second);
    expect(await verifyPassword("correct horse battery staple", first)).toBe(true);
    expect(await verifyPassword("correct horse battery staple", second)).toBe(true);
  });

  test("rejects a wrong password", async () => {
    const hash = await hashPassword("right");
    expect(await verifyPassword("wrong", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  test("a malformed stored hash verifies false instead of throwing", async () => {
    expect(await verifyPassword("anything", "not-a-hash")).toBe(false);
    expect(await verifyPassword("anything", "")).toBe(false);
  });

  test("handles long and non-ASCII passwords", async () => {
    const password = "pässwörd-" + "x".repeat(200) + "-日本語";
    const hash = await hashPassword(password);
    expect(await verifyPassword(password, hash)).toBe(true);
    expect(await verifyPassword(password.slice(0, -1), hash)).toBe(false);
  });
});

describe("mintToken / hashToken", () => {
  test("mints a 256-bit base64url token with its SHA-256 storage hash", () => {
    const { token, hash } = mintToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(hash);
  });

  test("hashing is deterministic and tokens are unique", () => {
    const a = mintToken();
    const b = mintToken();

    expect(a.token).not.toBe(b.token);
    expect(a.hash).not.toBe(b.hash);
    expect(hashToken(a.token)).toBe(hashToken(a.token));
    expect(hashToken(a.token)).not.toBe(hashToken(a.token + "x"));
  });
});
