/**
 * A signed-in user changing their own password (#279), through the real
 * `pagesPlugin` over HTTP against real Postgres: a wrong current password
 * changes nothing and runs exactly one argon2id verify; the policy (too
 * short, too long, mismatch, same as current, missing current) is
 * enforced server side before any argon2id work; a completed change signs
 * the account out everywhere (two sessions: the other one is gone) and
 * signs this browser back in with a new cookie bound to the new
 * credential; the old password stops working and the new one works; the
 * account's open reset links are revoked; the failed-attempt budget
 * (per account and per client IP, the login limiter's settings) refuses
 * before any argon2id work and holds against a parallel burst; a
 * cross-origin POST is refused; and a reset an admin completed between
 * the verify and the change wins over the change.
 */
import { describe, test, expect, afterEach, beforeEach, spyOn } from "bun:test";
import { Elysia } from "elysia";
import { and, eq } from "drizzle-orm";
import { db, seed, sessions, truncateAll } from "./_helpers.ts";
import { pagesPlugin } from "../../src/pages/pages.plugin.tsx";
import { readSessionCookie } from "../../src/pages/session.ts";
import { users } from "../../src/modules/users/models/user.schema.ts";
import { userCredentials } from "../../src/modules/users/models/user-credential.schema.ts";
import {
  completePasswordReset,
  findLivePasswordReset,
} from "../../src/modules/users/services/password-reset.service.ts";
import { issuePasswordReset } from "../../src/modules/users/services/user-admin.service.ts";
import { verifyPasswordLogin } from "../../src/modules/users/services/login.service.ts";
import { createSession } from "../../src/modules/users/services/session.service.ts";
import { hashToken } from "../../src/modules/users/services/token.service.ts";
import { loginAttemptMap } from "../../src/middleware/login-rate-limit.ts";
import { logger } from "../../src/utils/logger.ts";
import { config } from "../../src/config.ts";
import type { IssuePasswordResetResult } from "../../src/modules/users/types/user.types.ts";

const app = new Elysia().use(pagesPlugin);

const OLD_PASSWORD = "the old password, long enough";
const NEW_PASSWORD = "a brand new passphrase, long";
const WRONG_PASSWORD = "not the current password, no";

const PAGE = "/dashboard/account/password";
const SUCCESS = "Password changed. You were signed out on every other device.";

/** The configured budget: the login limiter's settings. */
const { maxAttempts } = config.dashboard.loginRateLimit;
const originalProxyHops = config.dashboard.trustedProxyHops;

/** The member changing its password, an admin (issues reset links) and a bystander. */
const ids = { member: "", admin: "", other: "" };
/** This browser's session (bound to the password, as a login opens it). */
let browser = { id: "", token: "" };
/** A second session of the member, on another device (bound to nothing). */
let device = { id: "", token: "" };
/** The bystander's session. */
let otherToken = "";

beforeEach(async () => {
  loginAttemptMap.clear();
  await truncateAll();
  for (const name of ["member", "admin", "other"] as const) {
    const { id } = await seed.user({
      email: `${name}@example.com`,
      role: name === "admin" ? "admin" : "member",
      password: OLD_PASSWORD,
    });
    ids[name] = id;
  }
  const credentialId = await passwordCredentialId(ids.member);
  const created = await createSession({
    userId: ids.member,
    assurance: "password",
    authMethod: "password",
    credentialId,
    ip: null,
    userAgent: null,
  });
  browser = { id: created.sessionId, token: created.token };
  device = await seed.session({ userId: ids.member });
  otherToken = (await seed.session({ userId: ids.other })).token;
});

afterEach(() => {
  expect(Reflect.set(config.dashboard, "trustedProxyHops", originalProxyHops)).toBe(true);
});

/* ─── Helpers ─── */

/** A request with a session cookie; same-origin unless overridden. */
function call(
  method: "GET" | "POST",
  path: string,
  opts: {
    token?: string;
    body?: Record<string, string>;
    origin?: string;
    forwardedFor?: string;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.token) headers["cookie"] = `bm_session=${opts.token}`;
  if (opts.forwardedFor) headers["x-forwarded-for"] = opts.forwardedFor;
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

/** Submits the change form from `token`'s browser. */
function postChange(
  current: string,
  password: string = NEW_PASSWORD,
  confirm: string = password,
  opts: { token?: string; origin?: string; forwardedFor?: string } = {},
): Promise<Response> {
  return call("POST", PAGE, {
    token: opts.token ?? browser.token,
    origin: opts.origin,
    forwardedFor: opts.forwardedFor,
    body: { current, password, confirm },
  });
}

/** The `user_credentials.id` of an account's password (throws when it has none). */
async function passwordCredentialId(userId: string): Promise<string> {
  const [row] = await db
    .select({ id: userCredentials.id })
    .from(userCredentials)
    .where(and(eq(userCredentials.userId, userId), eq(userCredentials.type, "password")));
  if (!row) throw new Error("no password credential");
  return row.id;
}

/** The account's password credential row (id and hash), for "nothing changed". */
async function credentialRow(userId: string): Promise<string> {
  const rows = await db
    .select({ id: userCredentials.id, hash: userCredentials.secretHash })
    .from(userCredentials)
    .where(eq(userCredentials.userId, userId));
  return JSON.stringify(rows);
}

/** Session ids of an account, sorted. */
async function sessionIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.userId, userId));
  return rows.map((row) => row.id).toSorted();
}

/** Everything a refused change must leave as it was. */
async function snapshot(): Promise<string> {
  return JSON.stringify({
    credential: await credentialRow(ids.member),
    sessions: await sessionIds(ids.member),
  });
}

/** Whether a session cookie still opens a protected page. */
async function cookieWorks(token: string): Promise<boolean> {
  const response = await call("GET", "/dashboard/api-keys", { token });
  return response.status === 200;
}

/** The `password:` keys the limiter holds, sorted. */
function budgetKeys(): string[] {
  return [...loginAttemptMap.keys()]
    .filter((key) => key.startsWith("password:"))
    .toSorted();
}

/** Asserts an issue succeeded and returns its raw token. */
function issuedToken(result: IssuePasswordResetResult): string {
  if (!result.ok) throw new Error(`expected a reset link, got ${result.reason}`);
  const token = new URL(result.url).searchParams.get("token");
  if (!token) throw new Error("the link carries no token");
  return token;
}

/* ─── The form ─── */

describe("GET /dashboard/account/password (#279)", () => {
  test("renders the form for the signed-in account, not cached", async () => {
    const response = await call("GET", PAGE, { token: browser.token });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain(`action="${PAGE}"`);
    expect(html).toContain("member@example.com");
    expect(html).toContain('name="current"');
  });

  test("no session: redirected to the login page", async () => {
    const response = await call("GET", PAGE);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/dashboard/login");
  });
});

/* ─── Refusals that change nothing ─── */

describe("a refused change changes nothing (#279)", () => {
  test("a wrong current password: generic error, exactly one verify, no hash, nothing changes", async () => {
    const before = await snapshot();
    const verify = spyOn(Bun.password, "verify");
    const hash = spyOn(Bun.password, "hash");
    const warn = spyOn(logger, "warn");
    verify.mockClear();
    hash.mockClear();
    warn.mockClear();
    try {
      const response = await postChange(WRONG_PASSWORD);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Current password is incorrect.");
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(verify).toHaveBeenCalledTimes(1);
      expect(hash).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith("Password change refused", {
        userId: ids.member,
        sessionId: browser.id,
        reason: "wrong_password",
        ip: "unknown",
      });
    } finally {
      verify.mockRestore();
      hash.mockRestore();
      warn.mockRestore();
    }
    expect(await snapshot()).toBe(before);
    expect(await cookieWorks(browser.token)).toBe(true);
    expect(await cookieWorks(device.token)).toBe(true);
    expect((await verifyPasswordLogin("member@example.com", OLD_PASSWORD)).ok).toBe(true);
    /** Counted against both keys, not given back. */
    expect(budgetKeys()).toEqual([`password:ip:unknown`, `password:user:${ids.member}`]);
  });

  test("the policy is enforced server side, before any argon2id work and without counting", async () => {
    const before = await snapshot();
    const verify = spyOn(Bun.password, "verify");
    const hash = spyOn(Bun.password, "hash");
    verify.mockClear();
    hash.mockClear();
    try {
      const long = "x".repeat(257);
      const cases: Array<[string, string, string, string]> = [
        ["", NEW_PASSWORD, NEW_PASSWORD, "Enter your current password."],
        [OLD_PASSWORD, "too short", "too short", "at least 15 characters"],
        [OLD_PASSWORD, long, long, "at most 256 characters"],
        [
          OLD_PASSWORD,
          NEW_PASSWORD,
          `${NEW_PASSWORD}!`,
          "The two passwords do not match.",
        ],
        [
          OLD_PASSWORD,
          OLD_PASSWORD,
          OLD_PASSWORD,
          "The new password must be different from the current one.",
        ],
      ];
      for (const [current, password, confirm, message] of cases) {
        const response = await postChange(current, password, confirm);
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain(message);
        /** No submitted value is ever written back into the page. */
        expect(html).not.toContain(OLD_PASSWORD);
        expect(html).not.toContain(NEW_PASSWORD);
      }
      expect(verify).not.toHaveBeenCalled();
      expect(hash).not.toHaveBeenCalled();
    } finally {
      verify.mockRestore();
      hash.mockRestore();
    }
    expect(await snapshot()).toBe(before);
    expect(budgetKeys()).toEqual([]);
  });

  test("a cross-origin POST is refused with 403 before any work", async () => {
    const before = await snapshot();
    const verify = spyOn(Bun.password, "verify");
    verify.mockClear();
    try {
      const response = await postChange(OLD_PASSWORD, NEW_PASSWORD, NEW_PASSWORD, {
        origin: "https://evil.example.org",
      });
      expect(response.status).toBe(403);
      expect(verify).not.toHaveBeenCalled();
    } finally {
      verify.mockRestore();
    }
    expect(await snapshot()).toBe(before);
    expect((await verifyPasswordLogin("member@example.com", OLD_PASSWORD)).ok).toBe(true);
  });
});

/* ─── A completed change ─── */

describe("a completed change (#279)", () => {
  test("signs out every other session, signs this browser back in, swaps the password", async () => {
    const oldCredential = await passwordCredentialId(ids.member);
    expect(await sessionIds(ids.member)).toEqual([browser.id, device.id].toSorted());
    const verify = spyOn(Bun.password, "verify");
    const warn = spyOn(logger, "warn");
    verify.mockClear();
    warn.mockClear();
    let response: Response;
    try {
      response = await postChange(OLD_PASSWORD);
      expect(verify).toHaveBeenCalledTimes(1);
    } finally {
      verify.mockRestore();
    }

    expect(response.status).toBe(302);
    const location = response.headers.get("location") ?? "";
    expect(location.startsWith(`${PAGE}?`)).toBe(true);
    expect(decodeURIComponent(location)).toContain(SUCCESS);
    expect(location).toContain("flashType=success");
    const fresh = readSessionCookie(response.headers.get("set-cookie"));
    if (!fresh) throw new Error("no new session cookie");
    expect(fresh).not.toBe(browser.token);

    /** Exactly one session left: the new one, bound to the new credential. */
    const newCredential = await passwordCredentialId(ids.member);
    expect(newCredential).not.toBe(oldCredential);
    const [row] = await db
      .select({ id: sessions.id, credentialId: sessions.credentialId })
      .from(sessions)
      .where(eq(sessions.tokenHash, hashToken(fresh)));
    expect(row?.credentialId).toBe(newCredential);
    expect(await sessionIds(ids.member)).toEqual([row?.id ?? ""]);

    /** The other device and the old cookie are signed out; the new cookie works. */
    expect(await cookieWorks(device.token)).toBe(false);
    expect(await cookieWorks(browser.token)).toBe(false);
    expect(await cookieWorks(fresh)).toBe(true);
    const page = await call("GET", location, { token: fresh });
    expect(await page.text()).toContain(SUCCESS);

    /** The new password logs in, the old one does not. */
    expect((await verifyPasswordLogin("member@example.com", NEW_PASSWORD)).ok).toBe(true);
    expect((await verifyPasswordLogin("member@example.com", OLD_PASSWORD)).ok).toBe(
      false,
    );

    /** Another account is untouched. */
    expect(await cookieWorks(otherToken)).toBe(true);
    expect((await verifyPasswordLogin("other@example.com", OLD_PASSWORD)).ok).toBe(true);

    try {
      expect(warn).toHaveBeenCalledWith("Password changed", {
        userId: ids.member,
        sessionId: row?.id,
        previousSessionId: browser.id,
        sessionsRevoked: 2,
        resetLinksRevoked: 0,
        ip: "unknown",
      });
      const logged = JSON.stringify(warn.mock.calls);
      for (const secret of [OLD_PASSWORD, NEW_PASSWORD, fresh, browser.token]) {
        expect(logged).not.toContain(secret);
      }
    } finally {
      warn.mockRestore();
    }
  });

  test("the owner changes its own password too", async () => {
    const { id } = await seed.owner({
      email: "owner@example.com",
      password: OLD_PASSWORD,
    });
    const { token } = await seed.session({ userId: id });
    const response = await postChange(OLD_PASSWORD, NEW_PASSWORD, NEW_PASSWORD, {
      token,
    });
    expect(response.status).toBe(302);
    expect((await verifyPasswordLogin("owner@example.com", NEW_PASSWORD)).ok).toBe(true);
    expect(await cookieWorks(token)).toBe(false);
  });

  test("revokes the account's open reset link, and only the account's", async () => {
    const mine = issuedToken(await issuePasswordReset(ids.admin, ids.member));
    const theirs = issuedToken(await issuePasswordReset(ids.admin, ids.other));
    expect(await findLivePasswordReset(mine)).not.toBeNull();

    expect((await postChange(OLD_PASSWORD)).status).toBe(302);

    expect(await findLivePasswordReset(mine)).toBeNull();
    expect(await findLivePasswordReset(theirs)).not.toBeNull();
  });
});

/* ─── Races ─── */

describe("races (#279)", () => {
  /**
   * Runs `between` right after the real verify of the current password,
   * i.e. after the check and before the locked transaction.
   */
  function afterVerify(between: () => Promise<void>): { mockRestore: () => void } {
    const original = Bun.password.verify.bind(Bun.password);
    return spyOn(Bun.password, "verify").mockImplementation(async (password, hash) => {
      const verified = await original(password, hash);
      await between();
      return verified;
    });
  }

  test("an admin-issued reset completed after the verify wins: the change is refused", async () => {
    const RESET_PASSWORD = "the password the reset set, ok";
    const resetToken = issuedToken(await issuePasswordReset(ids.admin, ids.member));
    const spy = afterVerify(async () => {
      const done = await completePasswordReset(resetToken, RESET_PASSWORD);
      expect(done.ok).toBe(true);
    });
    let response: Response;
    try {
      response = await postChange(OLD_PASSWORD);
    } finally {
      spy.mockRestore();
    }
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("changed or reset elsewhere");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect((await verifyPasswordLogin("member@example.com", RESET_PASSWORD)).ok).toBe(
      true,
    );
    expect((await verifyPasswordLogin("member@example.com", NEW_PASSWORD)).ok).toBe(
      false,
    );
    /** Only the session the reset opened is left. */
    expect(await sessionIds(ids.member)).toHaveLength(1);
    expect(await cookieWorks(browser.token)).toBe(false);
  });

  test("an account deactivated after the verify: the change is refused", async () => {
    const spy = afterVerify(async () => {
      await db
        .update(users)
        .set({ disabledAt: new Date() })
        .where(eq(users.id, ids.member));
    });
    let response: Response;
    try {
      response = await postChange(OLD_PASSWORD);
    } finally {
      spy.mockRestore();
    }
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("no longer active");
    await db.update(users).set({ disabledAt: null }).where(eq(users.id, ids.member));
    expect((await verifyPasswordLogin("member@example.com", OLD_PASSWORD)).ok).toBe(true);
    expect(await sessionIds(ids.member)).toEqual([browser.id, device.id].toSorted());
  });
});

/* ─── The failed-attempt budget ─── */

describe("failed-attempt budget (#279)", () => {
  test("the limiter is on in the test environment", () => {
    expect(config.dashboard.loginRateLimit.enabled).toBe(true);
    expect(maxAttempts).toBeGreaterThan(1);
  });

  test("after the budget of wrong passwords the next try is a 429 before any argon2id, and changes nothing", async () => {
    const before = await snapshot();
    const verify = spyOn(Bun.password, "verify");
    const hash = spyOn(Bun.password, "hash");
    verify.mockClear();
    hash.mockClear();
    try {
      for (let i = 0; i < maxAttempts; i += 1) {
        expect(await (await postChange(WRONG_PASSWORD)).text()).toContain(
          "Current password is incorrect.",
        );
      }
      expect(verify).toHaveBeenCalledTimes(maxAttempts);

      /** Over budget: refused before any verify, even with the right password. */
      const limited = await postChange(OLD_PASSWORD);
      expect(limited.status).toBe(429);
      expect(await limited.text()).toContain("Too many attempts");
      expect(verify).toHaveBeenCalledTimes(maxAttempts);
      expect(hash).not.toHaveBeenCalled();
    } finally {
      verify.mockRestore();
      hash.mockRestore();
    }
    expect(await snapshot()).toBe(before);
    expect((await verifyPasswordLogin("member@example.com", OLD_PASSWORD)).ok).toBe(true);
  }, 30_000);

  /** Runs `maxAttempts` argon2id verifies in parallel: slow on a busy CI runner. */
  test("a parallel burst of wrong passwords runs at most the budget of verifies", async () => {
    const verify = spyOn(Bun.password, "verify");
    verify.mockClear();
    try {
      const responses = await Promise.all(
        Array.from({ length: maxAttempts * 3 }, () => postChange(WRONG_PASSWORD)),
      );
      const statuses = responses.map((response) => response.status);
      expect(statuses.filter((status) => status === 200)).toHaveLength(maxAttempts);
      expect(statuses.filter((status) => status === 429)).toHaveLength(maxAttempts * 2);
      expect(verify).toHaveBeenCalledTimes(maxAttempts);
    } finally {
      verify.mockRestore();
    }
    expect((await verifyPasswordLogin("member@example.com", OLD_PASSWORD)).ok).toBe(true);
  }, 30_000);

  test("the address key: another account from the same address is held too", async () => {
    for (let i = 0; i < maxAttempts; i += 1) await postChange(WRONG_PASSWORD);
    const { token } = await seed.session({ userId: ids.other });
    const response = await postChange(OLD_PASSWORD, NEW_PASSWORD, NEW_PASSWORD, {
      token,
    });
    expect(response.status).toBe(429);
    expect((await verifyPasswordLogin("other@example.com", OLD_PASSWORD)).ok).toBe(true);
  }, 30_000);

  test("the account key: a new address does not reset the account's budget", async () => {
    expect(Reflect.set(config.dashboard, "trustedProxyHops", 1)).toBe(true);
    for (let i = 0; i < maxAttempts; i += 1) {
      await postChange(WRONG_PASSWORD, NEW_PASSWORD, NEW_PASSWORD, {
        forwardedFor: `198.51.100.${i + 1}`,
      });
    }
    const response = await postChange(OLD_PASSWORD, NEW_PASSWORD, NEW_PASSWORD, {
      forwardedFor: "203.0.113.9",
    });
    expect(response.status).toBe(429);
    expect((await verifyPasswordLogin("member@example.com", OLD_PASSWORD)).ok).toBe(true);
  }, 30_000);

  test("a completed change clears the budget of the account and the address", async () => {
    for (let i = 0; i < maxAttempts - 1; i += 1) await postChange(WRONG_PASSWORD);
    expect(budgetKeys()).toEqual([`password:ip:unknown`, `password:user:${ids.member}`]);
    expect((await postChange(OLD_PASSWORD)).status).toBe(302);
    expect(budgetKeys()).toEqual([]);
  }, 30_000);
});
