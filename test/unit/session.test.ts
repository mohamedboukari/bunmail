import { describe, test, expect, mock } from "bun:test";
import { createHmac } from "crypto";

/**
 * Unit tests for session cookie logic.
 *
 * Tests the HMAC-based session cookie creation and validation logic
 * used by the dashboard auth flow. These are extracted as pure functions
 * to test independently of the Elysia plugin.
 */

/** Session secret for testing */
const TEST_SECRET = "test-session-secret";

/** Max session age in seconds (24 hours) */
const SESSION_MAX_AGE = 86400;

/**
 * Creates a signed session cookie value (mirrors pages.plugin.tsx logic).
 */
function createSessionCookie(secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const hmac = createHmac("sha256", secret)
    .update(String(timestamp))
    .digest("hex");
  return `${timestamp}.${hmac}`;
}

/**
 * Validates a session cookie value (mirrors pages.plugin.tsx logic).
 */
function validateSessionCookie(cookie: string, secret: string): boolean {
  const dotIndex = cookie.indexOf(".");
  if (dotIndex === -1) return false;

  const timestamp = cookie.substring(0, dotIndex);
  const providedHmac = cookie.substring(dotIndex + 1);

  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) return false;

  const now = Math.floor(Date.now() / 1000);
  if (now - ts > SESSION_MAX_AGE) return false;

  const expectedHmac = createHmac("sha256", secret)
    .update(timestamp)
    .digest("hex");

  if (providedHmac.length !== expectedHmac.length) return false;

  return providedHmac === expectedHmac;
}

describe("session cookie", () => {
  describe("createSessionCookie", () => {
    test("returns a string with format timestamp.hmac", () => {
      const cookie = createSessionCookie(TEST_SECRET);
      const parts = cookie.split(".");
      expect(parts).toHaveLength(2);
    });

    test("timestamp part is a valid Unix timestamp", () => {
      const cookie = createSessionCookie(TEST_SECRET);
      const timestamp = parseInt(cookie.split(".")[0]!, 10);
      const now = Math.floor(Date.now() / 1000);
      /** Timestamp should be within 2 seconds of now */
      expect(Math.abs(now - timestamp)).toBeLessThan(2);
    });

    test("hmac part is a 64-char hex string (SHA-256)", () => {
      const cookie = createSessionCookie(TEST_SECRET);
      const hmac = cookie.split(".")[1]!;
      expect(hmac).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe("validateSessionCookie", () => {
    test("validates a freshly created cookie", () => {
      const cookie = createSessionCookie(TEST_SECRET);
      expect(validateSessionCookie(cookie, TEST_SECRET)).toBe(true);
    });

    test("rejects a cookie with wrong secret", () => {
      const cookie = createSessionCookie(TEST_SECRET);
      expect(validateSessionCookie(cookie, "wrong-secret")).toBe(false);
    });

    test("rejects a cookie with tampered HMAC", () => {
      const cookie = createSessionCookie(TEST_SECRET);
      const tampered = cookie.split(".")[0] + ".0000000000000000000000000000000000000000000000000000000000000000";
      expect(validateSessionCookie(tampered, TEST_SECRET)).toBe(false);
    });

    test("rejects a cookie with no dot separator", () => {
      expect(validateSessionCookie("nodot", TEST_SECRET)).toBe(false);
    });

    test("rejects a cookie with non-numeric timestamp", () => {
      expect(validateSessionCookie("abc.def", TEST_SECRET)).toBe(false);
    });

    test("rejects an expired cookie (older than 24h)", () => {
      /** Create a cookie with a timestamp from 25 hours ago */
      const oldTimestamp = Math.floor(Date.now() / 1000) - 90000;
      const hmac = createHmac("sha256", TEST_SECRET)
        .update(String(oldTimestamp))
        .digest("hex");
      const expiredCookie = `${oldTimestamp}.${hmac}`;
      expect(validateSessionCookie(expiredCookie, TEST_SECRET)).toBe(false);
    });

    test("accepts a cookie that is almost 24h old", () => {
      /** Create a cookie with a timestamp from 23 hours ago */
      const recentTimestamp = Math.floor(Date.now() / 1000) - 82800;
      const hmac = createHmac("sha256", TEST_SECRET)
        .update(String(recentTimestamp))
        .digest("hex");
      const validCookie = `${recentTimestamp}.${hmac}`;
      expect(validateSessionCookie(validCookie, TEST_SECRET)).toBe(true);
    });
  });
});
