import { describe, test, expect, spyOn } from "bun:test";
import crypto from "crypto";
import {
  createSessionCookie,
  SESSION_MAX_AGE,
  validateSessionCookie,
} from "../../src/pages/session.ts";

/**
 * Unit tests for dashboard session cookies (#174).
 *
 * These exercise the real helpers in src/pages/session.ts. They used to
 * re-declare the logic locally, and that copy had already diverged: it
 * compared HMACs with `===` while the source uses `timingSafeEqual`.
 */

const TEST_SECRET = "test-session-secret";

/** A fixed clock: 2026-01-01T00:00:00Z, in milliseconds. */
const NOW_MS = Date.UTC(2026, 0, 1);
const NOW_S = NOW_MS / 1000;

describe("session cookie", () => {
  describe("createSessionCookie", () => {
    test("returns a string with format timestamp.hmac", () => {
      const cookie = createSessionCookie(TEST_SECRET, NOW_MS);
      expect(cookie.split(".")).toHaveLength(2);
    });

    test("timestamp part is the current Unix time in seconds", () => {
      const cookie = createSessionCookie(TEST_SECRET, NOW_MS);
      expect(cookie.split(".")[0]).toBe(String(NOW_S));
    });

    test("hmac part is a 64-char hex string (SHA-256)", () => {
      const cookie = createSessionCookie(TEST_SECRET, NOW_MS);
      expect(cookie.split(".")[1]).toMatch(/^[a-f0-9]{64}$/);
    });

    test("defaults to the real clock", () => {
      const ts = Number(createSessionCookie(TEST_SECRET).split(".")[0]);
      expect(Math.abs(Math.floor(Date.now() / 1000) - ts)).toBeLessThan(2);
    });
  });

  describe("validateSessionCookie", () => {
    test("validates a freshly created cookie", () => {
      const cookie = createSessionCookie(TEST_SECRET, NOW_MS);
      expect(validateSessionCookie(cookie, TEST_SECRET, NOW_MS)).toBe(true);
    });

    test("rejects a cookie with wrong secret", () => {
      const cookie = createSessionCookie(TEST_SECRET, NOW_MS);
      expect(validateSessionCookie(cookie, "wrong-secret", NOW_MS)).toBe(false);
    });

    test("rejects a cookie with tampered HMAC", () => {
      const tampered = `${NOW_S}.${"0".repeat(64)}`;
      expect(validateSessionCookie(tampered, TEST_SECRET, NOW_MS)).toBe(false);
    });

    test("rejects an HMAC of the wrong length", () => {
      expect(validateSessionCookie(`${NOW_S}.abc`, TEST_SECRET, NOW_MS)).toBe(false);
    });

    test("rejects a cookie with no dot separator", () => {
      expect(validateSessionCookie("nodot", TEST_SECRET, NOW_MS)).toBe(false);
    });

    test("rejects a cookie with non-numeric timestamp", () => {
      expect(validateSessionCookie("abc.def", TEST_SECRET, NOW_MS)).toBe(false);
    });

    test("rejects an expired cookie (older than 24h)", () => {
      const cookie = createSessionCookie(
        TEST_SECRET,
        NOW_MS - (SESSION_MAX_AGE + 1) * 1000,
      );
      expect(validateSessionCookie(cookie, TEST_SECRET, NOW_MS)).toBe(false);
    });

    test("accepts a cookie exactly at the 24h limit", () => {
      const cookie = createSessionCookie(TEST_SECRET, NOW_MS - SESSION_MAX_AGE * 1000);
      expect(validateSessionCookie(cookie, TEST_SECRET, NOW_MS)).toBe(true);
    });

    test("compares the HMAC with crypto.timingSafeEqual, not === (#174)", () => {
      /**
       * `===` and `timingSafeEqual` return the same boolean for every input,
       * so only a spy can tell them apart. If the comparison regressed to
       * `===`, timingSafeEqual would never be called and this fails.
       */
      const spy = spyOn(crypto, "timingSafeEqual");
      try {
        const cookie = createSessionCookie(TEST_SECRET, NOW_MS);
        expect(validateSessionCookie(cookie, TEST_SECRET, NOW_MS)).toBe(true);
        expect(spy).toHaveBeenCalledTimes(1);

        /** It must also be the deciding comparison for a wrong HMAC. */
        expect(
          validateSessionCookie(`${NOW_S}.${"0".repeat(64)}`, TEST_SECRET, NOW_MS),
        ).toBe(false);
        expect(spy).toHaveBeenCalledTimes(2);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
