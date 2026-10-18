import { describe, test, expect } from "bun:test";
import {
  PASSWORD_RESET_TTL_MINUTES,
  buildPasswordResetUrl,
} from "../../src/modules/users/services/password-reset-policy.service.ts";

/**
 * Password reset link rules (#277): the one-hour lifetime and the link
 * builder. Pure, so it runs without mocks; the integration test proves the
 * database side (expiry on the database clock, the live re-checks).
 */

describe("password reset policy (#277)", () => {
  test("a link lives one hour", () => {
    expect(PASSWORD_RESET_TTL_MINUTES).toBe(60);
  });

  test("the link uses APP_BASE_URL and points at /dashboard/reset", () => {
    expect(buildPasswordResetUrl("https://mail.example.com/", 3000, "abc_-1")).toEqual({
      url: "https://mail.example.com/dashboard/reset?token=abc_-1",
      usedFallback: false,
    });
  });

  test("an unusable APP_BASE_URL falls back to localhost and says so", () => {
    for (const base of ["", "javascript:alert(1)", "mail.example.com"]) {
      expect(buildPasswordResetUrl(base, 3000, "tok")).toEqual({
        url: "http://localhost:3000/dashboard/reset?token=tok",
        usedFallback: true,
      });
    }
  });

  test("the token is URL-encoded", () => {
    expect(buildPasswordResetUrl("https://mail.example.com", 3000, "a&b").url).toBe(
      "https://mail.example.com/dashboard/reset?token=a%26b",
    );
  });
});
