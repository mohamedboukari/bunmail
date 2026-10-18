import { describe, test, expect, spyOn, beforeEach, afterEach } from "bun:test";
import type { Context } from "elysia";
import {
  adminGuard,
  memberGuard,
  ownerGuard,
  requireAssurance,
  requireRole,
  roleAtLeast,
  toDashboardAuth,
} from "../../src/pages/guards.tsx";
import type {
  DashboardAuth,
  SessionAssurance,
  UserRole,
} from "../../src/modules/users/types/user.types.ts";
import { logger } from "../../src/utils/logger.ts";

/**
 * Unit tests for the dashboard role and assurance checks (#222). The
 * HTTP-level route table runs in
 * test/integration/dashboard-route-access.integration.test.ts.
 */

/** A fresh `set` like the one Elysia hands each request. */
function freshSet(): Context["set"] {
  return { headers: {}, status: 200 };
}

/** A route-guard context for an account with `role` and `assurance`. */
function ctx(
  role: UserRole,
  assurance: SessionAssurance = "password",
): {
  auth: DashboardAuth;
  request: Request;
  path: string;
  set: Context["set"];
} {
  return {
    auth: {
      user: { id: "usr_1", email: "someone@example.com", role },
      session: { id: "ses_1", assurance },
    },
    request: new Request("http://localhost/dashboard/api-keys", { method: "POST" }),
    path: "/dashboard/api-keys",
    set: freshSet(),
  };
}

let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;
beforeEach(() => {
  warn = spyOn(logger, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe("roleAtLeast", () => {
  test("ranks owner > admin > member", () => {
    expect(roleAtLeast("owner", "admin")).toBe(true);
    expect(roleAtLeast("admin", "admin")).toBe(true);
    expect(roleAtLeast("member", "admin")).toBe(false);
    expect(roleAtLeast("admin", "owner")).toBe(false);
    expect(roleAtLeast("member", "member")).toBe(true);
  });
});

describe("requireRole", () => {
  test("lets a high enough role through without touching the response", () => {
    const c = ctx("owner");
    expect(adminGuard(c)).toBeUndefined();
    expect(memberGuard(c)).toBeUndefined();
    expect(ownerGuard(c)).toBeUndefined();
    expect(c.set.status).toBe(200);
    expect(warn).not.toHaveBeenCalled();
  });

  test("a lower role gets 403, the Forbidden page, and a warn line with IDs only", async () => {
    const c = ctx("member");
    const page = await requireRole("admin")(c);
    expect(c.set.status).toBe(403);
    expect(page).toContain("Forbidden");
    expect(page).toContain("needs the admin role or higher");
    expect(warn).toHaveBeenCalledWith("Dashboard access denied: role too low", {
      userId: "usr_1",
      role: "member",
      required: "admin",
      method: "POST",
      path: "/dashboard/api-keys",
    });
  });

  test("an admin is denied an owner route", () => {
    const c = ctx("admin");
    expect(ownerGuard(c)).toBeDefined();
    expect(c.set.status).toBe(403);
  });
});

describe("requireAssurance", () => {
  test("an mfa session passes requireAssurance('mfa')", () => {
    const c = ctx("member", "mfa");
    expect(requireAssurance("mfa")(c)).toBeUndefined();
    expect(c.set.status).toBe(200);
  });

  test("a password session is denied requireAssurance('mfa') with a warn line", async () => {
    const c = ctx("owner", "password");
    const page = await requireAssurance("mfa")(c);
    expect(c.set.status).toBe(403);
    expect(page).toContain("verified with mfa");
    expect(warn).toHaveBeenCalledWith(
      "Dashboard access denied: session assurance too low",
      {
        userId: "usr_1",
        sessionId: "ses_1",
        assurance: "password",
        required: "mfa",
        method: "POST",
        path: "/dashboard/api-keys",
      },
    );
  });

  test("a password session passes requireAssurance('password')", () => {
    expect(requireAssurance("password")(ctx("member"))).toBeUndefined();
  });
});

describe("toDashboardAuth", () => {
  test("maps the session lookup to the auth context", () => {
    expect(
      toDashboardAuth({
        sessionId: "ses_9",
        userId: "usr_9",
        email: "a@example.com",
        role: "admin",
        assurance: "mfa",
        matched: "current",
        rotationDue: false,
        graceOver: false,
      }),
    ).toEqual({
      user: { id: "usr_9", email: "a@example.com", role: "admin" },
      session: { id: "ses_9", assurance: "mfa" },
    });
  });
});
