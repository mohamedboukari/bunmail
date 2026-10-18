import { describe, test, expect } from "bun:test";
import {
  OWNER_SETUP_TTL_MS,
  SETUP_PASSWORD_MAX_LENGTH,
  SETUP_PASSWORD_MIN_LENGTH,
  buildSetupUrl,
  isWellFormedSetupToken,
  setupPasswordProblem,
  setupTokenExpiry,
} from "../../src/modules/users/services/owner-setup-policy.service.ts";
import { mintToken } from "../../src/modules/users/services/token.service.ts";

/**
 * Pure rules behind the owner setup link (#215): token shape, expiry,
 * password policy and link building.
 */

describe("isWellFormedSetupToken", () => {
  test("accepts every token mintToken produces", () => {
    for (let i = 0; i < 200; i++) {
      expect(isWellFormedSetupToken(mintToken().token)).toBe(true);
    }
  });

  test.each([
    ["empty", ""],
    ["42 characters", "a".repeat(42)],
    ["44 characters", "a".repeat(44)],
    ["a plus sign", `${"a".repeat(42)}+`],
    ["a slash", `${"a".repeat(42)}/`],
    ["padding", `${"a".repeat(42)}=`],
    ["whitespace", ` ${"a".repeat(42)}`],
    ["a newline", `${"a".repeat(43)}\n`],
  ])("rejects %s", (_label, token) => {
    expect(isWellFormedSetupToken(token)).toBe(false);
  });
});

describe("setupTokenExpiry", () => {
  test("is exactly now plus 24 hours", () => {
    const now = new Date("2026-10-18T12:00:00Z");
    expect(OWNER_SETUP_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(setupTokenExpiry(now).toISOString()).toBe("2026-10-19T12:00:00.000Z");
    expect(setupTokenExpiry(now).getTime() - now.getTime()).toBe(OWNER_SETUP_TTL_MS);
  });
});

describe("setupPasswordProblem", () => {
  const ok = "x".repeat(SETUP_PASSWORD_MIN_LENGTH);

  test("accepts a password of the minimum length with a matching confirmation", () => {
    expect(setupPasswordProblem(ok, ok)).toBeNull();
    const longest = "y".repeat(SETUP_PASSWORD_MAX_LENGTH);
    expect(setupPasswordProblem(longest, longest)).toBeNull();
  });

  test("rejects 14 characters", () => {
    const short = "x".repeat(14);
    expect(setupPasswordProblem(short, short)).toContain("at least 15");
  });

  test("rejects 257 characters", () => {
    const long = "x".repeat(257);
    expect(setupPasswordProblem(long, long)).toContain("at most 256");
  });

  test("rejects a mismatched confirmation", () => {
    expect(setupPasswordProblem(ok, `${ok}!`)).toContain("do not match");
  });

  test("counts characters, not UTF-16 units", () => {
    /** 15 emoji are 30 UTF-16 units but 15 characters: accepted. */
    const emoji = "\u{1F511}".repeat(15);
    expect(setupPasswordProblem(emoji, emoji)).toBeNull();
    /** 14 emoji are 28 units but only 14 characters: rejected. */
    const fewer = "\u{1F511}".repeat(14);
    expect(setupPasswordProblem(fewer, fewer)).toContain("at least 15");
  });

  test("never echoes the password", () => {
    const secret = "hunter2-secret";
    expect(setupPasswordProblem(secret, secret)).not.toContain(secret);
  });
});

describe("buildSetupUrl", () => {
  const token = mintToken().token;

  test("uses an https APP_BASE_URL", () => {
    expect(buildSetupUrl("https://mail.example.com", 3000, token)).toEqual({
      url: `https://mail.example.com/dashboard/setup?token=${token}`,
      usedFallback: false,
    });
  });

  test("strips trailing slashes from the base", () => {
    expect(buildSetupUrl("http://mail.example.com//", 3000, token).url).toBe(
      `http://mail.example.com/dashboard/setup?token=${token}`,
    );
  });

  test("falls back to localhost when APP_BASE_URL is empty", () => {
    expect(buildSetupUrl("", 8080, token)).toEqual({
      url: `http://localhost:8080/dashboard/setup?token=${token}`,
      usedFallback: true,
    });
  });

  test.each(["javascript:alert(1)", "mail.example.com", "ftp://mail.example.com"])(
    "falls back to localhost for a non-http base %s",
    (base) => {
      const { url, usedFallback } = buildSetupUrl(base, 3000, token);
      expect(usedFallback).toBe(true);
      expect(url).toBe(`http://localhost:3000/dashboard/setup?token=${token}`);
    },
  );

  test("the token appears exactly once", () => {
    const { url } = buildSetupUrl("https://mail.example.com", 3000, token);
    expect(url.split(token).length - 1).toBe(1);
  });
});
