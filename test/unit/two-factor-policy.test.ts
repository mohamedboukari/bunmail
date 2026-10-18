import { describe, test, expect } from "bun:test";
import { readRequire2fa } from "../../src/config.ts";
import {
  TWO_FACTOR_PAGE,
  isTwoFactorEnrolmentPath,
  twoFactorRequired,
} from "../../src/modules/users/services/two-factor-policy.service.ts";
import type {
  TwoFactorPolicy,
  UserRole,
} from "../../src/modules/users/types/user.types.ts";

/**
 * The `REQUIRE_2FA` policy (#220): the env reader (default `none`,
 * strict), who it covers, and which paths an account it holds back may
 * still open.
 */

describe("readRequire2fa", () => {
  test("unset or blank: none (an upgrade locks nobody out)", () => {
    expect(readRequire2fa("")).toBe("none");
    expect(readRequire2fa("   ")).toBe("none");
  });

  const accepted: Array<[string, TwoFactorPolicy]> = [
    ["none", "none"],
    ["owner", "owner"],
    ["admin", "admin"],
    [" Admin ", "admin"],
    ["OWNER", "owner"],
  ];
  test.each(accepted)("accepts %p", (raw, policy) => {
    expect(readRequire2fa(raw)).toBe(policy);
  });

  test.each(["true", "admins", "member", "all", "yes", "0"])(
    "refuses %p (boot fails)",
    (raw) => {
      expect(() => readRequire2fa(raw)).toThrow("REQUIRE_2FA");
    },
  );
});

describe("twoFactorRequired", () => {
  const table: Array<[TwoFactorPolicy, UserRole, boolean]> = [
    ["none", "owner", false],
    ["none", "admin", false],
    ["none", "member", false],
    ["owner", "owner", true],
    ["owner", "admin", false],
    ["owner", "member", false],
    ["admin", "owner", true],
    ["admin", "admin", true],
    ["admin", "member", false],
  ];
  test.each(table)("%p policy, %p role: %p", (policy, role, required) => {
    expect(twoFactorRequired(policy, role)).toBe(required);
  });
});

describe("isTwoFactorEnrolmentPath", () => {
  test("the Two-factor page and its actions only", () => {
    expect(isTwoFactorEnrolmentPath(TWO_FACTOR_PAGE)).toBe(true);
    expect(isTwoFactorEnrolmentPath(`${TWO_FACTOR_PAGE}/start`)).toBe(true);
    expect(isTwoFactorEnrolmentPath(`${TWO_FACTOR_PAGE}/confirm`)).toBe(true);
    expect(isTwoFactorEnrolmentPath("/dashboard/account/two-factorx")).toBe(false);
    expect(isTwoFactorEnrolmentPath("/dashboard")).toBe(false);
    expect(isTwoFactorEnrolmentPath("/dashboard/account/password")).toBe(false);
  });
});
