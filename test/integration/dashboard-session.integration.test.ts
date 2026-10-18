/**
 * Dashboard account login and server-side sessions (#216) against real
 * Postgres, through the real `pagesPlugin` over HTTP (no mocks): email and
 * password login, hashed opaque tokens, logout revocation, expiry on the
 * database clock, token rotation with its grace period, reuse detection,
 * disabled users and pending sessions, and the expired-session sweep.
 *
 * `app.handle` has no socket and the default trusted-proxy-hop count is 0,
 * so every request shares the `unknown` client-IP bucket of the login
 * limiter; `loginAttemptMap` is cleared before each test.
 */
import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import { Elysia } from "elysia";
import { eq, sql } from "drizzle-orm";
import { db, seed, sessions, truncateAll } from "./_helpers.ts";
import { pagesPlugin } from "../../src/pages/pages.plugin.tsx";
import { loginAttemptMap } from "../../src/middleware/login-rate-limit.ts";
import { userCredentials } from "../../src/modules/users/models/user-credential.schema.ts";
import { sessionTokenHistory } from "../../src/modules/users/models/session-token-history.schema.ts";
import {
  createSession,
  purgeExpiredSessions,
  revokeAllUserSessions,
  rotateSession,
} from "../../src/modules/users/services/session.service.ts";
import { hashToken } from "../../src/modules/users/services/token.service.ts";
import { logger } from "../../src/utils/logger.ts";

const app = new Elysia().use(pagesPlugin);

const OWNER_EMAIL = "owner@example.com";
const PASSWORD = "correct horse battery staple";

beforeEach(async () => {
  await truncateAll();
  loginAttemptMap.clear();
});

/* ─── Helpers ─── */

/** Form-POSTs a same-origin login. */
function login(
  email: string,
  password: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.handle(
    new Request("http://localhost/dashboard/login", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "http://localhost",
        ...headers,
      },
      body: new URLSearchParams({ email, password }).toString(),
    }),
  );
}

/** GET `path` with `bm_session=<token>`. */
function visit(token: string, path: string = "/dashboard/api-keys"): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      headers: { cookie: `bm_session=${token}` },
    }),
  );
}

/** The `bm_session` value a response sets, or null when it sets none. */
function cookieValue(response: Response): string | null {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) return null;
  return setCookie.match(/bm_session=([^;]*)/)?.[1] ?? null;
}

/** The `Max-Age` a response's cookie carries, or null. */
function cookieMaxAge(response: Response): number | null {
  const match = response.headers.get("set-cookie")?.match(/Max-Age=(\d+)/);
  return match?.[1] ? Number(match[1]) : null;
}

/** Every session row, with the timing columns as epoch seconds (DB clock). */
async function sessionRows(): Promise<
  Array<{
    id: string;
    userId: string;
    tokenHash: string;
    previousTokenHash: string | null;
    assurance: string;
    authMethod: string;
    ip: string | null;
    userAgent: string | null;
    rotated: boolean;
    expiresIn: number;
    lastSeenAgo: number;
    capIn: number;
  }>
> {
  return db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      tokenHash: sessions.tokenHash,
      previousTokenHash: sessions.previousTokenHash,
      assurance: sessions.assurance,
      authMethod: sessions.authMethod,
      ip: sessions.ip,
      userAgent: sessions.userAgent,
      rotated: sql<boolean>`${sessions.rotatedAt} IS NOT NULL`,
      expiresIn: sql<number>`extract(epoch from (${sessions.expiresAt} - now()))::float8`,
      lastSeenAgo: sql<number>`extract(epoch from (now() - ${sessions.lastSeenAt}))::float8`,
      capIn: sql<number>`extract(epoch from (${sessions.createdAt} + interval '7 days' - ${sessions.expiresAt}))::float8`,
    })
    .from(sessions);
}

/** The session row with the given id. */
async function sessionRow(
  id: string,
): Promise<Awaited<ReturnType<typeof sessionRows>>[number] | undefined> {
  return (await sessionRows()).find((r) => r.id === id);
}

/** Seeds the owner with a password and signs in; returns the cookie token. */
async function ownerSession(): Promise<{ userId: string; token: string }> {
  const { id } = await seed.owner({ email: OWNER_EMAIL, password: PASSWORD });
  const response = await login(OWNER_EMAIL, PASSWORD);
  expect(response.status).toBe(302);
  return { userId: id, token: cookieValue(response) ?? "" };
}

/* ─── Login ─── */

describe("login", () => {
  test("a seeded owner signs in; only the token hash is stored", async () => {
    const { id } = await seed.owner({ email: OWNER_EMAIL, password: PASSWORD });
    const userAgent = `agent/${"x".repeat(400)}`;
    const response = await login(" Owner@Example.com ", PASSWORD, {
      "user-agent": userAgent,
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/dashboard");
    const token = cookieValue(response) ?? "";
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookieMaxAge(response)).toBe(7 * 24 * 60 * 60);

    const rows = await sessionRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.userId).toBe(id);
    expect(row?.tokenHash).toBe(hashToken(token));
    expect(row?.tokenHash).not.toBe(token);
    expect(row?.previousTokenHash).toBeNull();
    expect(row?.rotated).toBe(false);
    expect(row?.assurance).toBe("password");
    expect(row?.authMethod).toBe("password");
    /** No socket: the resolved IP is "unknown", which is stored as null. */
    expect(row?.ip).toBeNull();
    expect(row?.userAgent).toHaveLength(255);
    /** Idle expiry, 24h out on the database clock. */
    expect(Math.abs((row?.expiresIn ?? 0) - 24 * 60 * 60)).toBeLessThan(10);

    expect((await visit(token)).status).toBe(200);
  });

  test("a successful login updates the credential's last_used_at", async () => {
    const { id } = await seed.owner({ email: OWNER_EMAIL, password: PASSWORD });
    await login(OWNER_EMAIL, PASSWORD);
    const [credential] = await db
      .select({ lastUsedAt: userCredentials.lastUsedAt })
      .from(userCredentials)
      .where(eq(userCredentials.userId, id));
    expect(credential?.lastUsedAt).not.toBeNull();
  });

  test("two logins give distinct cookies and rows", async () => {
    await seed.owner({ email: OWNER_EMAIL, password: PASSWORD });
    const first = cookieValue(await login(OWNER_EMAIL, PASSWORD));
    const second = cookieValue(await login(OWNER_EMAIL, PASSWORD));
    expect(first).not.toBe(second);
    const hashes = (await sessionRows()).map((r) => r.tokenHash).toSorted();
    expect(hashes).toEqual([hashToken(first ?? ""), hashToken(second ?? "")].toSorted());
  });

  test("a login from a browser with a session replaces that session", async () => {
    const { token } = await ownerSession();
    const again = await login(OWNER_EMAIL, PASSWORD, { cookie: `bm_session=${token}` });
    const fresh = cookieValue(again) ?? "";
    const rows = await sessionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).toBe(hashToken(fresh));
    expect((await visit(token)).status).toBe(302);
  });

  test("every failure branch runs exactly one argon2id verify and gets the same answer", async () => {
    await seed.owner({ email: OWNER_EMAIL, password: PASSWORD });
    await seed.user({ email: "nopass@example.com", role: "admin" });
    await seed.user({
      email: "disabled@example.com",
      role: "member",
      password: PASSWORD,
      disabledAt: new Date(),
    });

    const verify = spyOn(Bun.password, "verify");
    try {
      const cases: Array<[string, string]> = [
        ["nobody@example.com", PASSWORD],
        ["nopass@example.com", PASSWORD],
        ["disabled@example.com", PASSWORD],
        [OWNER_EMAIL, "a wrong password, long"],
      ];
      const bodies: string[] = [];
      for (const [email, password] of cases) {
        loginAttemptMap.clear();
        verify.mockClear();
        const response = await login(email, password);
        expect({ email, verifies: verify.mock.calls.length }).toEqual({
          email,
          verifies: 1,
        });
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("/dashboard/login?error=invalid");
        expect(response.headers.get("set-cookie")).toBeNull();
        bodies.push(await response.text());
      }
      expect(new Set(bodies).size).toBe(1);
      expect(await sessionRows()).toHaveLength(0);
    } finally {
      verify.mockRestore();
    }
  });
});

/* ─── Logout ─── */

describe("logout", () => {
  test("deletes the row; the replayed cookie gets a 302", async () => {
    const { token } = await ownerSession();
    const response = await app.handle(
      new Request("http://localhost/dashboard/logout", {
        method: "POST",
        headers: { origin: "http://localhost", cookie: `bm_session=${token}` },
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await sessionRows()).toHaveLength(0);

    const replay = await visit(token);
    expect(replay.status).toBe(302);
    expect(replay.headers.get("location")).toBe("/dashboard/login");
  });
});

/* ─── Guard ─── */

describe("guard", () => {
  test("an expired row is rejected and its cookie cleared", async () => {
    const { id } = await seed.owner({ email: OWNER_EMAIL, password: PASSWORD });
    const { token } = await seed.session({
      userId: id,
      expiresAt: sql`now() - interval '1 second'`,
    });
    const response = await visit(token);
    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  test("a disabled user's live session is rejected, and their login fails", async () => {
    const { id } = await seed.user({
      email: "member@example.com",
      password: PASSWORD,
    });
    const { token } = await seed.session({ userId: id });
    expect((await visit(token)).status).toBe(200);

    await db.execute(sql`UPDATE users SET disabled_at = now() WHERE id = ${id}`);
    expect((await visit(token)).status).toBe(302);

    const response = await login("member@example.com", PASSWORD);
    expect(response.headers.get("location")).toBe("/dashboard/login?error=invalid");
  });

  test("a pending session never opens a protected page", async () => {
    const { id } = await seed.owner({ email: OWNER_EMAIL });
    const { token } = await seed.session({ userId: id, assurance: "pending" });
    expect((await visit(token)).status).toBe(302);
  });

  test("a tampered token is rejected", async () => {
    const { token } = await ownerSession();
    const last = token.slice(-1);
    const tampered = `${token.slice(0, -1)}${last === "A" ? "B" : "A"}`;
    expect((await visit(tampered)).status).toBe(302);
    expect((await visit(token)).status).toBe(200);
  });

  test("an old HMAC cookie is cleared without a lookup", async () => {
    const response = await visit(`${Math.floor(Date.now() / 1000)}.${"a".repeat(64)}`);
    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toContain("bm_session=;");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});

/* ─── Rotation ─── */

describe("rotation", () => {
  test("a fresh session is served without a write or a new cookie", async () => {
    const { id } = await seed.owner({ email: OWNER_EMAIL });
    const { id: sessionId, token } = await seed.session({ userId: id });
    const response = await visit(token);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    const row = await sessionRow(sessionId);
    expect(row?.rotated).toBe(false);
    expect(row?.tokenHash).toBe(hashToken(token));
  });

  test("after 60 s the token rotates; the row slides; the next request writes nothing", async () => {
    const { id } = await seed.owner({ email: OWNER_EMAIL });
    const { id: sessionId, token } = await seed.session({
      userId: id,
      createdAt: sql`now() - interval '2 minutes'`,
      lastSeenAt: sql`now() - interval '10 minutes'`,
      expiresAt: sql`now() + interval '1 hour'`,
    });

    const response = await visit(token);
    expect(response.status).toBe(200);
    const fresh = cookieValue(response) ?? "";
    expect(fresh).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fresh).not.toBe(token);
    /** The cookie lives until the absolute cap: 7 days minus the 2 minutes. */
    expect(
      Math.abs((cookieMaxAge(response) ?? 0) - (7 * 24 * 60 * 60 - 120)),
    ).toBeLessThan(10);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Path=/dashboard");

    const row = await sessionRow(sessionId);
    expect(row?.tokenHash).toBe(hashToken(fresh));
    expect(row?.previousTokenHash).toBe(hashToken(token));
    expect(row?.rotated).toBe(true);
    expect(row?.lastSeenAgo ?? 99).toBeLessThan(5);
    expect(Math.abs((row?.expiresIn ?? 0) - 24 * 60 * 60)).toBeLessThan(10);

    /** The new token is not due yet: no write, no cookie. */
    const next = await visit(fresh);
    expect(next.status).toBe(200);
    expect(next.headers.get("set-cookie")).toBeNull();
    expect((await sessionRow(sessionId))?.tokenHash).toBe(hashToken(fresh));
  });

  test("the previous token inside the grace period is served, no write", async () => {
    const { id } = await seed.owner({ email: OWNER_EMAIL });
    const { id: sessionId, token } = await seed.session({
      userId: id,
      createdAt: sql`now() - interval '2 minutes'`,
    });
    const fresh = cookieValue(await visit(token)) ?? "";

    const late = await visit(token);
    expect(late.status).toBe(200);
    expect(late.headers.get("set-cookie")).toBeNull();
    const row = await sessionRow(sessionId);
    expect(row?.tokenHash).toBe(hashToken(fresh));
    expect(row?.previousTokenHash).toBe(hashToken(token));
  });

  test("the absolute cap bounds expires_at at created_at + 7 days", async () => {
    const { id } = await seed.owner({ email: OWNER_EMAIL });
    const { id: sessionId, token } = await seed.session({
      userId: id,
      createdAt: sql`now() - interval '7 days' + interval '1 hour'`,
      expiresAt: sql`now() + interval '30 minutes'`,
    });
    const response = await visit(token);
    expect(response.status).toBe(200);
    expect(Math.abs((cookieMaxAge(response) ?? 0) - 3600)).toBeLessThan(10);

    const row = await sessionRow(sessionId);
    expect(Math.abs(row?.capIn ?? 99)).toBeLessThan(1);
    expect(Math.abs((row?.expiresIn ?? 0) - 3600)).toBeLessThan(10);
  });

  test("two concurrent requests with a due token rotate exactly once", async () => {
    const { id } = await seed.owner({ email: OWNER_EMAIL });
    const { id: sessionId, token } = await seed.session({
      userId: id,
      createdAt: sql`now() - interval '2 minutes'`,
    });

    const responses = await Promise.all([visit(token), visit(token), visit(token)]);
    for (const r of responses) expect(r.status).toBe(200);
    const issued = responses.map(cookieValue).filter((v) => v !== null);
    expect(issued).toHaveLength(1);

    const row = await sessionRow(sessionId);
    expect(row?.tokenHash).toBe(hashToken(issued[0] ?? ""));
    expect(row?.previousTokenHash).toBe(hashToken(token));
  });

  test("rotateSession races: one winner, the loser gets null", async () => {
    const { id } = await seed.owner({ email: OWNER_EMAIL });
    const { id: sessionId, token } = await seed.session({ userId: id });
    const results = await Promise.all([
      rotateSession(sessionId, token),
      rotateSession(sessionId, token),
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });
});

/* ─── Reuse detection ─── */

describe("reuse detection", () => {
  test("the previous token after the grace period revokes every session of the user", async () => {
    const { id } = await seed.owner({ email: OWNER_EMAIL });
    const other = await seed.user({ email: "member@example.com" });
    const stolen = "S".repeat(43);
    const { token: current } = await seed.session({
      userId: id,
      previousToken: stolen,
      rotatedAt: sql`now() - interval '31 seconds'`,
    });
    const { token: secondDevice } = await seed.session({ userId: id });
    const { token: bystander } = await seed.session({ userId: other.id });

    const warn = spyOn(logger, "warn");
    try {
      const response = await visit(stolen);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard/login");
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
      expect(warn).toHaveBeenCalledWith(
        "Session token reuse detected: all sessions of the user revoked",
        expect.objectContaining({
          userId: id,
          sessionId: expect.stringMatching(/^ses_/),
        }),
      );
    } finally {
      warn.mockRestore();
    }

    const left = await sessionRows();
    expect(left.map((r) => r.userId)).toEqual([other.id]);
    expect((await visit(current)).status).toBe(302);
    expect((await visit(secondDevice)).status).toBe(302);
    expect((await visit(bystander)).status).toBe(200);
  });

  /**
   * A thief who keeps a stolen session active rotates it every minute, so
   * the victim's copy falls two or more generations behind. The history
   * table still recognizes it as reuse.
   */
  test("a token two rotations old is still reuse: every session of the user is revoked", async () => {
    const { id } = await seed.owner({ email: OWNER_EMAIL });
    const other = await seed.user({ email: "member@example.com" });
    const { id: sessionId, token: t0 } = await seed.session({ userId: id });
    const r1 = await rotateSession(sessionId, t0);
    const r2 = await rotateSession(sessionId, r1?.token ?? "");
    expect(r2).not.toBeNull();
    const { token: secondDevice } = await seed.session({ userId: id });
    const { token: bystander } = await seed.session({ userId: other.id });

    const history = await db
      .select({ tokenHash: sessionTokenHistory.tokenHash })
      .from(sessionTokenHistory)
      .where(eq(sessionTokenHistory.sessionId, sessionId));
    expect(history.map((h) => h.tokenHash).toSorted()).toEqual(
      [hashToken(t0), hashToken(r1?.token ?? "")].toSorted(),
    );

    const warn = spyOn(logger, "warn");
    try {
      const response = await visit(t0);
      expect(response.status).toBe(302);
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
      expect(warn).toHaveBeenCalledWith(
        "Session token reuse detected: all sessions of the user revoked",
        expect.objectContaining({ userId: id, sessionId }),
      );
    } finally {
      warn.mockRestore();
    }

    expect((await sessionRows()).map((r) => r.userId)).toEqual([other.id]);
    expect((await visit(r2?.token ?? "")).status).toBe(302);
    expect((await visit(secondDevice)).status).toBe(302);
    expect((await visit(bystander)).status).toBe(200);
    /** The history went with the revoked sessions (ON DELETE CASCADE). */
    const remaining = await db
      .select({ sessionId: sessionTokenHistory.sessionId })
      .from(sessionTokenHistory)
      .where(eq(sessionTokenHistory.sessionId, sessionId));
    expect(remaining).toHaveLength(0);
  });

  test("the victim signing in again with a superseded cookie ends the thief's session", async () => {
    const { id } = await seed.owner({ email: OWNER_EMAIL, password: PASSWORD });
    const { id: sessionId, token: t0 } = await seed.session({ userId: id });
    const thief = await rotateSession(sessionId, t0);
    const thief2 = await rotateSession(sessionId, thief?.token ?? "");

    const response = await login(OWNER_EMAIL, PASSWORD, { cookie: `bm_session=${t0}` });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/dashboard");

    /** Only the fresh login session is left; the thief's is gone. */
    const rows = await sessionRows();
    expect(rows).toHaveLength(1);
    expect((await visit(thief2?.token ?? "")).status).toBe(302);
    expect((await visit(cookieValue(response) ?? "")).status).toBe(200);
  });

  test("a superseded token of an expired session raises no alarm", async () => {
    const { id } = await seed.owner({ email: OWNER_EMAIL });
    const { id: sessionId, token: t0 } = await seed.session({ userId: id });
    await rotateSession(sessionId, t0);
    await db.execute(
      sql`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = ${sessionId}`,
    );
    const { token: otherDevice } = await seed.session({ userId: id });

    expect((await visit(t0)).status).toBe(302);
    /** The other live session was not revoked. */
    expect((await visit(otherDevice)).status).toBe(200);
  });
});

/* ─── Service helpers ─── */

describe("service helpers", () => {
  test("purgeExpiredSessions deletes only expired rows", async () => {
    const { id } = await seed.owner({ email: OWNER_EMAIL });
    await seed.session({ userId: id, expiresAt: sql`now() - interval '1 minute'` });
    await seed.session({ userId: id, expiresAt: sql`now() - interval '3 days'` });
    const { id: live } = await seed.session({ userId: id });

    expect(await purgeExpiredSessions()).toBe(2);
    expect((await sessionRows()).map((r) => r.id)).toEqual([live]);
  });

  test("revokeAllUserSessions deletes only that user's rows", async () => {
    const { id } = await seed.owner({ email: OWNER_EMAIL });
    const other = await seed.user({ email: "member@example.com" });
    await seed.session({ userId: id });
    await seed.session({ userId: id });
    await seed.session({ userId: other.id });

    expect(await revokeAllUserSessions(id)).toBe(2);
    const left = await db
      .select({ userId: sessions.userId })
      .from(sessions)
      .where(eq(sessions.userId, other.id));
    expect(left).toHaveLength(1);
    expect(await sessionRows()).toHaveLength(1);
  });

  test("createSession stores a forged IP as null and a valid one as is", async () => {
    const { id } = await seed.owner({ email: OWNER_EMAIL });
    await createSession({
      userId: id,
      assurance: "password",
      authMethod: "password",
      ip: `${"9".repeat(60)}, 1.2.3.4`,
      userAgent: null,
    });
    await createSession({
      userId: id,
      assurance: "password",
      authMethod: "password",
      ip: "2001:db8::1",
      userAgent: "ua",
    });
    const ips = (await sessionRows()).map((r) => r.ip);
    expect(ips).toHaveLength(2);
    expect(ips).toContain("2001:db8::1");
    expect(ips).toContain(null);
  });
});
