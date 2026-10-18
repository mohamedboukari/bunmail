import { describe, test, expect } from "bun:test";
import {
  INVITE_NAME_MAX_LENGTH,
  buildInviteUrl,
  canGrantRole,
  grantableRoles,
  inviteNameProblem,
  isInvitableEmail,
  normalizeInviteEmail,
} from "../../src/modules/users/services/invite-policy.service.ts";
import { buildSetupUrl } from "../../src/modules/users/services/owner-setup-policy.service.ts";
import { isInviteRole, type UserRole } from "../../src/modules/users/types/user.types.ts";

/** Pure invitation rules (#217): no I/O, no mocks. */

describe("canGrantRole", () => {
  const matrix: Array<[UserRole, string, boolean]> = [
    ["owner", "admin", true],
    ["owner", "member", true],
    ["owner", "owner", false],
    ["admin", "member", true],
    ["admin", "admin", false],
    ["admin", "owner", false],
    ["member", "member", false],
    ["member", "admin", false],
    ["member", "owner", false],
    ["owner", "superuser", false],
    ["owner", "", false],
    ["owner", "Admin", false],
  ];
  test.each(matrix)("%s granting %p: %p", (actor, role, allowed) => {
    expect(canGrantRole(actor, role)).toBe(allowed);
  });

  test("grantableRoles lists what canGrantRole allows, never owner", () => {
    expect(grantableRoles("owner")).toEqual(["admin", "member"]);
    expect(grantableRoles("admin")).toEqual(["member"]);
    expect(grantableRoles("member")).toEqual([]);
  });

  test("isInviteRole accepts admin and member only", () => {
    expect(isInviteRole("admin")).toBe(true);
    expect(isInviteRole("member")).toBe(true);
    expect(isInviteRole("owner")).toBe(false);
    expect(isInviteRole("")).toBe(false);
  });
});

describe("invited address", () => {
  test("normalizes like users.email: trimmed and lower-cased", () => {
    expect(normalizeInviteEmail("  Ann@Example.COM ")).toBe("ann@example.com");
  });

  test.each(["ann@example.com", "first.last+ops@mail.example.org"])("accepts %s", (e) => {
    expect(isInvitableEmail(e)).toBe(true);
  });

  test.each([
    "",
    "no-at",
    "a@b",
    "Ann <ann@example.com>",
    "a@example.com,b@example.com",
    `${"a".repeat(250)}@example.com`,
  ])("refuses %p", (e) => {
    expect(isInvitableEmail(e)).toBe(false);
  });

  test.each([
    ["a zero-width space", "ann\u200b@example.com"],
    ["a right-to-left override", "ann\u202e@example.com"],
    ["a zero-width joiner in the domain", "ann@exa\u200dmple.com"],
    ["a soft hyphen", "an\u00adn@example.com"],
    ["a NUL", "ann\u0000@example.com"],
    ["a DEL", "ann\u007f@example.com"],
  ])("refuses an address with %s", (_label, e) => {
    expect(isInvitableEmail(e)).toBe(false);
  });
});

describe("inviteNameProblem", () => {
  test("accepts ordinary and non-ASCII names", () => {
    expect(inviteNameProblem("Ann")).toBeNull();
    expect(inviteNameProblem("Zoë O'Brien-Ngũgĩ")).toBeNull();
  });

  test("refuses an empty name", () => {
    expect(inviteNameProblem("")).toBe("Enter your name.");
  });

  test("counts characters, not UTF-16 units", () => {
    expect(inviteNameProblem("😀".repeat(INVITE_NAME_MAX_LENGTH))).toBeNull();
    expect(inviteNameProblem("a".repeat(INVITE_NAME_MAX_LENGTH + 1))).toContain(
      `at most ${INVITE_NAME_MAX_LENGTH}`,
    );
  });

  test.each(["Ann\r\nBcc: x@example.com", "Ann\u0000", "Ann\u0085"])(
    "refuses control characters in %p",
    (name) => {
      expect(inviteNameProblem(name)).toContain("control or invisible formatting");
    },
  );

  test.each([
    ["a right-to-left override", "Ann\u202egnp.exe"],
    ["a zero-width space", "A\u200bnn"],
    ["a zero-width joiner", "A\u200dnn"],
    ["a byte order mark", "Ann\ufeff"],
    ["a left-to-right isolate", "\u2066Ann"],
  ])("refuses %s", (_label, name) => {
    expect(inviteNameProblem(name)).toContain("control or invisible formatting");
  });

  test("never echoes the input", () => {
    expect(inviteNameProblem("<script>\n")).not.toContain("<script>");
  });
});

describe("buildInviteUrl", () => {
  const token = "T".repeat(43);

  test("uses APP_BASE_URL and strips trailing slashes", () => {
    expect(buildInviteUrl("https://mail.example.com//", 3000, token)).toEqual({
      url: `https://mail.example.com/dashboard/invite?token=${token}`,
      usedFallback: false,
    });
  });

  test.each(["", "javascript:alert(1)", "mail.example.com"])(
    "falls back to localhost for %p",
    (base) => {
      expect(buildInviteUrl(base, 8080, token)).toEqual({
        url: `http://localhost:8080/dashboard/invite?token=${token}`,
        usedFallback: true,
      });
    },
  );

  test("the setup link keeps its shape after the shared builder refactor", () => {
    expect(buildSetupUrl("https://mail.example.com", 3000, token).url).toBe(
      `https://mail.example.com/dashboard/setup?token=${token}`,
    );
  });
});
