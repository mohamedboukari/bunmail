import { describe, test, expect } from "bun:test";
import { passwordChangeProblem } from "../../src/modules/users/services/password-change-policy.service.ts";

/**
 * Password change form rules (#279): the current password is required,
 * the new one follows the owner setup policy (15 to 256 characters,
 * confirmed) and must differ from the current one. Pure, so it runs
 * without mocks; the integration test proves the rest (throttle, verify,
 * the locked transaction).
 */

const CURRENT = "the current password, long";
const NEXT = "a brand new passphrase, long";

describe("password change policy (#279)", () => {
  test("a valid change has no problem", () => {
    expect(passwordChangeProblem(CURRENT, NEXT, NEXT)).toBeNull();
  });

  test("the current password is required", () => {
    expect(passwordChangeProblem("", NEXT, NEXT)).toBe("Enter your current password.");
  });

  test("the new password follows the setup policy", () => {
    expect(passwordChangeProblem(CURRENT, "short", "short")).toContain(
      "at least 15 characters",
    );
    const long = "x".repeat(257);
    expect(passwordChangeProblem(CURRENT, long, long)).toContain(
      "at most 256 characters",
    );
    expect(passwordChangeProblem(CURRENT, NEXT, `${NEXT}!`)).toBe(
      "The two passwords do not match.",
    );
  });

  test("lengths count characters, not UTF-16 units", () => {
    const emoji = "\u{1F511}".repeat(15);
    expect(passwordChangeProblem(CURRENT, emoji, emoji)).toBeNull();
  });

  test("the new password must differ from the current one", () => {
    expect(passwordChangeProblem(CURRENT, CURRENT, CURRENT)).toBe(
      "The new password must be different from the current one.",
    );
  });

  test("no message echoes the input", () => {
    const secret = "secret-value-123";
    for (const problem of [
      passwordChangeProblem("", secret, secret),
      passwordChangeProblem(secret, secret, secret),
      passwordChangeProblem(secret, `${secret}${secret}`, "other"),
    ]) {
      expect(problem).not.toBeNull();
      expect(problem ?? "").not.toContain(secret);
    }
  });
});
