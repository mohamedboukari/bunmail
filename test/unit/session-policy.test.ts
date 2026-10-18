import { describe, test, expect } from "bun:test";
import {
  LOGIN_EMAIL_MAX_LENGTH,
  LOGIN_PASSWORD_MAX_LENGTH,
  SESSION_ABSOLUTE_SECONDS,
  SESSION_IDLE_SECONDS,
  SESSION_ROTATE_SECONDS,
  SESSION_ROTATION_GRACE_SECONDS,
  clampUserAgent,
  loginInputTooLong,
  normalizeLoginEmail,
  sessionIp,
} from "../../src/modules/users/services/session-policy.service.ts";
import { isWellFormedSetupToken } from "../../src/modules/users/services/owner-setup-policy.service.ts";
import {
  isWellFormedToken,
  mintToken,
} from "../../src/modules/users/services/token.service.ts";

/**
 * Pure rules behind dashboard sessions and the login form (#216).
 */

describe("isWellFormedToken", () => {
  test("accepts every token mintToken produces", () => {
    for (let i = 0; i < 100; i++) {
      const { token } = mintToken();
      expect(isWellFormedToken(token)).toBe(true);
      expect(isWellFormedSetupToken(token)).toBe(true);
    }
  });

  test("rejects other lengths and characters outside base64url", () => {
    const base = "A".repeat(43);
    for (const bad of [
      "A".repeat(42),
      "A".repeat(44),
      "",
      `${base.slice(0, 42)}.`,
      `${base.slice(0, 42)}+`,
      `${base.slice(0, 42)}/`,
      `${base.slice(0, 42)}=`,
      `${base.slice(0, 42)} `,
    ]) {
      expect(isWellFormedToken(bad)).toBe(false);
      expect(isWellFormedSetupToken(bad)).toBe(false);
    }
  });

  test("rejects a pre-#216 HMAC session cookie", () => {
    expect(isWellFormedToken(`1700000000.${"a".repeat(64)}`)).toBe(false);
  });
});

describe("sessionIp", () => {
  test("keeps IPv4 and IPv6 literals", () => {
    expect(sessionIp("203.0.113.7")).toBe("203.0.113.7");
    expect(sessionIp("2001:db8::1")).toBe("2001:db8::1");
    expect(sessionIp("::ffff:192.0.2.128")).toBe("::ffff:192.0.2.128");
  });

  test("stores anything else as null", () => {
    expect(sessionIp("unknown")).toBeNull();
    expect(sessionIp("1.2.3.4, 5.6.7.8")).toBeNull();
    expect(sessionIp("<script>")).toBeNull();
    expect(sessionIp("")).toBeNull();
    expect(sessionIp(null)).toBeNull();
    expect(sessionIp(undefined)).toBeNull();
  });

  test("never returns more than the 45 characters the column holds", () => {
    expect(sessionIp("1".repeat(46))).toBeNull();
    expect(sessionIp(`2001:db8::1${" ".repeat(40)}`)).toBeNull();
  });
});

describe("clampUserAgent", () => {
  test("caps at 255 characters and keeps shorter values", () => {
    expect(clampUserAgent("x".repeat(1000))).toHaveLength(255);
    expect(clampUserAgent("Mozilla/5.0")).toBe("Mozilla/5.0");
  });

  test("counts code points, so a surrogate pair is never split", () => {
    const clamped = clampUserAgent("😀".repeat(300)) ?? "";
    expect(Array.from(clamped)).toHaveLength(255);
    expect(clamped).toBe("😀".repeat(255));
  });

  test("a missing header is null", () => {
    expect(clampUserAgent(null)).toBeNull();
    expect(clampUserAgent("")).toBeNull();
  });
});

describe("normalizeLoginEmail / loginInputTooLong", () => {
  test("trims and lower-cases like users.email stores it", () => {
    expect(normalizeLoginEmail("  Owner@Example.COM ")).toBe("owner@example.com");
  });

  test("bounds: email at most 254 characters, password at most 256 code points", () => {
    expect(LOGIN_EMAIL_MAX_LENGTH).toBe(254);
    expect(LOGIN_PASSWORD_MAX_LENGTH).toBe(256);
    const email = `${"a".repeat(242)}@example.com`;
    expect(email).toHaveLength(254);
    expect(loginInputTooLong(email, "p".repeat(256))).toBe(false);
    expect(loginInputTooLong(`a${email}`, "p")).toBe(true);
    expect(loginInputTooLong("a@example.com", "p".repeat(257))).toBe(true);
    /** 256 non-ASCII characters are 512 UTF-16 units, still within the cap. */
    expect(loginInputTooLong("a@example.com", "😀".repeat(256))).toBe(false);
  });
});

describe("lifetimes", () => {
  test("24h idle, 7d absolute, rotation every minute with a 30s grace", () => {
    expect(SESSION_IDLE_SECONDS).toBe(24 * 60 * 60);
    expect(SESSION_ABSOLUTE_SECONDS).toBe(7 * 24 * 60 * 60);
    expect(SESSION_ROTATE_SECONDS).toBe(60);
    expect(SESSION_ROTATION_GRACE_SECONDS).toBe(30);
  });

  test("are ordered grace < rotate < idle <= absolute", () => {
    expect(SESSION_ROTATION_GRACE_SECONDS).toBeLessThan(SESSION_ROTATE_SECONDS);
    expect(SESSION_ROTATE_SECONDS).toBeLessThan(SESSION_IDLE_SECONDS);
    expect(SESSION_IDLE_SECONDS).toBeLessThanOrEqual(SESSION_ABSOLUTE_SECONDS);
  });
});
