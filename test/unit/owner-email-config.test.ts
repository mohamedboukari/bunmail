import { describe, test, expect } from "bun:test";
import { ownerEmailProblem, readOwnerEmail } from "../../src/config.ts";

/**
 * `BUNMAIL_OWNER_EMAIL` names the dashboard owner account (#215).
 * Production refuses to boot without it; a malformed value is refused in
 * every environment; the stored form is trimmed and lower-cased.
 */

describe("ownerEmailProblem", () => {
  test.each(["owner@example.com", "First.Last+ops@mail.example.org", " a@b.co "])(
    "accepts %s",
    (email) => {
      expect(ownerEmailProblem(email)).toBeNull();
    },
  );

  test.each([
    ["", "not set"],
    ["   ", "not set"],
    ["no-at", "valid email"],
    ["a@b", "valid email"],
    ["a b@c.d", "valid email"],
    ["<x>@y.z", "valid email"],
    ["Owner <owner@example.com>", "valid email"],
    ["a@b.com,c@d.com", "valid email"],
    [`${"a".repeat(250)}@example.com`, "longer than 254"],
  ])("rejects %s", (email, reason) => {
    expect(ownerEmailProblem(email)).toContain(reason);
  });
});

describe("readOwnerEmail", () => {
  test("production refuses an unset value", () => {
    expect(() => readOwnerEmail("production", "")).toThrow(/BUNMAIL_OWNER_EMAIL/);
    expect(() => readOwnerEmail("production", "  ")).toThrow(/BUNMAIL_ENV=production/);
  });

  test("development skips an unset value", () => {
    expect(readOwnerEmail("development", "")).toBeNull();
    expect(readOwnerEmail("development", "   ")).toBeNull();
  });

  test("trims and lower-cases the value in both environments", () => {
    expect(readOwnerEmail("development", "  Owner@Example.COM ")).toBe(
      "owner@example.com",
    );
    expect(readOwnerEmail("production", "Owner@Example.COM")).toBe("owner@example.com");
  });

  test("a malformed value is refused in development too", () => {
    expect(() => readOwnerEmail("development", "not-an-address")).toThrow(
      /BUNMAIL_OWNER_EMAIL is not usable/,
    );
    expect(() => readOwnerEmail("production", "a@b")).toThrow(/not a valid email/);
  });

  test("a value over 254 characters is refused", () => {
    expect(() => readOwnerEmail("development", `${"a".repeat(250)}@example.com`)).toThrow(
      /longer than 254/,
    );
  });

  test("the error never echoes the configured value", () => {
    expect(() => readOwnerEmail("development", "secret-typo")).not.toThrow(/secret-typo/);
  });
});
