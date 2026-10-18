/**
 * Account management (#218) against real Postgres: the full rule matrix
 * for role change, deactivate, reactivate, remove and ownership transfer,
 * by the owner, an admin and a member (service calls and crafted HTTP),
 * including self-targeting and owner-targeting refusals; the side effects
 * (sessions and invitations revoked in the same transaction, FK cascades
 * on removal); the single owner holding through a transfer and through
 * two racing transfers; the live role applying on the next request; the
 * log lines; and the sidebar hiding admin-only links from members.
 */
import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import { Elysia } from "elysia";
import { and, eq, isNull } from "drizzle-orm";
import { db, seed, sessions, truncateAll } from "./_helpers.ts";
import { pagesPlugin } from "../../src/pages/pages.plugin.tsx";
import { withRequestContext } from "../../src/middleware/request-context.ts";
import { users } from "../../src/modules/users/models/user.schema.ts";
import { userCredentials } from "../../src/modules/users/models/user-credential.schema.ts";
import { userTokens } from "../../src/modules/users/models/user-token.schema.ts";
import {
  changeAccountRole,
  deactivateAccount,
  listAccounts,
  reactivateAccount,
  removeAccount,
  transferOwnership,
} from "../../src/modules/users/services/user-admin.service.ts";
import { findActiveSession } from "../../src/modules/users/services/session.service.ts";
import { mintToken } from "../../src/modules/users/services/token.service.ts";
import { generateId } from "../../src/utils/id.ts";
import { logger } from "../../src/utils/logger.ts";
import { redactEmail } from "../../src/utils/redact.ts";
import type {
  AccountActionResult,
  AccountRefusal,
  AttemptLimiter,
  UserRole,
} from "../../src/modules/users/types/user.types.ts";
import { loginAttemptMap } from "../../src/middleware/login-rate-limit.ts";
import { hashPassword } from "../../src/modules/users/services/password.service.ts";
import {
  findLiveOwnerSetup,
  issueOwnerSetupLink,
} from "../../src/modules/users/services/owner.service.ts";
import { config } from "../../src/config.ts";

/** The app as `src/index.ts` mounts it: with the per-request context (#284). */
const app = new Elysia().wrap(withRequestContext).use(pagesPlugin);

const PASSWORD = "correct horse battery staple";

/** The accounts seeded before every test, by name. */
type Name = "owner" | "admin" | "admin2" | "member" | "member2";
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
const NAMES: Name[] = ["owner", "admin", "admin2", "member", "member2"];
const ROLE_OF: Record<Name, UserRole> = {
  owner: "owner",
  admin: "admin",
  admin2: "admin",
  member: "member",
  member2: "member",
};

/** A transfer budget that never limits, for the service-level tests. */
const NO_LIMIT: AttemptLimiter = {
  isLimited: () => false,
  record: () => undefined,
  clear: () => undefined,
};

beforeEach(async () => {
  /** The transfer budget lives in the login limiter's map (#218). */
  loginAttemptMap.clear();
  await truncateAll();
  for (const name of NAMES) {
    const { id } = await seed.user({
      email: `${name}@example.com`,
      role: ROLE_OF[name],
      /** Only the owner needs a password: the transfer checks it. */
      ...(name === "owner" ? { password: PASSWORD } : {}),
    });
    ids[name] = id;
    tokens[name] = (await seed.session({ userId: id })).token;
  }
});

/* ─── Helpers ─── */

/** A same-origin request with a session cookie and an optional form body. */
function call(
  method: "GET" | "POST",
  path: string,
  token: string,
  body?: Record<string, string>,
): Promise<Response> {
  const headers: Record<string, string> = { cookie: `bm_session=${token}` };
  const url = `http://localhost${path}`;
  if (method === "GET") return app.handle(new Request(url, { headers }));
  headers["origin"] = "http://localhost";
  headers["content-type"] = "application/x-www-form-urlencoded";
  return app.handle(
    new Request(url, {
      method: "POST",
      headers,
      body: new URLSearchParams(body ?? {}).toString(),
    }),
  );
}

/** The stored role and status of an account, or `null` when it is gone. */
async function account(id: string): Promise<{ role: string; disabled: boolean } | null> {
  const [row] = await db
    .select({ role: users.role, disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, id));
  return row ? { role: row.role, disabled: row.disabledAt !== null } : null;
}

/** Ids of every account holding the owner role. */
async function owners(): Promise<string[]> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, "owner"));
  return rows.map((row) => row.id);
}

/** How many sessions an account has. */
async function sessionCount(userId: string): Promise<number> {
  return (
    await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId))
  ).length;
}

/** Inserts an open invitation issued by `invitedBy`; returns its id. */
async function insertInvite(
  invitedBy: string,
  role: "admin" | "member",
): Promise<string> {
  const id = generateId("utk");
  await db.insert(userTokens).values({
    id,
    email: `${id.toLowerCase()}@example.org`,
    purpose: "invite",
    role,
    invitedBy,
    tokenHash: mintToken().hash,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return id;
}

/** The ids among `inviteIds` that are still open (not revoked, not used). */
async function openInvites(inviteIds: string[]): Promise<string[]> {
  const rows = await db
    .select({ id: userTokens.id })
    .from(userTokens)
    .where(and(isNull(userTokens.revokedAt), isNull(userTokens.usedAt)));
  return rows.map((row) => row.id).filter((id) => inviteIds.includes(id));
}

/** Asserts a refusal with `reason`. */
function expectRefused(result: AccountActionResult, reason: AccountRefusal): void {
  expect(result).toEqual({ ok: false, reason });
}

/** A snapshot of every account's role and status, to prove a refusal changed nothing. */
async function snapshot(): Promise<string> {
  const rows = await db
    .select({ id: users.id, role: users.role, disabledAt: users.disabledAt })
    .from(users)
    .orderBy(users.id);
  const sessionRows = await db.select({ id: sessions.id }).from(sessions);
  return JSON.stringify({ rows, sessions: sessionRows.length });
}

/* ─── Role change ─── */

describe("Role change (#218)", () => {
  test("the owner makes a member an admin and an admin a member", async () => {
    expect(await changeAccountRole(ids.owner, ids.member, "admin")).toEqual({ ok: true });
    expect((await account(ids.member))?.role).toBe("admin");
    expect(await changeAccountRole(ids.owner, ids.admin, "member")).toEqual({ ok: true });
    expect((await account(ids.admin))?.role).toBe("member");
  });

  test("never to or from owner, never on oneself, and a no-op is refused", async () => {
    const before = await snapshot();
    expectRefused(await changeAccountRole(ids.owner, ids.admin, "owner"), "invalid_role");
    expectRefused(await changeAccountRole(ids.owner, ids.admin, "boss"), "invalid_role");
    expectRefused(await changeAccountRole(ids.owner, ids.owner, "admin"), "self");
    expectRefused(
      await changeAccountRole(ids.admin, ids.owner, "member"),
      "target_is_owner",
    );
    expectRefused(await changeAccountRole(ids.owner, ids.admin, "admin"), "unchanged");
    expect(await snapshot()).toBe(before);
  });

  test("an admin and a member cannot change any role", async () => {
    const before = await snapshot();
    expectRefused(
      await changeAccountRole(ids.admin, ids.member, "admin"),
      "role_not_allowed",
    );
    expectRefused(
      await changeAccountRole(ids.admin, ids.admin2, "member"),
      "role_not_allowed",
    );
    expectRefused(await changeAccountRole(ids.admin, ids.admin, "member"), "self");
    expectRefused(
      await changeAccountRole(ids.member, ids.member2, "admin"),
      "role_not_allowed",
    );
    expectRefused(await changeAccountRole(ids.member, ids.member, "admin"), "self");
    expect(await snapshot()).toBe(before);
  });

  test("demotion revokes the demoted admin's open invitations, and the next request sees the new role", async () => {
    const invite = await insertInvite(ids.admin, "member");
    const other = await insertInvite(ids.admin2, "member");
    expect((await call("GET", "/dashboard/users", tokens.admin)).status).toBe(200);

    const response = await call(
      "POST",
      `/dashboard/users/${ids.admin}/role`,
      tokens.owner,
      {
        role: "member",
      },
    );
    expect(response.status).toBe(302);
    expect(decodeURIComponent(response.headers.get("location") ?? "")).toContain(
      "Role changed to member.",
    );

    expect(await openInvites([invite, other])).toEqual([other]);
    const after = await call("GET", "/dashboard/users", tokens.admin);
    expect(after.status).toBe(403);
    /** Still signed in: demotion keeps the sessions. */
    expect(await sessionCount(ids.admin)).toBe(1);
  });

  test("an admin's crafted role change gets the 403 page", async () => {
    const response = await call(
      "POST",
      `/dashboard/users/${ids.member}/role`,
      tokens.admin,
      { role: "admin" },
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Your role cannot do this");
    expect((await account(ids.member))?.role).toBe("member");
  });
});

/* ─── Deactivate and reactivate ─── */

describe("Deactivate and reactivate (#218)", () => {
  test("the owner deactivates an admin: sessions and open invitations revoked, the cookie bounces", async () => {
    const invite = await insertInvite(ids.admin, "member");
    const response = await call(
      "POST",
      `/dashboard/users/${ids.admin}/deactivate`,
      tokens.owner,
    );
    expect(response.status).toBe(302);
    expect(await account(ids.admin)).toEqual({ role: "admin", disabled: true });
    expect(await sessionCount(ids.admin)).toBe(0);
    expect(await openInvites([invite])).toEqual([]);

    const bounced = await call("GET", "/dashboard", tokens.admin);
    expect(bounced.status).toBe(302);
    expect(bounced.headers.get("location")).toBe("/dashboard/login");
  });

  test("an admin deactivates and reactivates a member", async () => {
    expect(await deactivateAccount(ids.admin, ids.member)).toEqual({ ok: true });
    expect(await account(ids.member)).toEqual({ role: "member", disabled: true });
    expectRefused(await deactivateAccount(ids.admin, ids.member), "unchanged");
    expect(await reactivateAccount(ids.admin, ids.member)).toEqual({ ok: true });
    expect(await account(ids.member)).toEqual({ role: "member", disabled: false });
    expectRefused(await reactivateAccount(ids.admin, ids.member), "unchanged");
  });

  test("the owner reactivates a deactivated admin; an admin cannot", async () => {
    expect(await deactivateAccount(ids.owner, ids.admin2)).toEqual({ ok: true });
    expectRefused(await reactivateAccount(ids.admin, ids.admin2), "role_not_allowed");
    expect(await reactivateAccount(ids.owner, ids.admin2)).toEqual({ ok: true });
    expect((await account(ids.admin2))?.disabled).toBe(false);
  });

  test("refusals: admin on admin, member on anyone, anyone on self or the owner", async () => {
    const before = await snapshot();
    expectRefused(await deactivateAccount(ids.admin, ids.admin2), "role_not_allowed");
    expectRefused(await deactivateAccount(ids.member, ids.member2), "role_not_allowed");
    expectRefused(await deactivateAccount(ids.member, ids.admin), "role_not_allowed");
    expectRefused(await deactivateAccount(ids.owner, ids.owner), "self");
    expectRefused(await deactivateAccount(ids.admin, ids.admin), "self");
    expectRefused(await deactivateAccount(ids.admin, ids.owner), "target_is_owner");
    expectRefused(await reactivateAccount(ids.admin, ids.owner), "target_is_owner");
    expectRefused(await deactivateAccount(ids.owner, "usr_missing"), "not_found");
    expect(await snapshot()).toBe(before);
  });

  test("reactivation deletes every session, so one a racing login created never comes back", async () => {
    expect(await deactivateAccount(ids.owner, ids.admin)).toEqual({ ok: true });
    /** A login that passed its checks before the deactivation committed. */
    const raced = await seed.session({ userId: ids.admin });
    expect(await sessionCount(ids.admin)).toBe(1);
    expect(await reactivateAccount(ids.owner, ids.admin)).toEqual({ ok: true });
    expect(await sessionCount(ids.admin)).toBe(0);
    expect(await findActiveSession(raced.token)).toBeNull();
  });

  test("a deactivated actor can no longer act", async () => {
    expect(await deactivateAccount(ids.owner, ids.admin)).toEqual({ ok: true });
    expectRefused(await deactivateAccount(ids.admin, ids.member), "actor_inactive");
    expect((await account(ids.member))?.disabled).toBe(false);
  });

  test("an owner's self-deactivation over HTTP gets the 403 page", async () => {
    const response = await call(
      "POST",
      `/dashboard/users/${ids.owner}/deactivate`,
      tokens.owner,
    );
    expect(response.status).toBe(403);
    expect((await account(ids.owner))?.disabled).toBe(false);
  });

  test("two admins deactivating the same member at once: one applies, one is a no-op", async () => {
    const results = await Promise.all([
      deactivateAccount(ids.admin, ids.member),
      deactivateAccount(ids.admin2, ids.member),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "unchanged" }]);
    expect((await account(ids.member))?.disabled).toBe(true);
  });

  test("the owner demoting an admin while that admin deactivates a member never lets a member act", async () => {
    const [demotion, deactivation] = await Promise.all([
      changeAccountRole(ids.owner, ids.admin, "member"),
      deactivateAccount(ids.admin, ids.member),
    ]);
    expect(demotion).toEqual({ ok: true });
    /** Serialized by the owner lock: the deactivation ran before the demotion, or was refused after it. */
    const disabled = (await account(ids.member))?.disabled;
    if (deactivation.ok) expect(disabled).toBe(true);
    else {
      expectRefused(deactivation, "role_not_allowed");
      expect(disabled).toBe(false);
    }
  });
});

/* ─── Remove ─── */

describe("Remove (#218)", () => {
  test("the owner removes an admin: row, sessions and credentials gone, past invitations kept without inviter", async () => {
    const open = await insertInvite(ids.admin, "member");
    await db
      .update(userTokens)
      .set({ usedAt: new Date() })
      .where(eq(userTokens.id, await insertInvite(ids.admin, "member")));
    await db.insert(userCredentials).values({
      id: generateId("crd"),
      userId: ids.admin,
      type: "password",
      secretHash: "$argon2id$placeholder",
    });

    const response = await call(
      "POST",
      `/dashboard/users/${ids.admin}/remove`,
      tokens.owner,
      {
        confirm: "  ADMIN@Example.com ",
      },
    );
    expect(response.status).toBe(302);
    expect(decodeURIComponent(response.headers.get("location") ?? "")).toContain(
      "Account removed.",
    );

    expect(await account(ids.admin)).toBeNull();
    expect(await sessionCount(ids.admin)).toBe(0);
    const credentials = await db
      .select({ id: userCredentials.id })
      .from(userCredentials)
      .where(eq(userCredentials.userId, ids.admin));
    expect(credentials).toEqual([]);
    const invites = await db
      .select({
        id: userTokens.id,
        invitedBy: userTokens.invitedBy,
        revokedAt: userTokens.revokedAt,
      })
      .from(userTokens)
      .where(eq(userTokens.purpose, "invite"));
    expect(invites).toHaveLength(2);
    expect(invites.every((row) => row.invitedBy === null)).toBe(true);
    expect(invites.find((row) => row.id === open)?.revokedAt).not.toBeNull();

    const bounced = await call("GET", "/dashboard", tokens.admin);
    expect(bounced.status).toBe(302);
  });

  test("a wrong confirmation changes nothing", async () => {
    const before = await snapshot();
    const response = await call(
      "POST",
      `/dashboard/users/${ids.member}/remove`,
      tokens.owner,
      { confirm: "member@example.org" },
    );
    expect(response.status).toBe(302);
    expect(decodeURIComponent(response.headers.get("location") ?? "")).toContain(
      "flashType=error",
    );
    expect(await snapshot()).toBe(before);
  });

  test("an admin removes a member, not an admin; nobody removes the owner or themselves", async () => {
    expect(await removeAccount(ids.admin, ids.member, "member@example.com")).toEqual({
      ok: true,
    });
    expect(await account(ids.member)).toBeNull();

    const before = await snapshot();
    expectRefused(
      await removeAccount(ids.admin, ids.admin2, "admin2@example.com"),
      "role_not_allowed",
    );
    expectRefused(
      await removeAccount(ids.member2, ids.admin, "admin@example.com"),
      "role_not_allowed",
    );
    expectRefused(
      await removeAccount(ids.admin, ids.owner, "owner@example.com"),
      "target_is_owner",
    );
    expectRefused(await removeAccount(ids.owner, ids.owner, "owner@example.com"), "self");
    expectRefused(await removeAccount(ids.admin, ids.admin, "admin@example.com"), "self");
    expect(await snapshot()).toBe(before);
  });
});

/* ─── Ownership transfer ─── */

describe("Ownership transfer (#218)", () => {
  test("the owner hands ownership to an admin: exactly one owner, both signed in, admin invitations revoked, member ones kept", async () => {
    const adminInvite = await insertInvite(ids.owner, "admin");
    const memberInvite = await insertInvite(ids.owner, "member");

    const response = await call(
      "POST",
      `/dashboard/users/${ids.admin}/transfer`,
      tokens.owner,
      {
        password: PASSWORD,
      },
    );
    expect(response.status).toBe(302);
    expect(decodeURIComponent(response.headers.get("location") ?? "")).toContain(
      "Ownership transferred.",
    );

    expect(await owners()).toEqual([ids.admin]);
    expect((await account(ids.owner))?.role).toBe("admin");
    expect(await openInvites([adminInvite, memberInvite])).toEqual([memberInvite]);

    expect((await findActiveSession(tokens.owner))?.role).toBe("admin");
    expect((await findActiveSession(tokens.admin))?.role).toBe("owner");
    /** The former owner can no longer change roles. */
    expectRefused(
      await changeAccountRole(ids.owner, ids.member, "admin"),
      "role_not_allowed",
    );
  });

  test("a wrong password changes nothing and logs a warning without the password", async () => {
    const warn = spyOn(logger, "warn");
    warn.mockClear();
    try {
      const before = await snapshot();
      const response = await call(
        "POST",
        `/dashboard/users/${ids.admin}/transfer`,
        tokens.owner,
        { password: "not the owner password" },
      );
      expect(response.status).toBe(302);
      expect(decodeURIComponent(response.headers.get("location") ?? "")).toContain(
        "Wrong password",
      );
      expect(await snapshot()).toBe(before);
      expect(await owners()).toEqual([ids.owner]);

      const lines = warn.mock.calls.filter(
        ([message]) => message === "Account action refused",
      );
      expect(lines).toHaveLength(1);
      expect(lines[0]?.[1]).toMatchObject({
        action: "transfer_ownership",
        actorId: ids.owner,
        targetUserId: ids.admin,
        reason: "wrong_password",
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("not the owner password");
    } finally {
      warn.mockRestore();
    }
  });

  test("to a member, a disabled admin, oneself, or by an admin: refused", async () => {
    await db
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.id, ids.admin2));
    const before = await snapshot();
    expectRefused(
      await transferOwnership(ids.owner, ids.member, PASSWORD, NO_LIMIT),
      "not_eligible",
    );
    expectRefused(
      await transferOwnership(ids.owner, ids.admin2, PASSWORD, NO_LIMIT),
      "not_eligible",
    );
    expectRefused(
      await transferOwnership(ids.owner, ids.owner, PASSWORD, NO_LIMIT),
      "self",
    );
    expectRefused(
      await transferOwnership(ids.admin, ids.admin, PASSWORD, NO_LIMIT),
      "self",
    );
    expectRefused(
      await transferOwnership(ids.admin, ids.owner, PASSWORD, NO_LIMIT),
      "target_is_owner",
    );
    expectRefused(
      await transferOwnership(ids.member, ids.admin, PASSWORD, NO_LIMIT),
      "role_not_allowed",
    );
    expect(await snapshot()).toBe(before);
    expect(await owners()).toEqual([ids.owner]);
  });

  test("two transfers racing leave exactly one owner", async () => {
    const results = await Promise.all([
      transferOwnership(ids.owner, ids.admin, PASSWORD, NO_LIMIT),
      transferOwnership(ids.owner, ids.admin2, PASSWORD, NO_LIMIT),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([
      { ok: false, reason: "role_not_allowed" },
    ]);
    const holders = await owners();
    expect(holders).toHaveLength(1);
    expect([ids.admin, ids.admin2]).toContain(holders[0] ?? "");
    expect((await account(ids.owner))?.role).toBe("admin");
  });
});

/* ─── Transfer: setup links and the password budget ─── */

describe("Ownership transfer hardening (#218)", () => {
  /** The configured budget: the login limiter's settings. */
  const { maxAttempts } = config.dashboard.loginRateLimit;

  /** POSTs a transfer from the owner's session to the admin. */
  function postTransfer(password: string): Promise<Response> {
    return call("POST", `/dashboard/users/${ids.admin}/transfer`, tokens.owner, {
      password,
    });
  }

  /** The flash a transfer response redirects with. */
  function flashOf(response: Response): string {
    return decodeURIComponent(response.headers.get("location") ?? "");
  }

  test("the limiter is on in the test environment", () => {
    expect(config.dashboard.loginRateLimit.enabled).toBe(true);
    expect(maxAttempts).toBeGreaterThan(1);
  });

  test("a transfer revokes every open owner setup link: one minted for the old owner never comes back", async () => {
    await db.insert(userCredentials).values({
      id: generateId("crd"),
      userId: ids.admin,
      type: "password",
      secretHash: await hashPassword(PASSWORD),
    });
    /** `reset-owner` for owner A: a live link, the password kept. */
    const link = await issueOwnerSetupLink(null);
    expect(await findLiveOwnerSetup(link.token)).not.toBeNull();

    expect(await transferOwnership(ids.owner, ids.admin, PASSWORD, NO_LIMIT)).toEqual({
      ok: true,
    });
    expect(await transferOwnership(ids.admin, ids.owner, PASSWORD, NO_LIMIT)).toEqual({
      ok: true,
    });
    expect(await owners()).toEqual([ids.owner]);
    expect(await findLiveOwnerSetup(link.token)).toBeNull();
  });

  test("after the budget of wrong passwords the next try never reaches argon2id and changes nothing", async () => {
    const verify = spyOn(Bun.password, "verify");
    verify.mockClear();
    const warn = spyOn(logger, "warn");
    warn.mockClear();
    try {
      const before = await snapshot();
      for (let i = 0; i < maxAttempts; i += 1) {
        expect(flashOf(await postTransfer("not the owner password"))).toContain(
          "Wrong password",
        );
      }
      expect(verify).toHaveBeenCalledTimes(maxAttempts);

      /** Over budget: refused before any verify, even with the right password. */
      const limited = await postTransfer(PASSWORD);
      expect(limited.status).toBe(302);
      expect(flashOf(limited)).toContain("Too many failed attempts, try again later.");
      expect(flashOf(limited)).toContain("flashType=error");
      expect(verify).toHaveBeenCalledTimes(maxAttempts);
      expect(await snapshot()).toBe(before);
      expect(await owners()).toEqual([ids.owner]);

      const refused = warn.mock.calls.filter(
        ([message, data]) =>
          message === "Account action refused" &&
          JSON.stringify(data).includes('"reason":"rate_limited"'),
      );
      expect(refused).toHaveLength(1);
    } finally {
      verify.mockRestore();
      warn.mockRestore();
    }
  });

  test("a parallel burst of wrong passwords runs at most the budget of verifies", async () => {
    const verify = spyOn(Bun.password, "verify");
    verify.mockClear();
    try {
      const responses = await Promise.all(
        Array.from({ length: maxAttempts * 3 }, () =>
          postTransfer("wrong guess, long one"),
        ),
      );
      const flashes = responses.map(flashOf);
      expect(flashes.filter((f) => f.includes("Wrong password"))).toHaveLength(
        maxAttempts,
      );
      expect(flashes.filter((f) => f.includes("Too many failed attempts"))).toHaveLength(
        maxAttempts * 2,
      );
      expect(verify).toHaveBeenCalledTimes(maxAttempts);
      expect(await owners()).toEqual([ids.owner]);
    } finally {
      verify.mockRestore();
    }
  });

  test("a completed transfer clears the budget of the actor and the address", async () => {
    for (let i = 0; i < maxAttempts - 1; i += 1) {
      expect(flashOf(await postTransfer("not the owner password"))).toContain(
        "Wrong password",
      );
    }
    const transferKeys = (): string[] =>
      [...loginAttemptMap.keys()].filter((key) => key.startsWith("transfer:"));
    expect(transferKeys().toSorted()).toEqual([
      "transfer:ip:unknown",
      `transfer:user:${ids.owner}`,
    ]);

    expect(flashOf(await postTransfer(PASSWORD))).toContain("Ownership transferred.");
    expect(transferKeys()).toEqual([]);
    expect(await owners()).toEqual([ids.admin]);
  });
});

/* ─── Crafted requests by a member ─── */

describe("A member's crafted requests (#218)", () => {
  test("every Users route answers 403 and nothing changes", async () => {
    const before = await snapshot();
    expect((await call("GET", "/dashboard/users", tokens.member)).status).toBe(403);
    const attempts: Array<[string, Record<string, string>]> = [
      [`/dashboard/users/${ids.member2}/role`, { role: "admin" }],
      [`/dashboard/users/${ids.member}/role`, { role: "admin" }],
      [`/dashboard/users/${ids.member2}/deactivate`, {}],
      [`/dashboard/users/${ids.owner}/deactivate`, {}],
      [`/dashboard/users/${ids.member2}/reactivate`, {}],
      [`/dashboard/users/${ids.member2}/remove`, { confirm: "member2@example.com" }],
      [`/dashboard/users/${ids.admin}/transfer`, { password: PASSWORD }],
    ];
    for (const [path, body] of attempts) {
      expect((await call("POST", path, tokens.member, body)).status).toBe(403);
    }
    expect(await snapshot()).toBe(before);
  });
});

/* ─── Logging ─── */

describe("Account action log lines (#218)", () => {
  test("an applied action logs actor, target, action and the old and new status; emails only redacted", async () => {
    const info = spyOn(logger, "info");
    info.mockClear();
    try {
      expect(await deactivateAccount(ids.owner, ids.admin)).toEqual({ ok: true });
      expect(await removeAccount(ids.owner, ids.member, "member@example.com")).toEqual({
        ok: true,
      });
      const deactivated = info.mock.calls.find(([m]) => m === "Account deactivated");
      expect(deactivated?.[1]).toEqual({
        action: "deactivate",
        actorId: ids.owner,
        actorRole: "owner",
        targetUserId: ids.admin,
        oldStatus: "active",
        newStatus: "disabled",
        sessionsRevoked: 1,
        invitesRevoked: 0,
        resetLinksRevoked: 0,
        keysDisabled: 0,
      });
      const removed = info.mock.calls.find(([m]) => m === "Account removed");
      expect(removed?.[1]).toMatchObject({
        action: "remove",
        targetUserId: ids.member,
        oldRole: "member",
        newStatus: "removed",
      });
      /** Through `redactEmail`, which redacts when LOG_REDACT_PII is on. */
      expect(removed?.[1]).toMatchObject({ email: redactEmail("member@example.com") });
      expect(JSON.stringify(info.mock.calls)).not.toContain("admin@example.com");
    } finally {
      info.mockRestore();
    }
  });

  test("a role change logs the old and new role", async () => {
    const info = spyOn(logger, "info");
    info.mockClear();
    try {
      await changeAccountRole(ids.owner, ids.member, "admin");
      const line = info.mock.calls.find(([m]) => m === "Account role changed");
      expect(line?.[1]).toMatchObject({
        action: "change_role",
        targetUserId: ids.member,
        oldRole: "member",
        newRole: "admin",
      });
    } finally {
      info.mockRestore();
    }
  });
});

/* ─── Users page and sidebar ─── */

describe("Users page and sidebar (#218)", () => {
  test("the list has every account with its role and status", async () => {
    await db
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.id, ids.member2));
    const accounts = await listAccounts();
    expect(accounts.map((a) => a.id).toSorted()).toEqual(Object.values(ids).toSorted());
    expect(accounts.find((a) => a.id === ids.member2)?.disabled).toBe(true);

    const html = await (await call("GET", "/dashboard/users", tokens.owner)).text();
    expect(html).toContain("member2@example.com");
    expect(html).toContain(`action="/dashboard/users/${ids.member2}/reactivate"`);
    expect(html).toContain(`action="/dashboard/users/${ids.admin}/transfer"`);
  });

  test("a member's pages have no link to an admin-only page; an admin's have them", async () => {
    const memberHome = await (await call("GET", "/dashboard", tokens.member)).text();
    expect(memberHome).toContain('href="/dashboard/emails"');
    /** API keys are a member page since #219 (a member's own keys). */
    expect(memberHome).toContain('href="/dashboard/api-keys"');
    for (const href of ["/dashboard/users", "/dashboard/invitations"]) {
      expect(memberHome).not.toContain(`href="${href}"`);
    }
    const adminHome = await (await call("GET", "/dashboard", tokens.admin)).text();
    for (const href of [
      "/dashboard/api-keys",
      "/dashboard/users",
      "/dashboard/invitations",
    ]) {
      expect(adminHome).toContain(`href="${href}"`);
    }
  });

  test("after a demotion the next page has no admin links", async () => {
    await changeAccountRole(ids.owner, ids.admin, "member");
    const html = await (await call("GET", "/dashboard/emails", tokens.admin)).text();
    expect(html).not.toContain('href="/dashboard/invitations"');
    expect(html).not.toContain('href="/dashboard/users"');
  });
});
