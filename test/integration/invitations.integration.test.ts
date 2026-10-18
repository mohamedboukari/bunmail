/**
 * Dashboard invitations (#217) against real Postgres: who may invite whom
 * (service and crafted HTTP), the per-address advisory lock (re-invite and
 * concurrent invites leave one live link), acceptance (account, password,
 * session, token spent, other links revoked), every dead-token case
 * getting the identical 400 page without reaching argon2id, an address
 * taken meanwhile, the database CHECK, revoke and resend, and the email
 * path: with no system sender the link is revealed once, to the
 * inviter's session only.
 *
 * `SYSTEM_MAIL_FROM` is unset in the test environment, so no mail is
 * sent; the "sent" path stubs `sendInviteEmail` with `spyOn`.
 * `APP_BASE_URL` is pinned to a public URL for every test (a localhost
 * link is never emailed) and cleared by the tests that need that.
 */
import { describe, test, expect, afterAll, beforeEach, spyOn } from "bun:test";
import { Elysia } from "elysia";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db, seed, sessions, truncateAll } from "./_helpers.ts";
import { pagesPlugin } from "../../src/pages/pages.plugin.tsx";
import { readSessionCookie } from "../../src/pages/session.ts";
import { users } from "../../src/modules/users/models/user.schema.ts";
import { userCredentials } from "../../src/modules/users/models/user-credential.schema.ts";
import { userTokens } from "../../src/modules/users/models/user-token.schema.ts";
import {
  acceptInvitation,
  createInvitation,
  findLiveInvitation,
  listPendingInvitations,
  resendInvitation,
  revokeInvitation,
} from "../../src/modules/users/services/invite.service.ts";
import * as inviteEmail from "../../src/modules/users/services/invite-email.service.ts";
import { verifyPassword } from "../../src/modules/users/services/password.service.ts";
import { findActiveSession } from "../../src/modules/users/services/session.service.ts";
import { hashToken, mintToken } from "../../src/modules/users/services/token.service.ts";
import { generateId } from "../../src/utils/id.ts";
import { logger } from "../../src/utils/logger.ts";
import { config } from "../../src/config.ts";
import type {
  InviteActor,
  IssueInvitationResult,
  UserRole,
} from "../../src/modules/users/types/user.types.ts";

const app = new Elysia().use(pagesPlugin);

const PASSWORD = "correct horse battery staple";
const INVITEE = "new@example.org";

/** Accounts of each role, re-seeded before every test. */
const actors: Record<UserRole, InviteActor> = {
  owner: { id: "", role: "owner" },
  admin: { id: "", role: "admin" },
  member: { id: "", role: "member" },
};
/** A live session token per role. */
const tokens: Record<UserRole, string> = { owner: "", admin: "", member: "" };

/** The public base URL every test runs with, unless it clears it. */
const BASE_URL = "https://mail.example.com";
const originalBaseUrl = config.appBaseUrl;

/** Sets `config.appBaseUrl` for a test (the object is read-only only to TypeScript). */
function setBaseUrl(value: string): void {
  expect(Reflect.set(config, "appBaseUrl", value)).toBe(true);
}

afterAll(() => {
  setBaseUrl(originalBaseUrl);
});

beforeEach(async () => {
  setBaseUrl(BASE_URL);
  await truncateAll();
  for (const role of ["owner", "admin", "member"] as const) {
    const { id } = await seed.user({ email: `${role}@example.com`, role });
    actors[role] = { id, role };
    tokens[role] = (await seed.session({ userId: id })).token;
  }
});

/* ─── Helpers ─── */

/** Live invitations for an address (open and unexpired, database clock). */
function liveInvites(
  email: string,
): Promise<Array<{ id: string; tokenHash: string; role: string | null }>> {
  return db
    .select({ id: userTokens.id, tokenHash: userTokens.tokenHash, role: userTokens.role })
    .from(userTokens)
    .where(
      and(
        eq(userTokens.purpose, "invite"),
        eq(userTokens.email, email),
        isNull(userTokens.usedAt),
        isNull(userTokens.revokedAt),
        gt(userTokens.expiresAt, sql`now()`),
      ),
    );
}

/** Number of `user_tokens` rows of any state. */
async function tokenRows(): Promise<number> {
  return (await db.select({ id: userTokens.id }).from(userTokens)).length;
}

/** Asserts an issue result succeeded and returns it narrowed. */
function issued(
  result: IssueInvitationResult,
): Extract<IssueInvitationResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected an invitation, got ${result.reason}`);
  return result;
}

/** Inserts an invitation row directly (bypassing the service), returning its raw token. */
async function insertInvite(opts: {
  email?: string;
  role?: string | null;
  expiresAt?: Date;
  usedAt?: Date | null;
  revokedAt?: Date | null;
}): Promise<string> {
  const { token, hash } = mintToken();
  await db.insert(userTokens).values({
    id: generateId("utk"),
    email: opts.email ?? INVITEE,
    purpose: "invite",
    role: opts.role === undefined ? "member" : opts.role,
    invitedBy: actors.owner.id,
    tokenHash: hash,
    expiresAt: opts.expiresAt ?? new Date(Date.now() + 86_400_000),
    usedAt: opts.usedAt ?? null,
    revokedAt: opts.revokedAt ?? null,
  });
  return token;
}

/** A same-origin request, optionally with a session cookie and a form body. */
function call(
  method: "GET" | "POST",
  path: string,
  opts: { token?: string; body?: Record<string, string>; origin?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.token) headers["cookie"] = `bm_session=${opts.token}`;
  const url = `http://localhost${path}`;
  if (method === "GET") return app.handle(new Request(url, { headers }));
  headers["origin"] = opts.origin ?? "http://localhost";
  headers["content-type"] = "application/x-www-form-urlencoded";
  return app.handle(
    new Request(url, {
      method: "POST",
      headers,
      body: new URLSearchParams(opts.body ?? {}).toString(),
    }),
  );
}

/** Submits the accept form. */
function postAccept(
  token: string,
  fields: Partial<Record<"name" | "password" | "confirm", string>> = {},
  cookie?: string,
): Promise<Response> {
  return call("POST", "/dashboard/invite", {
    token: cookie,
    body: {
      token,
      name: fields.name ?? "New Person",
      password: fields.password ?? PASSWORD,
      confirm: fields.confirm ?? fields.password ?? PASSWORD,
    },
  });
}

/** The raw invitation token in a page's revealed link, or null. */
function revealedToken(html: string): string | null {
  return html.match(/\/dashboard\/invite\?token=([A-Za-z0-9_-]{43})/)?.[1] ?? null;
}

/* ─── Who may invite whom ─── */

describe("role rules (service)", () => {
  test("the owner invites an admin and a member; an admin invites a member", async () => {
    const asAdmin = issued(
      await createInvitation(actors.owner, "Boss@Example.org", "admin"),
    );
    expect(asAdmin.invitation.email).toBe("boss@example.org");
    expect(asAdmin.invitation.role).toBe("admin");

    /** Expiry on the database clock: now() + 7 days, read back with RETURNING. */
    const [clock] = await db.execute(
      sql`SELECT extract(epoch from (now() + interval '7 days'))::float8 AS expected`,
    );
    const expected = Number(clock?.["expected"]) * 1000;
    expect(Math.abs(asAdmin.invitation.expiresAt.getTime() - expected)).toBeLessThan(
      5_000,
    );

    issued(await createInvitation(actors.owner, "m1@example.org", "member"));
    issued(await createInvitation(actors.admin, "m2@example.org", "member"));

    const [row] = await db
      .select()
      .from(userTokens)
      .where(eq(userTokens.id, asAdmin.invitation.invitationId));
    expect(row?.purpose).toBe("invite");
    expect(row?.invitedBy).toBe(actors.owner.id);
    expect(row?.userId).toBeNull();
    /** Only the hash is stored. */
    expect(row?.tokenHash).toBe(hashToken(asAdmin.invitation.token));
    expect(row?.expiresAt.getTime()).toBe(asAdmin.invitation.expiresAt.getTime());
    expect(JSON.stringify(row)).not.toContain(asAdmin.invitation.token);
    expect(await tokenRows()).toBe(3);
  });

  test.each([
    ["admin", "admin"],
    ["admin", "owner"],
    ["owner", "owner"],
    ["member", "member"],
    ["member", "owner"],
    ["owner", "superuser"],
  ] as const)("%s inviting %s is refused, nothing written", async (actor, role) => {
    const result = await createInvitation(actors[actor], INVITEE, role);
    expect(result).toEqual({ ok: false, reason: "role_not_allowed" });
    expect(await tokenRows()).toBe(0);
  });

  test("a malformed address is refused", async () => {
    for (const email of [
      "",
      "no-at",
      "Ann <ann@example.org>",
      "a@example.org,b@example.org",
    ]) {
      expect(await createInvitation(actors.owner, email, "member")).toEqual({
        ok: false,
        reason: "invalid_email",
      });
    }
    expect(await tokenRows()).toBe(0);
  });

  test("an address that already has an account is refused, in any case", async () => {
    expect(
      await createInvitation(actors.owner, " Member@EXAMPLE.com ", "member"),
    ).toEqual({
      ok: false,
      reason: "account_exists",
    });
    expect(await tokenRows()).toBe(0);
  });
});

describe("role rules (crafted HTTP)", () => {
  test("an admin posting role=admin and the owner posting role=owner get 403, nothing written", async () => {
    const admin = await call("POST", "/dashboard/invitations", {
      token: tokens.admin,
      body: { email: INVITEE, role: "admin" },
    });
    expect(admin.status).toBe(403);
    expect(await admin.text()).toContain("cannot grant");

    const owner = await call("POST", "/dashboard/invitations", {
      token: tokens.owner,
      body: { email: INVITEE, role: "owner" },
    });
    expect(owner.status).toBe(403);
    expect(await tokenRows()).toBe(0);
  });

  test("a member cannot reach the invitation routes at all", async () => {
    const id = issued(await createInvitation(actors.owner, INVITEE, "member")).invitation
      .invitationId;
    for (const [method, path] of [
      ["GET", "/dashboard/invitations"],
      ["POST", "/dashboard/invitations"],
      ["POST", `/dashboard/invitations/${id}/revoke`],
      ["POST", `/dashboard/invitations/${id}/resend`],
    ] as const) {
      const response = await call(method, path, {
        token: tokens.member,
        body: method === "POST" ? { email: "x@example.org", role: "member" } : undefined,
      });
      expect(`${method} ${path} ${response.status}`).toBe(`${method} ${path} 403`);
    }
    expect(await liveInvites(INVITEE)).toHaveLength(1);
  });

  test("the database refuses an owner invitation, a roleless one and an addressless one", async () => {
    const rejects = async (
      values: Partial<typeof userTokens.$inferInsert>,
    ): Promise<void> => {
      let caught: unknown = null;
      try {
        await db.insert(userTokens).values({
          id: generateId("utk"),
          purpose: "invite",
          tokenHash: mintToken().hash,
          expiresAt: new Date(Date.now() + 86_400_000),
          ...values,
        });
      } catch (error: unknown) {
        caught = error;
      }
      expect(String(caught instanceof Error ? caught.cause : caught)).toContain(
        "user_tokens_invite_check",
      );
    };
    await rejects({ email: INVITEE, role: "owner" });
    await rejects({ email: INVITEE, role: null });
    await rejects({ userId: actors.member.id, role: "member" });
    expect(await tokenRows()).toBe(0);
  });
});

/* ─── One live link per address ─── */

describe("re-invite and concurrency", () => {
  test("re-inviting a pending address replaces its link: the old one is dead, one stays live", async () => {
    const first = issued(await createInvitation(actors.owner, INVITEE, "member"));
    const second = issued(await createInvitation(actors.admin, INVITEE, "member"));
    expect(second.invitation.replaced).toBe(1);
    expect(await findLiveInvitation(first.invitation.token)).toBeNull();
    expect(await findLiveInvitation(second.invitation.token)).not.toBeNull();
    const live = await liveInvites(INVITEE);
    expect(live).toHaveLength(1);
    expect(live[0]?.tokenHash).toBe(hashToken(second.invitation.token));
  });

  test("five concurrent invitations of one address leave exactly one live link", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => createInvitation(actors.owner, INVITEE, "member")),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await liveInvites(INVITEE)).toHaveLength(1);
    expect(await tokenRows()).toBe(5);
  }, 30_000);
});

/* ─── Acceptance ─── */

describe("acceptance", () => {
  test("creates the account with role and name, password and session; spends the token; revokes the others", async () => {
    const { invitation } = issued(await createInvitation(actors.owner, INVITEE, "admin"));
    /** A stray second open invitation for the same address (inserted by hand). */
    const stray = await insertInvite({ role: "member" });

    const result = await acceptInvitation(
      invitation.token,
      { name: "  New Person ", password: PASSWORD },
      { ip: "203.0.113.9", userAgent: "it-agent" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result).toMatchObject({
      email: INVITEE,
      role: "admin",
      invitedBy: actors.owner.id,
    });

    const [user] = await db.select().from(users).where(eq(users.id, result.userId));
    expect(user).toMatchObject({ email: INVITEE, name: "New Person", role: "admin" });
    expect(user?.emailVerifiedAt).toBeNull();

    const [credential] = await db
      .select({ secretHash: userCredentials.secretHash })
      .from(userCredentials)
      .where(eq(userCredentials.userId, result.userId));
    expect(await verifyPassword(PASSWORD, credential?.secretHash ?? "")).toBe(true);

    const session = await findActiveSession(result.sessionToken);
    expect(session).toMatchObject({
      userId: result.userId,
      role: "admin",
      assurance: "password",
    });
    const [sessionRow] = await db
      .select({ ip: sessions.ip, userAgent: sessions.userAgent })
      .from(sessions)
      .where(eq(sessions.id, result.sessionId));
    expect(sessionRow).toEqual({ ip: "203.0.113.9", userAgent: "it-agent" });

    const [spent] = await db
      .select({ usedAt: userTokens.usedAt })
      .from(userTokens)
      .where(eq(userTokens.id, invitation.invitationId));
    expect(spent?.usedAt).not.toBeNull();
    expect(await findLiveInvitation(stray)).toBeNull();
    expect(await liveInvites(INVITEE)).toHaveLength(0);

    /** Spent: a second use is invalid. */
    expect(
      await acceptInvitation(invitation.token, { name: "X", password: PASSWORD }),
    ).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  test("two concurrent acceptances of one token: exactly one account", async () => {
    const { invitation } = issued(
      await createInvitation(actors.owner, INVITEE, "member"),
    );
    const results = await Promise.all([
      acceptInvitation(invitation.token, { name: "A", password: PASSWORD }),
      acceptInvitation(invitation.token, { name: "B", password: PASSWORD }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await db.select().from(users).where(eq(users.email, INVITEE))).toHaveLength(1);
  }, 30_000);

  test("an address that got an account meanwhile: refused cleanly, links revoked, no second account", async () => {
    const { invitation } = issued(
      await createInvitation(actors.owner, INVITEE, "member"),
    );
    await seed.user({ email: INVITEE, role: "member" });

    expect(
      await acceptInvitation(invitation.token, { name: "X", password: PASSWORD }),
    ).toEqual({ ok: false, reason: "account_exists" });
    expect(await db.select().from(users).where(eq(users.email, INVITEE))).toHaveLength(1);
    expect(await liveInvites(INVITEE)).toHaveLength(0);
  });

  test("over HTTP: the account-exists case answers 409 and sets no cookie", async () => {
    const { invitation } = issued(
      await createInvitation(actors.owner, INVITEE, "member"),
    );
    await seed.user({ email: INVITEE, role: "member" });
    const response = await postAccept(invitation.token);
    expect(response.status).toBe(409);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});

describe("dead tokens over HTTP", () => {
  test("unknown, expired, used, revoked and malformed links get the identical 400 page and never reach argon2", async () => {
    const expired = await insertInvite({ expiresAt: new Date(Date.now() - 1000) });
    const used = await insertInvite({ email: "used@example.org", usedAt: new Date() });
    const revoked = await insertInvite({
      email: "rev@example.org",
      revokedAt: new Date(),
    });
    const unknown = mintToken().token;

    const hashSpy = spyOn(Bun.password, "hash");
    try {
      const bodies = new Set<string>();
      for (const token of [expired, used, revoked, unknown, "not-a-token", ""]) {
        const view = await call("GET", `/dashboard/invite?token=${token}`);
        expect(view.status).toBe(400);
        bodies.add(await view.text());

        const submit = await postAccept(token);
        expect(submit.status).toBe(400);
        bodies.add(await submit.text());
      }
      expect(bodies.size).toBe(1);
      expect([...bodies][0]).toContain("This invitation link is not valid");
      expect(hashSpy).not.toHaveBeenCalled();
    } finally {
      hashSpy.mockRestore();
    }
    expect(await db.select().from(users).where(eq(users.email, INVITEE))).toHaveLength(0);
  });

  test("GET never spends the token", async () => {
    const { invitation } = issued(
      await createInvitation(actors.owner, INVITEE, "member"),
    );
    for (let i = 0; i < 3; i++) {
      const response = await call("GET", `/dashboard/invite?token=${invitation.token}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("referrer-policy")).toBe("strict-origin");
    }
    expect(await findLiveInvitation(invitation.token)).not.toBeNull();
  });
});

describe("accept flow over HTTP", () => {
  test("form, then account and session: the new member can open member pages and sign in", async () => {
    const { invitation } = issued(
      await createInvitation(actors.owner, INVITEE, "member"),
    );
    const form = await call("GET", `/dashboard/invite?token=${invitation.token}`);
    expect(form.status).toBe(200);
    const html = await form.text();
    expect(html).toContain(INVITEE);
    expect(html).toContain("member");

    /** A policy failure re-renders the form without hashing. */
    const short = await postAccept(invitation.token, { password: "short" });
    expect(short.status).toBe(200);
    expect(await short.text()).toContain("at least 15 characters");

    /** The owner's own session in this browser is replaced, as login does. */
    const warn = spyOn(logger, "warn");
    let response: Response;
    try {
      response = await postAccept(invitation.token, { name: "New Person" }, tokens.owner);
      const accepted = warn.mock.calls.find(
        ([message]) => message === "Invitation accepted",
      );
      expect(accepted?.[1]).toMatchObject({
        invitationId: invitation.invitationId,
        invitedBy: actors.owner.id,
        role: "member",
      });
      expect(JSON.stringify(accepted)).not.toContain(invitation.token);
    } finally {
      warn.mockRestore();
    }
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/dashboard");
    const cookie = readSessionCookie(response.headers.get("set-cookie")) ?? "";
    expect(await findActiveSession(cookie)).toMatchObject({ role: "member" });
    expect(await findActiveSession(tokens.owner)).toBeNull();

    expect((await call("GET", "/dashboard/emails", { token: cookie })).status).toBe(200);
    expect((await call("GET", "/dashboard/invitations", { token: cookie })).status).toBe(
      403,
    );

    const login = await call("POST", "/dashboard/login", {
      body: { email: INVITEE, password: PASSWORD },
    });
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toBe("/dashboard");
  });

  test("a cross-origin accept is refused before anything happens", async () => {
    const { invitation } = issued(
      await createInvitation(actors.owner, INVITEE, "member"),
    );
    const response = await call("POST", "/dashboard/invite", {
      origin: "https://evil.example.com",
      body: { token: invitation.token, name: "X", password: PASSWORD, confirm: PASSWORD },
    });
    expect(response.status).toBe(403);
    expect(await findLiveInvitation(invitation.token)).not.toBeNull();
  });
});

/* ─── Revoke and resend ─── */

describe("revoke and resend", () => {
  test("revoke kills the link; a second revoke is not found", async () => {
    const { invitation } = issued(
      await createInvitation(actors.admin, INVITEE, "member"),
    );
    expect(await revokeInvitation(actors.admin, invitation.invitationId)).toEqual({
      ok: true,
    });
    expect(await findLiveInvitation(invitation.token)).toBeNull();
    expect(await revokeInvitation(actors.admin, invitation.invitationId)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  test("resend mints a new link for the same address and role; the old one dies", async () => {
    const first = issued(await createInvitation(actors.owner, INVITEE, "admin"));
    const again = issued(
      await resendInvitation(actors.owner, first.invitation.invitationId),
    );
    expect(again.invitation.email).toBe(INVITEE);
    expect(again.invitation.role).toBe("admin");
    expect(again.invitation.invitationId).not.toBe(first.invitation.invitationId);
    expect(await findLiveInvitation(first.invitation.token)).toBeNull();
    expect(await findLiveInvitation(again.invitation.token)).not.toBeNull();
    expect(await liveInvites(INVITEE)).toHaveLength(1);
    /** The old id is no longer pending. */
    expect(await resendInvitation(actors.owner, first.invitation.invitationId)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  test("an admin cannot revoke or resend an admin invitation", async () => {
    const { invitation } = issued(await createInvitation(actors.owner, INVITEE, "admin"));
    expect(await revokeInvitation(actors.admin, invitation.invitationId)).toEqual({
      ok: false,
      reason: "role_not_allowed",
    });
    expect(await resendInvitation(actors.admin, invitation.invitationId)).toEqual({
      ok: false,
      reason: "role_not_allowed",
    });
    const revoke = await call(
      "POST",
      `/dashboard/invitations/${invitation.invitationId}/revoke`,
      {
        token: tokens.admin,
      },
    );
    expect(revoke.status).toBe(403);
    expect(await findLiveInvitation(invitation.token)).not.toBeNull();
  });

  test("over HTTP: revoke and resend redirect back with a flash; the list shows pending only", async () => {
    const kept = issued(
      await createInvitation(actors.owner, "kept@example.org", "member"),
    );
    const gone = issued(await createInvitation(actors.owner, INVITEE, "member"));

    const revoke = await call(
      "POST",
      `/dashboard/invitations/${gone.invitation.invitationId}/revoke`,
      {
        token: tokens.admin,
      },
    );
    expect(revoke.status).toBe(302);
    expect(decodeURIComponent(revoke.headers.get("location") ?? "")).toContain(
      "Invitation revoked.",
    );

    const resend = await call(
      "POST",
      `/dashboard/invitations/${kept.invitation.invitationId}/resend`,
      {
        token: tokens.admin,
      },
    );
    expect(resend.status).toBe(302);
    expect(await findLiveInvitation(kept.invitation.token)).toBeNull();

    const pending = await listPendingInvitations();
    expect(pending.map((p) => p.email)).toEqual(["kept@example.org"]);
    expect(pending[0]?.invitedBy).toBe("admin@example.com");
  });
});

/* ─── Email path and the one-time link ─── */

describe("email path", () => {
  test("no system sender: not sent, and the link is revealed once to the inviter's session only", async () => {
    const result = issued(
      await createInvitation(actors.owner, "svc@example.org", "member"),
    );
    expect(result.delivery).toEqual({ sent: false, reason: "not_configured" });

    const info = spyOn(logger, "info");
    let location = "";
    try {
      const response = await call("POST", "/dashboard/invitations", {
        token: tokens.owner,
        body: { email: INVITEE, role: "member" },
      });
      expect(response.status).toBe(302);
      location = response.headers.get("location") ?? "";
      const created = info.mock.calls.filter(([m]) => m === "Invitation created");
      expect(created).toHaveLength(1);
      expect(JSON.stringify(created)).not.toMatch(/invite\?token=/);
    } finally {
      info.mockRestore();
    }
    expect(decodeURIComponent(location)).toContain("no system sender is configured");
    expect(location).not.toMatch(/invite\?token=|token%3D/);

    /** Another session of the same user cannot redeem it, nor destroy it. */
    const otherSession = (await seed.session({ userId: actors.owner.id })).token;
    const other = await (await call("GET", location, { token: otherSession })).text();
    expect(revealedToken(other)).toBeNull();

    const first = await (await call("GET", location, { token: tokens.owner })).text();
    const token = revealedToken(first);
    expect(token).not.toBeNull();
    expect(await findLiveInvitation(token ?? "")).toMatchObject({ email: INVITEE });

    const second = await (await call("GET", location, { token: tokens.owner })).text();
    expect(revealedToken(second)).toBeNull();
  });

  test("when the email goes out, no link is revealed", async () => {
    const send = spyOn(inviteEmail, "sendInviteEmail").mockResolvedValue({ sent: true });
    try {
      const response = await call("POST", "/dashboard/invitations", {
        token: tokens.admin,
        body: { email: INVITEE, role: "member" },
      });
      expect(response.status).toBe(302);
      const location = response.headers.get("location") ?? "";
      expect(decodeURIComponent(location)).toContain("Invitation sent by email.");
      expect(location).not.toContain("reveal=");
      expect(send).toHaveBeenCalledTimes(1);
      const [args] = send.mock.calls[0] ?? [];
      expect(args).toMatchObject({
        to: INVITEE,
        role: "member",
        inviter: "admin@example.com",
      });
      expect(args?.url).toMatch(/\/dashboard\/invite\?token=[A-Za-z0-9_-]{43}$/);
    } finally {
      send.mockRestore();
    }
    expect(await liveInvites(INVITEE)).toHaveLength(1);
  });
});

/* ─── Review fixes ─── */

describe("a pending invitation of a higher role", () => {
  test("an admin cannot replace (or downgrade) the owner's admin invitation", async () => {
    const owners = issued(await createInvitation(actors.owner, INVITEE, "admin"));
    expect(await createInvitation(actors.admin, INVITEE, "member")).toEqual({
      ok: false,
      reason: "pending_higher_role",
    });
    expect(await findLiveInvitation(owners.invitation.token)).toMatchObject({
      role: "admin",
    });
    const live = await liveInvites(INVITEE);
    expect(live).toHaveLength(1);
    expect(live[0]?.role).toBe("admin");
  });

  test("over HTTP the refusal is a normal error flash, not the 403 page", async () => {
    const owners = issued(await createInvitation(actors.owner, INVITEE, "admin"));
    const response = await call("POST", "/dashboard/invitations", {
      token: tokens.admin,
      body: { email: INVITEE, role: "member" },
    });
    expect(response.status).toBe(302);
    const location = decodeURIComponent(response.headers.get("location") ?? "");
    expect(location).toContain("A pending invitation from a higher role exists");
    expect(location).toContain("flashType=error");
    expect(await findLiveInvitation(owners.invitation.token)).not.toBeNull();
  });

  test("the owner may replace its own admin invitation with a member one", async () => {
    issued(await createInvitation(actors.owner, INVITEE, "admin"));
    const replaced = issued(await createInvitation(actors.owner, INVITEE, "member"));
    expect(replaced.invitation.replaced).toBe(1);
    const live = await liveInvites(INVITEE);
    expect(live.map((r) => r.role)).toEqual(["member"]);
  });
});

describe("the inviter is re-checked at acceptance", () => {
  /** An admin's member invitation, then `change` applied to the admin by direct SQL. */
  async function inviteThen(change: () => Promise<unknown>): Promise<string> {
    const { invitation } = issued(
      await createInvitation(actors.admin, INVITEE, "member"),
    );
    expect(await findLiveInvitation(invitation.token)).not.toBeNull();
    await change();
    return invitation.token;
  }

  /** The token is dead everywhere: lookup, service, GET and POST, and argon2 never runs. */
  async function expectDead(token: string): Promise<void> {
    const hashSpy = spyOn(Bun.password, "hash");
    try {
      expect(await findLiveInvitation(token)).toBeNull();
      expect(await acceptInvitation(token, { name: "X", password: PASSWORD })).toEqual({
        ok: false,
        reason: "invalid",
      });
      expect((await call("GET", `/dashboard/invite?token=${token}`)).status).toBe(400);
      const post = await postAccept(token);
      expect(post.status).toBe(400);
      expect(await post.text()).toContain("This invitation link is not valid");
      expect(hashSpy).not.toHaveBeenCalled();
    } finally {
      hashSpy.mockRestore();
    }
    expect(await db.select().from(users).where(eq(users.email, INVITEE))).toHaveLength(0);
  }

  test("a disabled inviter", async () => {
    const token = await inviteThen(() =>
      db
        .update(users)
        .set({ disabledAt: sql`now()` })
        .where(eq(users.id, actors.admin.id)),
    );
    await expectDead(token);
  });

  test("a deleted inviter (invited_by set to NULL)", async () => {
    const token = await inviteThen(() =>
      db.delete(users).where(eq(users.id, actors.admin.id)),
    );
    const [row] = await db
      .select({ invitedBy: userTokens.invitedBy })
      .from(userTokens)
      .where(eq(userTokens.tokenHash, hashToken(token)));
    expect(row?.invitedBy).toBeNull();
    await expectDead(token);
  });

  test("a demoted inviter (admin to member)", async () => {
    const token = await inviteThen(() =>
      db.update(users).set({ role: "member" }).where(eq(users.id, actors.admin.id)),
    );
    await expectDead(token);
  });

  test("an admin invitation from an owner demoted to admin is dead too", async () => {
    const { invitation } = issued(await createInvitation(actors.owner, INVITEE, "admin"));
    await db.update(users).set({ role: "admin" }).where(eq(users.id, actors.owner.id));
    expect(await findLiveInvitation(invitation.token)).toBeNull();
  });

  test("an inviter disabled after the pre-check but before the spend: the spend refuses", async () => {
    const { invitation } = issued(
      await createInvitation(actors.admin, INVITEE, "member"),
    );
    const realHash = Bun.password.hash.bind(Bun.password);
    const hashSpy = spyOn(Bun.password, "hash").mockImplementation(
      async (password, options) => {
        /** Runs between `findLiveInvitation` and the locked spend. */
        await db
          .update(users)
          .set({ disabledAt: sql`now()` })
          .where(eq(users.id, actors.admin.id));
        return realHash(password, options);
      },
    );
    try {
      expect(
        await acceptInvitation(invitation.token, { name: "X", password: PASSWORD }),
      ).toEqual({ ok: false, reason: "invalid" });
      expect(hashSpy).toHaveBeenCalledTimes(1);
    } finally {
      hashSpy.mockRestore();
    }
    expect(await db.select().from(users).where(eq(users.email, INVITEE))).toHaveLength(0);
    const [row] = await db
      .select({ usedAt: userTokens.usedAt })
      .from(userTokens)
      .where(eq(userTokens.id, invitation.invitationId));
    expect(row?.usedAt).toBeNull();
  });
});

describe("no usable APP_BASE_URL", () => {
  test.each(["", "javascript:alert(1)"])(
    "APP_BASE_URL=%p: the localhost link is never emailed, it is revealed once instead",
    async (base) => {
      setBaseUrl(base);
      const send = spyOn(inviteEmail, "sendInviteEmail").mockResolvedValue({
        sent: true,
      });
      try {
        const result = issued(
          await createInvitation(actors.owner, "svc@example.org", "member"),
        );
        expect(result.delivery).toEqual({ sent: false, reason: "no_base_url" });
        expect(result.url).toStartWith("http://localhost:");

        const response = await call("POST", "/dashboard/invitations", {
          token: tokens.owner,
          body: { email: INVITEE, role: "member" },
        });
        expect(response.status).toBe(302);
        const location = response.headers.get("location") ?? "";
        expect(decodeURIComponent(location)).toContain(
          "APP_BASE_URL is not set, so no usable link could be emailed",
        );
        const page = await (await call("GET", location, { token: tokens.owner })).text();
        expect(page).toContain("http://localhost:");
        expect(revealedToken(page)).not.toBeNull();
        expect(send).not.toHaveBeenCalled();
      } finally {
        send.mockRestore();
      }
    },
  );
});
