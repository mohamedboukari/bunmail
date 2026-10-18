/**
 * Admin-issued password reset links (#277) against real Postgres: who may
 * issue one for whom (service and crafted HTTP), one live link per
 * account, the one-hour expiry on the database clock, the one-time reveal
 * to the issuing session only, and completion (password replaced, every
 * session and every other open token of the account revoked, a fresh
 * session opened). Every dead link (expired, used, revoked, unknown,
 * malformed, or no longer backed by its issuer or its account) gets the
 * identical 400 page without reaching argon2id.
 *
 * `APP_BASE_URL` is pinned to a public URL for every test.
 */
import { describe, test, expect, afterAll, beforeEach, spyOn } from "bun:test";
import { Elysia } from "elysia";
import { and, eq, gt, isNull, sql, type SQL } from "drizzle-orm";
import { db, seed, sessions, truncateAll } from "./_helpers.ts";
import { pagesPlugin } from "../../src/pages/pages.plugin.tsx";
import { readSessionCookie } from "../../src/pages/session.ts";
import { users } from "../../src/modules/users/models/user.schema.ts";
import { userTokens } from "../../src/modules/users/models/user-token.schema.ts";
import {
  completePasswordReset,
  findLivePasswordReset,
} from "../../src/modules/users/services/password-reset.service.ts";
import {
  changeAccountRole,
  deactivateAccount,
  issuePasswordReset,
  reactivateAccount,
  transferOwnership,
} from "../../src/modules/users/services/user-admin.service.ts";
import * as loginService from "../../src/modules/users/services/login.service.ts";
import { verifyPasswordLogin } from "../../src/modules/users/services/login.service.ts";
import {
  createSession,
  findActiveSession,
} from "../../src/modules/users/services/session.service.ts";
import {
  acceptInvitation,
  createInvitation,
  findLiveInvitation,
} from "../../src/modules/users/services/invite.service.ts";
import {
  completeOwnerSetup,
  issueOwnerSetupLink,
} from "../../src/modules/users/services/owner.service.ts";
import { userCredentials } from "../../src/modules/users/models/user-credential.schema.ts";
import { UserStoreError } from "../../src/modules/users/errors.ts";
import { loginAttemptMap } from "../../src/middleware/login-rate-limit.ts";
import { hashToken, mintToken } from "../../src/modules/users/services/token.service.ts";
import { generateId } from "../../src/utils/id.ts";
import { logger } from "../../src/utils/logger.ts";
import { redactEmail } from "../../src/utils/redact.ts";
import { config } from "../../src/config.ts";
import type {
  AccountRefusal,
  AttemptLimiter,
  IssuePasswordResetResult,
  UserRole,
} from "../../src/modules/users/types/user.types.ts";

const app = new Elysia().use(pagesPlugin);

const OLD_PASSWORD = "the old password, long enough";
const NEW_PASSWORD = "a brand new passphrase, long";

/** The accounts seeded before every test, by name. */
type Name = "owner" | "admin" | "admin2" | "member" | "member2";
const NAMES: Name[] = ["owner", "admin", "admin2", "member", "member2"];
const ROLE_OF: Record<Name, UserRole> = {
  owner: "owner",
  admin: "admin",
  admin2: "admin",
  member: "member",
  member2: "member",
};
const ids: Record<Name, string> = {
  owner: "",
  admin: "",
  admin2: "",
  member: "",
  member2: "",
};
/** A live session token per account. */
const tokens: Record<Name, string> = {
  owner: "",
  admin: "",
  admin2: "",
  member: "",
  member2: "",
};

/** The public base URL every test runs with. */
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
  /** Login attempts in these tests all come from the same (unknown) IP. */
  loginAttemptMap.clear();
  await truncateAll();
  for (const name of NAMES) {
    const { id } = await seed.user({
      email: `${name}@example.com`,
      role: ROLE_OF[name],
      password: OLD_PASSWORD,
    });
    ids[name] = id;
    tokens[name] = (await seed.session({ userId: id })).token;
  }
});

/* ─── Helpers ─── */

/** A transfer budget that never limits, for the ownership transfer test. */
const NO_LIMIT: AttemptLimiter = {
  isLimited: () => false,
  record: () => undefined,
  clear: () => undefined,
};

/** A request, same-origin unless overridden, optionally with a session cookie and a form body. */
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

/** Submits the reset form, optionally from a browser holding `cookie`. */
function postReset(
  token: string,
  password: string = NEW_PASSWORD,
  cookie?: string,
): Promise<Response> {
  return call("POST", "/dashboard/reset", {
    token: cookie,
    body: { token, password, confirm: password },
  });
}

/** Asserts an issue succeeded and returns its raw token (from the link). */
function issuedToken(result: IssuePasswordResetResult): string {
  if (!result.ok) throw new Error(`expected a reset link, got ${result.reason}`);
  const token = new URL(result.url).searchParams.get("token");
  if (!token) throw new Error("the link carries no token");
  return token;
}

/** Issues a link as `issuer` for `target` and returns its raw token. */
async function issue(issuer: Name, target: Name): Promise<string> {
  return issuedToken(await issuePasswordReset(ids[issuer], ids[target]));
}

/** The raw reset token in a page's revealed link, or null. */
function revealedToken(html: string): string | null {
  return html.match(/\/dashboard\/reset\?token=([A-Za-z0-9_-]{43})/)?.[1] ?? null;
}

/** Live reset links of an account (open and unexpired, database clock). */
function liveResets(userId: string): Promise<Array<{ id: string }>> {
  return db
    .select({ id: userTokens.id })
    .from(userTokens)
    .where(
      and(
        eq(userTokens.purpose, "password_reset"),
        eq(userTokens.userId, userId),
        isNull(userTokens.usedAt),
        isNull(userTokens.revokedAt),
        gt(userTokens.expiresAt, sql`now()`),
      ),
    );
}

/** The `user_credentials.id` of an account's password, or null. */
async function passwordCredentialId(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: userCredentials.id })
    .from(userCredentials)
    .where(and(eq(userCredentials.userId, userId), eq(userCredentials.type, "password")));
  return row?.id ?? null;
}

/** The credential a session (by its raw token) is bound to; undefined when it is gone. */
async function sessionCredential(token: string): Promise<string | null | undefined> {
  const [row] = await db
    .select({ credentialId: sessions.credentialId })
    .from(sessions)
    .where(eq(sessions.tokenHash, hashToken(token)));
  return row === undefined ? undefined : row.credentialId;
}

/** Number of `user_tokens` rows of any state. */
async function tokenRows(): Promise<number> {
  return (await db.select({ id: userTokens.id }).from(userTokens)).length;
}

/** How many sessions an account has. */
async function sessionCount(userId: string): Promise<number> {
  return (
    await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId))
  ).length;
}

/** Inserts a reset link directly (bypassing the service), returning its raw token. */
async function insertReset(opts: {
  userId: string;
  issuedBy: string;
  expiresAt?: Date | SQL;
  usedAt?: Date | null;
  revokedAt?: Date | null;
}): Promise<string> {
  const { token, hash } = mintToken();
  await db.insert(userTokens).values({
    id: generateId("utk"),
    userId: opts.userId,
    purpose: "password_reset",
    invitedBy: opts.issuedBy,
    tokenHash: hash,
    expiresAt: opts.expiresAt ?? sql`now() + interval '1 hour'`,
    usedAt: opts.usedAt ?? null,
    revokedAt: opts.revokedAt ?? null,
  });
  return token;
}

/**
 * The token is dead everywhere: lookup, service, GET and POST (the
 * identical 400 page), and argon2id never runs. Unless `passwordSet`,
 * the account's password was never changed to `NEW_PASSWORD`.
 */
async function expectDead(
  token: string,
  userId: string,
  passwordSet: boolean = false,
): Promise<void> {
  const hashSpy = spyOn(Bun.password, "hash");
  hashSpy.mockClear();
  try {
    expect(await findLivePasswordReset(token)).toBeNull();
    expect(await completePasswordReset(token, NEW_PASSWORD)).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect((await call("GET", `/dashboard/reset?token=${token}`)).status).toBe(400);
    const post = await postReset(token);
    expect(post.status).toBe(400);
    expect(await post.text()).toContain("This password reset link is not valid");
    expect(hashSpy).not.toHaveBeenCalled();
  } finally {
    hashSpy.mockRestore();
  }
  const [row] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  if (row && !passwordSet) {
    expect((await verifyPasswordLogin(row.email, NEW_PASSWORD)).ok).toBe(false);
  }
}

/* ─── Who may issue a link for whom ─── */

describe("issue rules (service)", () => {
  test("the owner resets an admin and a member; an admin resets a member", async () => {
    for (const [issuer, target] of [
      ["owner", "admin"],
      ["owner", "member"],
      ["admin", "member2"],
    ] as const) {
      const token = await issue(issuer, target);
      expect(await findLivePasswordReset(token)).toEqual({
        resetId: expect.stringMatching(/^utk_/),
        userId: ids[target],
        email: `${target}@example.com`,
      });
      const [row] = await db
        .select({ invitedBy: userTokens.invitedBy, email: userTokens.email })
        .from(userTokens)
        .where(eq(userTokens.tokenHash, hashToken(token)));
      expect(row).toEqual({ invitedBy: ids[issuer], email: null });
    }
    /** Issuing touches neither the target's sessions nor its password. */
    expect(await sessionCount(ids.admin)).toBe(1);
    expect((await verifyPasswordLogin("admin@example.com", OLD_PASSWORD)).ok).toBe(true);
  });

  test("refusals: an admin on an admin, anyone on the owner or on themselves, a member, a disabled account", async () => {
    await db
      .update(users)
      .set({ disabledAt: sql`now()` })
      .where(eq(users.id, ids.member2));
    const cases: Array<[Name, Name, AccountRefusal]> = [
      ["admin", "admin2", "role_not_allowed"],
      ["admin", "owner", "target_is_owner"],
      ["owner", "owner", "self"],
      ["admin", "admin", "self"],
      ["member", "member", "self"],
      ["member", "member2", "role_not_allowed"],
      ["member", "admin", "role_not_allowed"],
      ["owner", "member2", "account_disabled"],
      ["admin", "member2", "account_disabled"],
    ];
    for (const [issuer, target, reason] of cases) {
      expect(await issuePasswordReset(ids[issuer], ids[target])).toEqual({
        ok: false,
        reason,
      });
    }
    expect(await issuePasswordReset(ids.owner, "usr_missing")).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await tokenRows()).toBe(0);
  });

  test("a disabled issuer cannot issue", async () => {
    await db
      .update(users)
      .set({ disabledAt: sql`now()` })
      .where(eq(users.id, ids.admin));
    expect(await issuePasswordReset(ids.admin, ids.member)).toEqual({
      ok: false,
      reason: "actor_inactive",
    });
    expect(await tokenRows()).toBe(0);
  });

  test("a link expires one hour after issue, on the database clock", async () => {
    const token = await issue("owner", "member");
    const [row] = await db
      .select({
        ttl: sql<number>`extract(epoch from (${userTokens.expiresAt} - ${userTokens.createdAt}))::int`,
      })
      .from(userTokens)
      .where(eq(userTokens.tokenHash, hashToken(token)));
    expect(row?.ttl).toBe(3600);
  });

  test("a second link revokes the first: one live link per account", async () => {
    const first = await issue("owner", "member");
    const second = await issue("admin", "member");
    expect(await findLivePasswordReset(first)).toBeNull();
    expect(await findLivePasswordReset(second)).not.toBeNull();
    expect(await liveResets(ids.member)).toHaveLength(1);
    await expectDead(first, ids.member);
  });
});

describe("issue rules (crafted HTTP)", () => {
  test("a member, an admin on an admin and anyone on the owner get 403; nothing written", async () => {
    const crafted: Array<[Name, Name]> = [
      ["member", "member2"],
      ["admin", "admin2"],
      ["admin", "owner"],
      ["owner", "owner"],
    ];
    for (const [issuer, target] of crafted) {
      const response = await call(
        "POST",
        `/dashboard/users/${ids[target]}/reset-password`,
        {
          token: tokens[issuer],
        },
      );
      expect(response.status).toBe(403);
    }
    expect(await tokenRows()).toBe(0);
  });

  test("a disabled account is an error flash, not a link", async () => {
    await db
      .update(users)
      .set({ disabledAt: sql`now()` })
      .where(eq(users.id, ids.member));
    const response = await call("POST", `/dashboard/users/${ids.member}/reset-password`, {
      token: tokens.owner,
    });
    expect(response.status).toBe(302);
    const location = response.headers.get("location") ?? "";
    expect(decodeURIComponent(location)).toContain("Reactivate the account");
    expect(location).not.toContain("reveal=");
    expect(await tokenRows()).toBe(0);
  });

  test("a cross-origin issue is refused by the session guard", async () => {
    const response = await call("POST", `/dashboard/users/${ids.member}/reset-password`, {
      token: tokens.owner,
      origin: "https://evil.example.com",
    });
    expect(response.status).toBe(403);
    expect(await tokenRows()).toBe(0);
  });

  test("the Users page offers the action only where it is allowed", async () => {
    const asAdmin = await (
      await call("GET", "/dashboard/users", { token: tokens.admin })
    ).text();
    expect(asAdmin).toContain(`/dashboard/users/${ids.member}/reset-password`);
    expect(asAdmin).not.toContain(`/dashboard/users/${ids.admin2}/reset-password`);
    expect(asAdmin).not.toContain(`/dashboard/users/${ids.owner}/reset-password`);
    expect(asAdmin).not.toContain(`/dashboard/users/${ids.admin}/reset-password`);
    const asOwner = await (
      await call("GET", "/dashboard/users", { token: tokens.owner })
    ).text();
    expect(asOwner).toContain(`/dashboard/users/${ids.admin}/reset-password`);
    expect(asOwner).not.toContain(`/dashboard/users/${ids.owner}/reset-password`);
  });
});

/* ─── The one-time reveal ─── */

describe("reveal", () => {
  test("the link is revealed once, to the issuing session only, and never logged", async () => {
    const info = spyOn(logger, "info");
    info.mockClear();
    let location = "";
    try {
      const response = await call(
        "POST",
        `/dashboard/users/${ids.member}/reset-password`,
        {
          token: tokens.owner,
        },
      );
      expect(response.status).toBe(302);
      location = response.headers.get("location") ?? "";
      const issued = info.mock.calls.filter(([m]) => m === "Password reset link issued");
      expect(issued).toHaveLength(1);
      expect(issued[0]?.[1]).toMatchObject({
        action: "reset_password",
        actorId: ids.owner,
        targetUserId: ids.member,
        resetLinksRevoked: 0,
      });
      expect(JSON.stringify(info.mock.calls)).not.toMatch(/reset\?token=/);
    } finally {
      info.mockRestore();
    }
    expect(location).toContain("reveal=");
    expect(location).not.toMatch(/reset\?token=|token%3D/);

    /** Another session of the same user, and another admin, cannot redeem it, nor destroy it. */
    const otherSession = (await seed.session({ userId: ids.owner })).token;
    const other = await (await call("GET", location, { token: otherSession })).text();
    expect(revealedToken(other)).toBeNull();
    const admin = await (await call("GET", location, { token: tokens.admin })).text();
    expect(revealedToken(admin)).toBeNull();

    const first = await call("GET", location, { token: tokens.owner });
    expect(first.headers.get("cache-control")).toBe("no-store");
    const html = await first.text();
    expect(html).toContain(`${BASE_URL}/dashboard/reset?token=`);
    const token = revealedToken(html);
    expect(token).not.toBeNull();
    expect(await findLivePasswordReset(token ?? "")).toMatchObject({
      userId: ids.member,
    });

    const second = await (await call("GET", location, { token: tokens.owner })).text();
    expect(revealedToken(second)).toBeNull();
  });
});

/* ─── Completing a reset ─── */

describe("completion", () => {
  test("replaces the password, revokes every session and other open token, opens a session", async () => {
    const token = await issue("admin", "member");
    /** More sessions of the member, and a stray open token of it. */
    const extra = (await seed.session({ userId: ids.member })).token;
    const stray = await insertReset({ userId: ids.member, issuedBy: ids.owner });
    /** Another account's session and link are untouched. */
    const otherLink = await issue("owner", "member2");

    const result = await completePasswordReset(token, NEW_PASSWORD, {
      ip: "203.0.113.9",
      userAgent: "it-agent",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result).toMatchObject({
      userId: ids.member,
      email: "member@example.com",
      issuedBy: ids.admin,
      sessionsRevoked: 2,
      tokensRevoked: 1,
    });

    expect((await verifyPasswordLogin("member@example.com", OLD_PASSWORD)).ok).toBe(
      false,
    );
    expect((await verifyPasswordLogin("member@example.com", NEW_PASSWORD)).ok).toBe(true);

    /** Every earlier session is gone: the seeded ones get a 302 to the login page. */
    for (const old of [tokens.member, extra]) {
      const response = await call("GET", "/dashboard/emails", { token: old });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard/login");
    }
    expect(await findActiveSession(result.sessionToken)).toMatchObject({
      userId: ids.member,
      role: "member",
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
      .where(eq(userTokens.tokenHash, hashToken(token)));
    expect(spent?.usedAt).not.toBeNull();
    expect(await findLivePasswordReset(stray)).toBeNull();
    expect(await liveResets(ids.member)).toHaveLength(0);

    expect(await findLivePasswordReset(otherLink)).not.toBeNull();
    expect(await sessionCount(ids.member2)).toBe(1);

    /** Spent: a second use is invalid. */
    await expectDead(token, ids.member, true);
  });

  test("two concurrent completions of one link: exactly one succeeds", async () => {
    const token = await issue("owner", "member");
    const results = await Promise.all([
      completePasswordReset(token, NEW_PASSWORD),
      completePasswordReset(token, `${NEW_PASSWORD}!`),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await sessionCount(ids.member)).toBe(1);
  }, 30_000);

  test("over HTTP: form, then cookie, 302, the browser's own session replaced, logged without secrets", async () => {
    const token = await issue("owner", "admin");
    const form = await call("GET", `/dashboard/reset?token=${token}`);
    expect(form.status).toBe(200);
    expect(form.headers.get("referrer-policy")).toBe("strict-origin");
    expect(form.headers.get("cache-control")).toBe("no-store");
    expect(await form.text()).toContain("admin@example.com");

    /** A policy failure re-renders the form without hashing. */
    const hashSpy = spyOn(Bun.password, "hash");
    hashSpy.mockClear();
    try {
      const short = await postReset(token, "short");
      expect(short.status).toBe(200);
      expect(await short.text()).toContain("at least 15 characters");
      expect(hashSpy).not.toHaveBeenCalled();
    } finally {
      hashSpy.mockRestore();
    }

    /** A session the browser holds (the owner's, here) is revoked, as login does. */
    const warn = spyOn(logger, "warn");
    warn.mockClear();
    let response: Response;
    try {
      response = await postReset(token, NEW_PASSWORD, tokens.owner);
      const done = warn.mock.calls.filter(([m]) => m === "Password reset completed");
      expect(done).toHaveLength(1);
      expect(done[0]?.[1]).toMatchObject({
        userId: ids.admin,
        issuedBy: ids.owner,
        sessionsRevoked: 1,
        email: redactEmail("admin@example.com"),
      });
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain(token);
      expect(logged).not.toContain(NEW_PASSWORD);
    } finally {
      warn.mockRestore();
    }
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/dashboard");
    const cookie = readSessionCookie(response.headers.get("set-cookie")) ?? "";
    expect(await findActiveSession(cookie)).toMatchObject({
      userId: ids.admin,
      role: "admin",
    });
    expect(await findActiveSession(tokens.owner)).toBeNull();
    expect(await findActiveSession(tokens.admin)).toBeNull();
    expect((await call("GET", "/dashboard/users", { token: cookie })).status).toBe(200);

    const login = await call("POST", "/dashboard/login", {
      body: { email: "admin@example.com", password: NEW_PASSWORD },
    });
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toBe("/dashboard");
  });

  test("a cross-origin reset is refused before anything happens", async () => {
    const token = await issue("owner", "member");
    const response = await call("POST", "/dashboard/reset", {
      origin: "https://evil.example.com",
      body: { token, password: NEW_PASSWORD, confirm: NEW_PASSWORD },
    });
    expect(response.status).toBe(403);
    expect(await findLivePasswordReset(token)).not.toBeNull();
    expect((await verifyPasswordLogin("member@example.com", OLD_PASSWORD)).ok).toBe(true);
  });
});

/* ─── Dead links ─── */

describe("dead links over HTTP", () => {
  test("expired (database clock), used, revoked, unknown and malformed links get the identical 400 page and never reach argon2", async () => {
    const expired = await insertReset({
      userId: ids.member,
      issuedBy: ids.owner,
      expiresAt: sql`now() - interval '1 second'`,
    });
    const used = await insertReset({
      userId: ids.member,
      issuedBy: ids.owner,
      usedAt: new Date(),
    });
    const revoked = await insertReset({
      userId: ids.member,
      issuedBy: ids.owner,
      revokedAt: new Date(),
    });
    const unknown = mintToken().token;

    const hashSpy = spyOn(Bun.password, "hash");
    hashSpy.mockClear();
    try {
      const bodies = new Set<string>();
      for (const token of [expired, used, revoked, unknown, "not-a-token", ""]) {
        const view = await call("GET", `/dashboard/reset?token=${token}`);
        expect(view.status).toBe(400);
        bodies.add(await view.text());

        const submit = await postReset(token);
        expect(submit.status).toBe(400);
        expect(submit.headers.get("set-cookie")).toBeNull();
        bodies.add(await submit.text());
      }
      expect(bodies.size).toBe(1);
      expect([...bodies][0]).toContain("This password reset link is not valid");
      expect(hashSpy).not.toHaveBeenCalled();
    } finally {
      hashSpy.mockRestore();
    }
    expect((await verifyPasswordLogin("member@example.com", OLD_PASSWORD)).ok).toBe(true);
    expect(await sessionCount(ids.member)).toBe(1);
  });

  test("GET never spends the link", async () => {
    const token = await issue("owner", "member");
    for (let i = 0; i < 3; i++) {
      expect((await call("GET", `/dashboard/reset?token=${token}`)).status).toBe(200);
    }
    expect(await findLivePasswordReset(token)).not.toBeNull();
  });
});

/* ─── Issuer and account re-checked at use ─── */

describe("the issuer and the account are re-checked at use", () => {
  test("an issuer disabled after issuing", async () => {
    const token = await issue("admin", "member");
    await db
      .update(users)
      .set({ disabledAt: sql`now()` })
      .where(eq(users.id, ids.admin));
    await expectDead(token, ids.member);
  });

  test("an issuer demoted after issuing (admin to member)", async () => {
    const token = await issue("admin", "member");
    await db.update(users).set({ role: "member" }).where(eq(users.id, ids.admin));
    await expectDead(token, ids.member);
  });

  test("an owner's link for an admin, once the owner is demoted to admin", async () => {
    const token = await issue("owner", "admin");
    await db.update(users).set({ role: "admin" }).where(eq(users.id, ids.owner));
    await expectDead(token, ids.admin);
  });

  test("an issuer deleted after issuing (issued by set to NULL)", async () => {
    const token = await issue("admin", "member");
    await db.delete(users).where(eq(users.id, ids.admin));
    const [row] = await db
      .select({ invitedBy: userTokens.invitedBy })
      .from(userTokens)
      .where(eq(userTokens.tokenHash, hashToken(token)));
    expect(row?.invitedBy).toBeNull();
    await expectDead(token, ids.member);
  });

  test("the account disabled after issuing", async () => {
    const token = await issue("owner", "member");
    await db
      .update(users)
      .set({ disabledAt: sql`now()` })
      .where(eq(users.id, ids.member));
    await expectDead(token, ids.member);
  });

  test("the account promoted beyond the issuer's reach (member to admin, issued by an admin)", async () => {
    const token = await issue("admin", "member");
    await db.update(users).set({ role: "admin" }).where(eq(users.id, ids.member));
    await expectDead(token, ids.member);
  });

  test("deactivating the account revokes its link, so reactivating it revives nothing", async () => {
    const token = await issue("owner", "member");
    expect(await deactivateAccount(ids.owner, ids.member)).toEqual({ ok: true });
    expect(await reactivateAccount(ids.owner, ids.member)).toEqual({ ok: true });
    await expectDead(token, ids.member);
  });

  test("deactivating the issuer revokes the links it issued", async () => {
    const token = await issue("admin", "member");
    expect(await deactivateAccount(ids.owner, ids.admin)).toEqual({ ok: true });
    expect(await reactivateAccount(ids.owner, ids.admin)).toEqual({ ok: true });
    await expectDead(token, ids.member);
  });

  test("an issuer disabled after the pre-check but before the spend: the spend refuses", async () => {
    const token = await issue("admin", "member");
    const realHash = Bun.password.hash.bind(Bun.password);
    const hashSpy = spyOn(Bun.password, "hash").mockImplementation(
      async (password, options) => {
        /** Runs between `findLivePasswordReset` and the locked spend. */
        await db
          .update(users)
          .set({ disabledAt: sql`now()` })
          .where(eq(users.id, ids.admin));
        return realHash(password, options);
      },
    );
    hashSpy.mockClear();
    try {
      expect(await completePasswordReset(token, NEW_PASSWORD)).toEqual({
        ok: false,
        reason: "invalid",
      });
      expect(hashSpy).toHaveBeenCalledTimes(1);
    } finally {
      hashSpy.mockRestore();
    }
    const [row] = await db
      .select({ usedAt: userTokens.usedAt })
      .from(userTokens)
      .where(eq(userTokens.tokenHash, hashToken(token)));
    expect(row?.usedAt).toBeNull();
    expect((await verifyPasswordLogin("member@example.com", OLD_PASSWORD)).ok).toBe(true);
    expect(await sessionCount(ids.member)).toBe(1);
  });

  test("an ownership transfer revokes the previous owner's links for admins: a round trip revives none", async () => {
    /** The owner (A) issues links for admin2 (C), for admin (B, the next owner) and for a member. */
    const forAdmin = await issue("owner", "admin2");
    const forNextOwner = await issue("owner", "admin");
    const forMember = await issue("owner", "member");

    const info = spyOn(logger, "info");
    info.mockClear();
    try {
      expect(
        await transferOwnership(ids.owner, ids.admin, OLD_PASSWORD, NO_LIMIT),
      ).toEqual({
        ok: true,
      });
      const line = info.mock.calls.find(([m]) => m === "Ownership transferred");
      expect(line?.[1]).toMatchObject({ resetLinksRevoked: 2 });
    } finally {
      info.mockRestore();
    }
    /** A is now an admin and still manages members: that link stays usable. */
    expect(await findLivePasswordReset(forMember)).not.toBeNull();

    /** B hands ownership back to A within the hour. */
    expect(await transferOwnership(ids.admin, ids.owner, OLD_PASSWORD, NO_LIMIT)).toEqual(
      {
        ok: true,
      },
    );
    const [owner] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, "owner"));
    expect(owner?.id).toBe(ids.owner);

    expect(await findLivePasswordReset(forAdmin)).toBeNull();
    expect(await findLivePasswordReset(forNextOwner)).toBeNull();
    await expectDead(forAdmin, ids.admin2);
    expect(await findLivePasswordReset(forMember)).not.toBeNull();
  });
});

/* ─── Review fixes ─── */

describe("sessions are bound to the credential they were opened with", () => {
  test("replacing a credential deletes the sessions bound to it (cascade), also through a reset", async () => {
    /** Directly: deleting member2's credential takes its bound session along. */
    const member2Cred = await passwordCredentialId(ids.member2);
    const bound2 = (
      await seed.session({ userId: ids.member2, credentialId: member2Cred })
    ).token;
    await db.delete(userCredentials).where(eq(userCredentials.userId, ids.member2));
    expect(await sessionCredential(bound2)).toBeUndefined();
    /** An unbound (pre-#277) session is not touched by the cascade. */
    expect(await sessionCount(ids.member2)).toBe(1);

    /** Through a completed reset. */
    const oldCred = await passwordCredentialId(ids.member);
    const bound = (await seed.session({ userId: ids.member, credentialId: oldCred }))
      .token;
    expect(await sessionCredential(bound)).toBe(oldCred);
    const result = await completePasswordReset(
      await issue("owner", "member"),
      NEW_PASSWORD,
    );
    expect(result.ok).toBe(true);
    expect(await sessionCredential(bound)).toBeUndefined();
    expect(await findActiveSession(bound)).toBeNull();
  });

  test("a session cannot be opened on a credential a reset replaced (service)", async () => {
    const oldCred = await passwordCredentialId(ids.member);
    expect(
      (await completePasswordReset(await issue("owner", "member"), NEW_PASSWORD)).ok,
    ).toBe(true);
    let caught: unknown = null;
    try {
      await createSession({
        userId: ids.member,
        assurance: "password",
        authMethod: "password",
        credentialId: oldCred,
        ip: null,
        userAgent: null,
      });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UserStoreError);
    expect(caught instanceof UserStoreError ? caught.sqlState : null).toBe("23503");
  });

  test("a login racing a reset: the old password verified, the reset completes, the login fails generically", async () => {
    const link = await issue("owner", "member");
    const realVerify = loginService.verifyPasswordLogin;
    const verify = spyOn(loginService, "verifyPasswordLogin").mockImplementation(
      async (email, password) => {
        const result = await realVerify(email, password);
        /** The reset lands between the password check and the session insert. */
        expect((await completePasswordReset(link, NEW_PASSWORD)).ok).toBe(true);
        return result;
      },
    );
    verify.mockClear();
    const warn = spyOn(logger, "warn");
    warn.mockClear();
    let response: Response;
    try {
      response = await call("POST", "/dashboard/login", {
        body: { email: "member@example.com", password: OLD_PASSWORD },
      });
      expect(verify).toHaveBeenCalledTimes(1);
      const failed = warn.mock.calls.filter(([m]) => m === "Dashboard login failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]?.[1]).toMatchObject({
        reason: "credential_replaced",
        userId: ids.member,
      });
    } finally {
      verify.mockRestore();
      warn.mockRestore();
    }
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/dashboard/login?error=invalid");
    expect(response.headers.get("set-cookie")).toBeNull();
    /** Only the reset's own session exists for the account. */
    expect(await sessionCount(ids.member)).toBe(1);
    /** The failure was counted against the IP. */
    expect(loginAttemptMap.size).toBeGreaterThan(0);
  });

  test("login, owner setup, invitation acceptance and reset bind the session to the current credential", async () => {
    /** Login. */
    const login = await call("POST", "/dashboard/login", {
      body: { email: "member@example.com", password: OLD_PASSWORD },
    });
    expect(login.status).toBe(302);
    const loginCookie = readSessionCookie(login.headers.get("set-cookie")) ?? "";
    expect(await sessionCredential(loginCookie)).toBe(
      await passwordCredentialId(ids.member),
    );

    /** Owner setup (a recovery link for the existing owner). */
    const setupLink = await issueOwnerSetupLink(null);
    const setup = await completeOwnerSetup(setupLink.token, NEW_PASSWORD);
    expect(setup).not.toBeNull();
    const ownerCred = await passwordCredentialId(ids.owner);
    expect(ownerCred).not.toBeNull();
    expect(await sessionCredential(setup?.sessionToken ?? "")).toBe(ownerCred);

    /** Invitation acceptance. */
    const invited = await createInvitation(
      { id: ids.owner, role: "owner" },
      "invitee@example.org",
      "member",
    );
    if (!invited.ok) throw new Error(`expected an invitation, got ${invited.reason}`);
    const accepted = await acceptInvitation(invited.invitation.token, {
      name: "Invitee",
      password: NEW_PASSWORD,
    });
    if (!accepted.ok) throw new Error(`expected an account, got ${accepted.reason}`);
    expect(await sessionCredential(accepted.sessionToken)).toBe(
      await passwordCredentialId(accepted.userId),
    );

    /** Reset. */
    const reset = await completePasswordReset(
      await issue("owner", "admin"),
      NEW_PASSWORD,
    );
    if (!reset.ok) throw new Error("expected a completed reset");
    const adminCred = await passwordCredentialId(ids.admin);
    expect(await sessionCredential(reset.sessionToken)).toBe(adminCred);
  });
});

describe("a completed reset revokes what the account issued", () => {
  test("its open invitations and reset links die with its old password", async () => {
    const invited = await createInvitation(
      { id: ids.admin, role: "admin" },
      "pending@example.org",
      "member",
    );
    if (!invited.ok) throw new Error(`expected an invitation, got ${invited.reason}`);
    const memberLink = await issue("admin", "member");
    /** Another issuer's invitation is untouched. */
    const ownerInvite = await createInvitation(
      { id: ids.owner, role: "owner" },
      "other@example.org",
      "member",
    );
    if (!ownerInvite.ok) throw new Error("expected the owner's invitation");

    const result = await completePasswordReset(
      await issue("owner", "admin"),
      NEW_PASSWORD,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.issuedTokensRevoked).toBe(2);
    expect(await findLiveInvitation(invited.invitation.token)).toBeNull();
    expect(await findLivePasswordReset(memberLink)).toBeNull();
    expect(await findLiveInvitation(ownerInvite.invitation.token)).not.toBeNull();
  });
});

describe("role changes revoke the account's own reset links", () => {
  test("a member's link dies when it is promoted, so a demotion within the hour revives nothing", async () => {
    const link = await issue("owner", "member");
    expect(await changeAccountRole(ids.owner, ids.member, "admin")).toEqual({ ok: true });
    expect(await changeAccountRole(ids.owner, ids.member, "member")).toEqual({
      ok: true,
    });
    await expectDead(link, ids.member);
  });

  test("an ownership transfer revokes the new owner's own links, whoever issued them", async () => {
    /** A stray link for admin B issued by admin2 (inserted directly: no rule allows it). */
    const stray = await insertReset({ userId: ids.admin, issuedBy: ids.admin2 });
    expect(await transferOwnership(ids.owner, ids.admin, OLD_PASSWORD, NO_LIMIT)).toEqual(
      {
        ok: true,
      },
    );
    const [row] = await db
      .select({ revokedAt: userTokens.revokedAt })
      .from(userTokens)
      .where(eq(userTokens.tokenHash, hashToken(stray)));
    expect(row?.revokedAt).not.toBeNull();
  });
});
