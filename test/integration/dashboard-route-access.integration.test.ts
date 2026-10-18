/**
 * Deny-by-default route table for the dashboard (#222), through the real
 * `pagesPlugin` over HTTP against real Postgres.
 *
 * Reads every route from the plugin itself and requires an entry in
 * `ROUTES` for each, with its access level: a new route without one
 * fails, and so does an entry for a route that no longer exists. Then:
 *
 * - statically: a public route never runs the session guard; every other
 *   route runs it and carries exactly the role guard its level names
 *   (`memberGuard`, `adminGuard`, `ownerGuard`), so a forgotten wrapper
 *   fails even where the behaviour would not show it;
 * - over HTTP, for every protected route: no cookie → 302 to the login
 *   page; a member, an admin and the owner → 403 when their role is too
 *   low, and neither 403 nor a bounce to the login page when it is not.
 *
 * Bodies are validated before the guard runs, so write routes get a
 * minimal valid body: otherwise a request would stop at 422 and never
 * reach the guard. Path params are dummy ids, so most actions answer
 * "not found" and change nothing.
 *
 * Also covers `requireAssurance` on a test-only route (no production
 * route uses it until 2FA, #220), and that `auth` costs one lookup.
 */
import { describe, test, expect, beforeAll, spyOn } from "bun:test";
import { Elysia } from "elysia";
import { html } from "@elysiajs/html";
import { eq } from "drizzle-orm";
import { db, seed, truncateAll } from "./_helpers.ts";
import { users } from "../../src/modules/users/models/user.schema.ts";
import { pagesPlugin } from "../../src/pages/pages.plugin.tsx";
import { apiPlugins } from "../../src/modules/api-plugins.ts";
import { landingPlugin } from "../../src/pages/landing.plugin.tsx";
import { faviconPlugin } from "../../src/pages/favicon.ts";
import { withRequestContext } from "../../src/middleware/request-context.ts";
import { getLogContext } from "../../src/utils/log-context.ts";
import {
  adminGuard,
  memberGuard,
  ownerGuard,
  requireAssurance,
  toDashboardAuth,
} from "../../src/pages/guards.tsx";
import { readSessionCookie } from "../../src/pages/session.ts";
import * as sessionService from "../../src/modules/users/services/session.service.ts";
import type { UserRole } from "../../src/modules/users/types/user.types.ts";
import { logger } from "../../src/utils/logger.ts";

const app = new Elysia().use(pagesPlugin);

type Access = "public" | UserRole;

interface RouteSpec {
  /** `public`: no session. Otherwise the lowest role that may open it. */
  access: Access;
  /**
   * Minimal valid form body for write routes. A function gets the caller
   * (`anonymous` or the role) for values that must be unique per request.
   */
  body?: Record<string, string> | ((caller: string) => Record<string, string>);
}

const DUMMY_ID = "x_route_access";
const HOOK_URL = "https://93.184.216.34/hook";

/** Every dashboard route, keyed by `METHOD path` exactly as the plugin reports it. */
const ROUTES: Record<string, RouteSpec> = {
  "GET /dashboard/login": { access: "public" },
  "POST /dashboard/login": { access: "public" },
  "POST /dashboard/logout": { access: "public" },
  "GET /dashboard/setup": { access: "public" },
  "POST /dashboard/setup": { access: "public" },
  "GET /dashboard/invite": { access: "public" },
  "POST /dashboard/invite": { access: "public" },
  "GET /dashboard/reset": { access: "public" },
  "POST /dashboard/reset": { access: "public" },

  "GET /dashboard/": { access: "member" },
  "GET /dashboard/send": { access: "member" },
  "POST /dashboard/send": {
    access: "member",
    body: {
      apiKeyId: "key_route_access",
      from: "hello@example.com",
      to: "user@example.org",
      subject: "x",
    },
  },

  "GET /dashboard/emails": { access: "member" },
  "GET /dashboard/emails/tombstones": { access: "member" },
  "GET /dashboard/emails/trash": { access: "member" },
  "GET /dashboard/emails/:id": { access: "member" },
  "POST /dashboard/emails/:id/trash": { access: "admin" },
  "POST /dashboard/emails/:id/restore": { access: "member" },
  "POST /dashboard/emails/:id/permanent": { access: "admin" },
  "POST /dashboard/emails/bulk-trash": { access: "admin", body: { ids: DUMMY_ID } },
  "POST /dashboard/emails/trash/bulk-restore": {
    access: "admin",
    body: { ids: DUMMY_ID },
  },
  "POST /dashboard/emails/trash/bulk-permanent": {
    access: "admin",
    body: { ids: DUMMY_ID },
  },
  "POST /dashboard/emails/trash/empty": { access: "admin" },

  /** A member sees and manages its own keys, scoped in the service (#219). */
  "GET /dashboard/api-keys": { access: "member" },
  "POST /dashboard/api-keys": { access: "member", body: { name: "route-access" } },
  "POST /dashboard/api-keys/:id/admin": { access: "admin", body: { isAdmin: "false" } },
  "POST /dashboard/api-keys/:id/senders": {
    access: "member",
    body: { allowedSenders: "" },
  },
  "POST /dashboard/api-keys/:id/revoke": { access: "member" },

  "GET /dashboard/invitations": { access: "admin" },
  "POST /dashboard/invitations": {
    access: "admin",
    body: (caller) => ({ email: `${caller}.invitee@example.com`, role: "member" }),
  },
  "POST /dashboard/invitations/:id/revoke": { access: "admin" },
  "POST /dashboard/invitations/:id/resend": { access: "admin" },

  /** The role and owner rules are in the service (users-admin integration test). */
  "GET /dashboard/users": { access: "admin" },
  "POST /dashboard/users/:id/role": { access: "admin", body: { role: "member" } },
  "POST /dashboard/users/:id/deactivate": { access: "admin" },
  "POST /dashboard/users/:id/reactivate": { access: "admin" },
  "POST /dashboard/users/:id/remove": { access: "admin", body: { confirm: "x" } },
  "POST /dashboard/users/:id/transfer": { access: "admin", body: { password: "x" } },
  "POST /dashboard/users/:id/reset-password": { access: "admin" },

  "GET /dashboard/domains": { access: "member" },
  "GET /dashboard/domains/:id": { access: "member" },
  "POST /dashboard/domains": {
    access: "admin",
    body: (caller) => ({ name: `${caller}.route-access.example.com` }),
  },
  "POST /dashboard/domains/:id/delete": { access: "admin" },
  "POST /dashboard/domains/:id/verify": { access: "admin" },
  "POST /dashboard/domains/:id/notify-email": {
    access: "admin",
    body: { notifyEmail: "" },
  },
  "POST /dashboard/domains/:id/unsubscribe": {
    access: "admin",
    body: { unsubscribeEmail: "" },
  },

  "GET /dashboard/templates": { access: "member" },
  "GET /dashboard/templates/:id": { access: "member" },
  "POST /dashboard/templates": { access: "member", body: { name: "t", subject: "s" } },
  /** A member may change its own templates; the service checks the creator (#219). */
  "POST /dashboard/templates/:id/edit": { access: "member", body: { name: "t" } },
  "POST /dashboard/templates/:id/delete": { access: "member" },

  "GET /dashboard/webhooks": { access: "member" },
  "GET /dashboard/webhooks/:id/deliveries": { access: "member" },
  "GET /dashboard/webhooks/deliveries/:deliveryId": { access: "member" },
  "POST /dashboard/webhooks": {
    access: "admin",
    body: { url: HOOK_URL, events: "email.sent" },
  },
  "POST /dashboard/webhooks/:id/delete": { access: "admin" },
  "POST /dashboard/webhooks/deliveries/:deliveryId/replay": { access: "admin" },

  "GET /dashboard/inbound": { access: "member" },
  "GET /dashboard/inbound/trash": { access: "member" },
  "GET /dashboard/inbound/:id": { access: "member" },
  "GET /dashboard/inbound/:id/reply": { access: "member" },
  "POST /dashboard/inbound/:id/trash": { access: "admin" },
  "POST /dashboard/inbound/:id/restore": { access: "member" },
  "POST /dashboard/inbound/:id/permanent": { access: "admin" },
  "POST /dashboard/inbound/bulk-trash": { access: "admin", body: { ids: DUMMY_ID } },
  "POST /dashboard/inbound/trash/bulk-restore": {
    access: "admin",
    body: { ids: DUMMY_ID },
  },
  "POST /dashboard/inbound/trash/bulk-permanent": {
    access: "admin",
    body: { ids: DUMMY_ID },
  },
  "POST /dashboard/inbound/trash/empty": { access: "admin" },

  "GET /dashboard/dmarc-reports": { access: "member" },
  "GET /dashboard/dmarc-reports/:id": { access: "member" },

  "GET /dashboard/suppressions": { access: "member" },
  "POST /dashboard/suppressions/:id/delete": { access: "admin" },
};

/** The role guard each access level must carry. */
const GUARD_FOR: Record<UserRole, unknown> = {
  member: memberGuard,
  admin: adminGuard,
  owner: ownerGuard,
};

const RANK: Record<Access, number> = { public: 0, member: 1, admin: 2, owner: 3 };
const ROLES: UserRole[] = ["member", "admin", "owner"];

/** The `beforeHandle` entries Elysia stored for a route (`{ fn, subType? }`). */
function beforeHandleHooks(hooks: unknown): Array<{ fn: unknown; subType: unknown }> {
  if (typeof hooks !== "object" || hooks === null || !("beforeHandle" in hooks))
    return [];
  const list: unknown = hooks.beforeHandle;
  if (!Array.isArray(list)) return [];
  const result: Array<{ fn: unknown; subType: unknown }> = [];
  for (const entry of list) {
    if (typeof entry === "object" && entry !== null && "fn" in entry) {
      result.push({
        fn: entry.fn,
        subType: "subType" in entry ? entry.subType : undefined,
      });
    }
  }
  return result;
}

/** Fills `:id` / `:deliveryId` with a dummy id that matches no row. */
function concretePath(path: string): string {
  return path.replace(/:[A-Za-z]+/g, DUMMY_ID);
}

/** A request to `METHOD path`, same-origin, with an optional session cookie. */
function call(
  method: string,
  path: string,
  token: string | null,
  body?: Record<string, string>,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers["cookie"] = `bm_session=${token}`;
  if (method === "POST") {
    headers["origin"] = "http://localhost";
    headers["content-type"] = "application/x-www-form-urlencoded";
  }
  return app.handle(
    new Request(`http://localhost${concretePath(path)}`, {
      method,
      headers,
      body: method === "POST" ? new URLSearchParams(body ?? {}).toString() : undefined,
    }),
  );
}

/** Live session tokens per role; replaced whenever a response rotates one. */
const tokens: Record<UserRole, string> = { member: "", admin: "", owner: "" };
const userIds: Record<UserRole, string> = { member: "", admin: "", owner: "" };

/** Keeps the role's token current if the guard rotated it. */
function track(role: UserRole, response: Response): void {
  const value = readSessionCookie(response.headers.get("set-cookie"));
  if (value) tokens[role] = value;
}

beforeAll(async () => {
  await truncateAll();
  for (const role of ROLES) {
    const { id } = await seed.user({ email: `${role}@example.com`, role });
    userIds[role] = id;
    tokens[role] = (await seed.session({ userId: id })).token;
  }
});

describe("Dashboard route table (#222)", () => {
  const actual = pagesPlugin.routes.map((r) => `${r.method} ${r.path}`);

  test("every plugin route is in the table, and every table entry is a route", () => {
    const missing = actual.filter((key) => !(key in ROUTES));
    const stale = Object.keys(ROUTES).filter((key) => !actual.includes(key));
    expect(missing).toEqual([]);
    expect(stale).toEqual([]);
  });

  /**
   * The session guard is a local hook of `pagesPlugin`: a `/dashboard`
   * route defined in any other plugin would get neither the guard nor a
   * role check, and the table above would never see it.
   */
  test("no other plugin defines a /dashboard route", () => {
    const others = [...apiPlugins, landingPlugin, faviconPlugin].flatMap((plugin) =>
      plugin.routes.map((r) => `${r.method} ${r.path}`),
    );
    expect(others.filter((key) => key.split(" ")[1]?.startsWith("/dashboard"))).toEqual(
      [],
    );
  });

  test("public routes skip the session guard; protected ones carry the right role guard", () => {
    const wrong: string[] = [];
    for (const route of pagesPlugin.routes) {
      const key = `${route.method} ${route.path}`;
      const spec = ROUTES[key];
      if (!spec) continue;
      const hooks = beforeHandleHooks(route.hooks);
      const hasSessionGuard = hooks.some((h) => h.subType === "resolve");
      const roleGuards = hooks
        .map((h) => h.fn)
        .filter((fn) => fn === memberGuard || fn === adminGuard || fn === ownerGuard);
      if (spec.access === "public") {
        if (hasSessionGuard || roleGuards.length > 0) wrong.push(`${key}: guarded`);
      } else if (!hasSessionGuard) {
        wrong.push(`${key}: no session guard`);
      } else if (roleGuards.length !== 1 || roleGuards[0] !== GUARD_FOR[spec.access]) {
        wrong.push(`${key}: role guard is not ${spec.access}Guard`);
      }
    }
    expect(wrong).toEqual([]);
  });

  const protectedRoutes = Object.entries(ROUTES).filter(([, s]) => s.access !== "public");

  for (const [key, spec] of protectedRoutes) {
    const [method = "", path = ""] = key.split(" ");

    test(`${key} (${spec.access})`, async () => {
      const bodyFor = (caller: string): Record<string, string> | undefined =>
        typeof spec.body === "function" ? spec.body(caller) : spec.body;

      const anonymous = await call(method, path, null, bodyFor("anonymous"));
      expect(anonymous.status).toBe(302);
      expect(anonymous.headers.get("location")).toBe("/dashboard/login");

      for (const role of ROLES) {
        const response = await call(method, path, tokens[role], bodyFor(role));
        track(role, response);
        const outcome = `${role}: ${response.status} ${response.headers.get("location") ?? ""}`;
        if (RANK[role] >= RANK[spec.access]) {
          expect(outcome).not.toMatch(/^\w+: (403|5\d\d) /);
          expect(outcome).not.toContain("/dashboard/login");
        } else {
          expect(outcome).toBe(`${role}: 403 `);
          expect(await response.text()).toContain("Forbidden");
        }
      }
    });
  }
});

describe("Role denial (#222)", () => {
  test("a member on an admin route gets the 403 page and a warn line with IDs only", async () => {
    const warn = spyOn(logger, "warn");
    try {
      const response = await call("GET", "/dashboard/users", tokens.member);
      track("member", response);
      expect(response.status).toBe(403);
      const page = await response.text();
      expect(page).toContain("needs the admin role or higher");
      expect(page).not.toContain("member@example.com");
      expect(warn).toHaveBeenCalledWith("Dashboard access denied: role too low", {
        userId: userIds.member,
        role: "member",
        required: "admin",
        method: "GET",
        path: "/dashboard/users",
      });
    } finally {
      warn.mockRestore();
    }
  });

  test("a role change applies on the next request: the role is read with the session", async () => {
    const { id } = await seed.user({ email: "promoted@example.com", role: "member" });
    const { token } = await seed.session({ userId: id });
    expect((await call("GET", "/dashboard/users", token)).status).toBe(403);
    await db.update(users).set({ role: "admin" }).where(eq(users.id, id));
    expect((await call("GET", "/dashboard/users", token)).status).toBe(200);
  });
});

/* ─── auth context and requireAssurance on a test-only route ─── */

/**
 * A minimal app with the same contract as the session guard: one
 * `findActiveSession` per request, `auth` from `toDashboardAuth`, then a
 * route-level check. The real guard is covered above; this isolates
 * `requireAssurance`, which no production route uses yet.
 */
const probe = new Elysia({ prefix: "/probe" })
  .use(html())
  .resolve(async ({ request, status }) => {
    const token = readSessionCookie(request.headers.get("cookie"));
    const session = token ? await sessionService.findActiveSession(token) : null;
    if (!session) return status(401, "no session");
    return { auth: toDashboardAuth(session) };
  })
  .get("/mfa", ({ auth }) => `ok ${auth.session.assurance}`, {
    beforeHandle: requireAssurance("mfa"),
  });

function probeMfa(token: string): Promise<Response> {
  return probe.handle(
    new Request("http://localhost/probe/mfa", {
      headers: { cookie: `bm_session=${token}` },
    }),
  );
}

describe("requireAssurance (#222)", () => {
  test("an mfa session passes requireAssurance('mfa')", async () => {
    const { id } = await seed.user({ email: "mfa@example.com", role: "member" });
    const { token } = await seed.session({ userId: id, assurance: "mfa" });
    const response = await probeMfa(token);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok mfa");
  });

  test("a password session gets 403 and a warn line", async () => {
    const { id } = await seed.user({ email: "pw@example.com", role: "admin" });
    const session = await seed.session({ userId: id, assurance: "password" });
    const warn = spyOn(logger, "warn");
    try {
      const response = await probeMfa(session.token);
      expect(response.status).toBe(403);
      expect(await response.text()).toContain("verified with mfa");
      expect(warn).toHaveBeenCalledWith(
        "Dashboard access denied: session assurance too low",
        {
          userId: id,
          sessionId: session.id,
          assurance: "password",
          required: "mfa",
          method: "GET",
          path: "/probe/mfa",
        },
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("auth context (#222)", () => {
  test("findActiveSession returns the account and session fields in one lookup", async () => {
    const { id } = await seed.user({ email: "Context@Example.com", role: "admin" });
    const session = await seed.session({ userId: id, assurance: "mfa" });
    const found = await sessionService.findActiveSession(session.token);
    expect(found).not.toBeNull();
    if (!found) return;
    expect(toDashboardAuth(found)).toEqual({
      user: { id, email: "context@example.com", role: "admin" },
      session: { id: session.id, assurance: "mfa" },
    });
  });

  test("a protected request runs exactly one session lookup", async () => {
    const lookup = spyOn(sessionService, "findActiveSession");
    const history = spyOn(sessionService, "findSessionBySupersededToken");
    try {
      const response = await call("GET", "/dashboard/api-keys", tokens.owner);
      track("owner", response);
      expect(response.status).toBe(200);
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(history).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
      history.mockRestore();
    }
  });
});

describe("Who did what (#222, #284)", () => {
  test("every log line of a dashboard request, including its HTTP request line, names the user", async () => {
    const wrapped = new Elysia().wrap(withRequestContext).use(html()).use(pagesPlugin);
    const contexts: Array<{ message: string; userId: string | undefined }> = [];
    const spy = spyOn(logger, "info").mockImplementation((message: string) => {
      contexts.push({ message, userId: getLogContext()?.userId });
    });
    try {
      const response = await wrapped.handle(
        new Request("http://localhost/dashboard/emails", {
          headers: { cookie: `bm_session=${tokens.member}` },
        }),
      );
      expect(response.status).toBe(200);
    } finally {
      spy.mockRestore();
    }
    const requestLine = contexts.find((c) => c.message === "HTTP request");
    expect(requestLine?.userId).toBe(userIds.member);
  });
});
