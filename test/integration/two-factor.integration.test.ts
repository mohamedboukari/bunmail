/**
 * TOTP two-factor authentication (#220), through the real `pagesPlugin`
 * over HTTP against real Postgres:
 *
 * - Enrolment: start keeps the secret encrypted on the session; a wrong
 *   code is refused; the right one stores the encrypted secret, ten
 *   hashed recovery codes, signs every other session out, makes this one
 *   `mfa`, and reveals the codes exactly once.
 * - Login: the password opens a `pending` session (10 minutes) and sends
 *   the browser to the second step; a valid code turns it into an `mfa`
 *   session with a new token (the pending token is dead); a reused code
 *   is refused, also when two submissions race; a step either side is
 *   accepted, two steps are not; a recovery code works once; the budget
 *   (per account and per IP, counted before any check) revokes the
 *   pending session; the new-device alert waits for the second factor.
 * - Disable (password and code) and regenerate (an app code only).
 * - Recovery: a completed reset link and a completed `reset-owner` link
 *   remove the second factor; issuing a link, a password change and an
 *   ownership transfer do not.
 * - The `REQUIRE_2FA` policy (also over the whole route table in
 *   `dashboard-route-access.integration.test.ts`).
 *
 * The JS clock is frozen (`setSystemTime`) so codes are deterministic;
 * session expiry runs on the database clock, which is not frozen.
 */
import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  setSystemTime,
  spyOn,
} from "bun:test";
import { Elysia } from "elysia";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, seed, sessions, truncateAll } from "./_helpers.ts";
import { pagesPlugin } from "../../src/pages/pages.plugin.tsx";
import { readSessionCookie } from "../../src/pages/session.ts";
import { loginAttemptMap } from "../../src/middleware/login-rate-limit.ts";
import { userCredentials } from "../../src/modules/users/models/user-credential.schema.ts";
import { userRecoveryCodes } from "../../src/modules/users/models/user-recovery-code.schema.ts";
import * as sessionService from "../../src/modules/users/services/session.service.ts";
import * as signInDevice from "../../src/modules/users/services/sign-in-device.service.ts";
import * as totp from "../../src/modules/users/services/totp.service.ts";
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
} from "../../src/modules/users/services/recovery-code.service.ts";
import {
  completeOwnerSetup,
  issueOwnerSetupLink,
} from "../../src/modules/users/services/owner.service.ts";
import { completePasswordReset } from "../../src/modules/users/services/password-reset.service.ts";
import {
  issuePasswordReset,
  transferOwnership,
} from "../../src/modules/users/services/user-admin.service.ts";
import type { AttemptLimiter } from "../../src/modules/users/types/user.types.ts";
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
} from "../../src/utils/crypto.ts";
import { generateId } from "../../src/utils/id.ts";
import { logger } from "../../src/utils/logger.ts";
import { config } from "../../src/config.ts";

const app = new Elysia().use(pagesPlugin);

const PASSWORD = "the account password, long enough";
const NEW_PASSWORD = "a brand new passphrase, long enough";
const OWNER = "owner@example.com";
const ADMIN = "admin@example.com";
const MEMBER = "member@example.com";

/** 2027-01-01T00:00:15Z: 15 seconds into a 30-second step, so ±1 step stays clear of the edges. */
const T0 = Date.UTC(2027, 0, 1, 0, 0, 15);
const STEP = totp.totpStep(T0);

const PAGE = "/dashboard/account/two-factor";
const SECOND_STEP = "/dashboard/login/two-factor";

const { maxAttempts } = config.dashboard.loginRateLimit;
const originalProxyHops = config.dashboard.trustedProxyHops;
const originalPolicy = config.dashboard.require2fa;

const ids = { owner: "", admin: "", member: "" };

/** A limiter that never limits, for service calls outside the routes. */
const noLimit: AttemptLimiter = {
  isLimited: () => false,
  record: () => {},
  clear: () => {},
};

beforeEach(async () => {
  setSystemTime(new Date(T0));
  loginAttemptMap.clear();
  await truncateAll();
  ids.owner = (await seed.user({ email: OWNER, role: "owner", password: PASSWORD })).id;
  ids.admin = (await seed.user({ email: ADMIN, role: "admin", password: PASSWORD })).id;
  ids.member = (
    await seed.user({ email: MEMBER, role: "member", password: PASSWORD })
  ).id;
});

afterEach(() => {
  setSystemTime();
  expect(Reflect.set(config.dashboard, "trustedProxyHops", originalProxyHops)).toBe(true);
  expect(Reflect.set(config.dashboard, "require2fa", originalPolicy)).toBe(true);
});

/* ─── Helpers ─── */

/** A request, same-origin, with an optional session cookie and client IP. */
function call(
  method: "GET" | "POST",
  path: string,
  opts: { token?: string; body?: Record<string, string>; ip?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.token) headers["cookie"] = `bm_session=${opts.token}`;
  if (opts.ip) headers["x-forwarded-for"] = opts.ip;
  const url = `http://localhost${path}`;
  if (method === "GET") return app.handle(new Request(url, { headers }));
  headers["origin"] = "http://localhost";
  headers["content-type"] = "application/x-www-form-urlencoded";
  return app.handle(
    new Request(url, {
      method: "POST",
      headers,
      body: new URLSearchParams(opts.body ?? {}).toString(),
    }),
  );
}

/** The `bm_session` value a response sets, or throws. */
function sessionCookieOf(response: Response): string {
  const token = readSessionCookie(response.headers.get("set-cookie"));
  if (!token) throw new Error("no session cookie set");
  return token;
}

/** The `Max-Age` of the `bm_session` cookie a response sets. */
function sessionMaxAge(response: Response): number {
  const cookie = response.headers.getSetCookie().find((c) => c.startsWith("bm_session="));
  return Number(cookie?.match(/Max-Age=(\d+)/)?.[1] ?? "NaN");
}

/** Password step; returns the response (302 to the second step for a 2FA account). */
function passwordLogin(email: string, ip?: string): Promise<Response> {
  return call("POST", "/dashboard/login", { body: { email, password: PASSWORD }, ip });
}

/** Password step for a 2FA account; returns the pending session token. */
async function pendingLogin(email: string, ip?: string): Promise<string> {
  const response = await passwordLogin(email, ip);
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(SECOND_STEP);
  return sessionCookieOf(response);
}

/** Second step. */
function submitCode(token: string, code: string, ip?: string): Promise<Response> {
  return call("POST", SECOND_STEP, { token, body: { code }, ip });
}

/** A full (`password`) session of the account, the way a login opens it. */
async function fullSession(userId: string): Promise<{ id: string; token: string }> {
  const created = await sessionService.createSession({
    userId,
    assurance: "password",
    authMethod: "password",
    ip: null,
    userAgent: null,
  });
  return { id: created.sessionId, token: created.token };
}

/** Gives an account a confirmed second factor with known recovery codes. */
async function seedTotp(
  userId: string,
): Promise<{ key: Buffer; codes: string[]; credentialId: string }> {
  const secret = totp.generateTotpSecret();
  const credentialId = generateId("crd");
  await db.insert(userCredentials).values({
    id: credentialId,
    userId,
    type: "totp",
    secretHash: encryptSecret(secret, config.dkimEncryptionKey),
  });
  const codes = generateRecoveryCodes();
  await db.insert(userRecoveryCodes).values(
    codes.map((code) => ({
      id: generateId("rcv"),
      userId,
      credentialId,
      codeHash: hashRecoveryCode(normalizeRecoveryCode(code) ?? ""),
    })),
  );
  const key = totp.base32Decode(secret);
  if (!key) throw new Error("bad secret");
  return { key, codes, credentialId };
}

/** The code of a step relative to the frozen clock. */
function codeAt(key: Buffer, delta: number = 0): string {
  return totp.totpCode(key, STEP + delta);
}

/** The account's `totp` credential row, if any. */
async function totpRow(
  userId: string,
): Promise<typeof userCredentials.$inferSelect | undefined> {
  const [row] = await db
    .select()
    .from(userCredentials)
    .where(and(eq(userCredentials.userId, userId), eq(userCredentials.type, "totp")));
  return row;
}

/** The account's recovery code rows. */
function recoveryRows(
  userId: string,
): Promise<Array<typeof userRecoveryCodes.$inferSelect>> {
  return db.select().from(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
}

/** The assurance of a session row, or undefined when it is gone. */
async function assuranceOf(sessionId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ assurance: sessions.assurance })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  return row?.assurance;
}

/** The `reveal` token in a redirect to the Two-factor page, if any. */
function revealOf(response: Response): string | undefined {
  return response.headers.get("location")?.match(/[?&]reveal=([0-9a-f]+)/)?.[1];
}

/** The recovery codes a page shows (`xxxx-xxxx-xxxx-xxxx`). */
function codesOnPage(html: string): string[] {
  return html.match(/\b[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}\b/g) ?? [];
}

/* ─── Enrolment ─── */

describe("enrolment", () => {
  test("start keeps an encrypted secret on this session; the page shows a QR code and the key, never the URI", async () => {
    const browser = await fullSession(ids.member);
    const off = await call("GET", PAGE, { token: browser.token });
    expect(off.status).toBe(200);
    const offHtml = await off.text();
    expect(offHtml).toContain("Set up two-factor authentication");
    expect(offHtml).toContain('href="/dashboard/account/two-factor"');

    const started = await call("POST", `${PAGE}/start`, { token: browser.token });
    expect(started.status).toBe(302);
    expect(started.headers.get("location")).toBe(PAGE);

    const [row] = await db
      .select({ pending: sessions.totpPendingSecret })
      .from(sessions)
      .where(eq(sessions.id, browser.id));
    expect(row?.pending).not.toBeNull();
    const encrypted = row?.pending ?? "";
    expect(isEncryptedSecret(encrypted)).toBe(true);
    const secret = decryptSecret(encrypted, config.dkimEncryptionKey);
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(encrypted).not.toContain(secret);

    const page = await call("GET", PAGE, { token: browser.token });
    expect(page.headers.get("cache-control")).toBe("no-store");
    const html = await page.text();
    expect(html).toContain("<svg");
    expect(html).toContain(totp.formatSecretForDisplay(secret));
    expect(html).not.toContain("otpauth");
    expect(html).not.toContain(secret);
    expect(started.headers.get("location")).not.toContain(secret);
  });

  test("a wrong code is refused and changes nothing; the enrolment stays", async () => {
    const browser = await fullSession(ids.member);
    await call("POST", `${PAGE}/start`, { token: browser.token });
    const response = await call("POST", `${PAGE}/confirm`, {
      token: browser.token,
      body: { code: "000000" },
    });
    expect(response.status).toBe(302);
    expect(decodeURIComponent(response.headers.get("location") ?? "")).toContain(
      "Invalid code",
    );
    expect(await totpRow(ids.member)).toBeUndefined();
    expect(await recoveryRows(ids.member)).toHaveLength(0);
    expect(await assuranceOf(browser.id)).toBe("password");
    const [row] = await db
      .select({ pending: sessions.totpPendingSecret })
      .from(sessions)
      .where(eq(sessions.id, browser.id));
    expect(row?.pending).not.toBeNull();
  });

  test("the right code stores the encrypted secret, hashed recovery codes, signs other sessions out, makes this one mfa and reveals the codes once", async () => {
    const browser = await fullSession(ids.member);
    const otherDevice = await fullSession(ids.member);
    const bystander = await fullSession(ids.admin);
    await call("POST", `${PAGE}/start`, { token: browser.token });
    const [pendingRow] = await db
      .select({ pending: sessions.totpPendingSecret })
      .from(sessions)
      .where(eq(sessions.id, browser.id));
    const secret = decryptSecret(pendingRow?.pending ?? "", config.dkimEncryptionKey);
    const key = totp.base32Decode(secret);
    if (!key) throw new Error("bad secret");

    const warn = spyOn(logger, "warn");
    let confirmed: Response;
    try {
      confirmed = await call("POST", `${PAGE}/confirm`, {
        token: browser.token,
        body: { code: codeAt(key) },
      });
      expect(warn).toHaveBeenCalledWith("Two-factor authentication enabled", {
        userId: ids.member,
        sessionId: browser.id,
        sessionsRevoked: 1,
        ip: "unknown",
      });
    } finally {
      warn.mockRestore();
    }
    expect(confirmed.status).toBe(302);
    const reveal = revealOf(confirmed);
    expect(reveal).toBeDefined();

    /** The credential: encrypted secret (decrypts to the enrolled one), the step as counter. */
    const row = await totpRow(ids.member);
    expect(row?.id).toMatch(/^crd_/);
    expect(typeof row?.secretHash).toBe("string");
    expect(isEncryptedSecret(row?.secretHash ?? "")).toBe(true);
    expect(row?.secretHash).not.toContain(secret);
    expect(decryptSecret(row?.secretHash ?? "", config.dkimEncryptionKey)).toBe(secret);
    expect(row?.counter).toBe(STEP);

    /** Sessions: the other device is gone, the bystander kept, this one is mfa, the pending secret cleared. */
    expect(await assuranceOf(otherDevice.id)).toBeUndefined();
    expect(await assuranceOf(bystander.id)).toBe("password");
    expect(await assuranceOf(browser.id)).toBe("mfa");
    const [after] = await db
      .select({ pending: sessions.totpPendingSecret })
      .from(sessions)
      .where(eq(sessions.id, browser.id));
    expect(after?.pending).toBeNull();

    /** The codes: revealed once, stored as SHA-256 only. */
    const page = await call("GET", `${PAGE}?reveal=${reveal}`, { token: browser.token });
    const html = await page.text();
    const codes = codesOnPage(html);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    const stored = await recoveryRows(ids.member);
    expect(stored).toHaveLength(10);
    for (const code of codes) {
      expect(stored.map((r) => r.codeHash)).toContain(
        hashRecoveryCode(normalizeRecoveryCode(code) ?? ""),
      );
    }
    expect(JSON.stringify(stored)).not.toContain(codes[0] ?? "x");
    for (const r of stored) expect(r.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(html).toContain("Two-factor authentication is on.");

    const again = await call("GET", `${PAGE}?reveal=${reveal}`, { token: browser.token });
    expect(codesOnPage(await again.text())).toHaveLength(0);
  });

  test("the recovery codes are revealed only to the session that enabled 2FA", async () => {
    const browser = await fullSession(ids.member);
    await call("POST", `${PAGE}/start`, { token: browser.token });
    const [pendingRow] = await db
      .select({ pending: sessions.totpPendingSecret })
      .from(sessions)
      .where(eq(sessions.id, browser.id));
    const key = totp.base32Decode(
      decryptSecret(pendingRow?.pending ?? "", config.dkimEncryptionKey),
    );
    if (!key) throw new Error("bad secret");
    const confirmed = await call("POST", `${PAGE}/confirm`, {
      token: browser.token,
      body: { code: codeAt(key) },
    });
    const reveal = revealOf(confirmed);
    const intruder = await fullSession(ids.admin);
    const stolen = await call("GET", `${PAGE}?reveal=${reveal}`, {
      token: intruder.token,
    });
    expect(codesOnPage(await stolen.text())).toHaveLength(0);
    const own = await call("GET", `${PAGE}?reveal=${reveal}`, { token: browser.token });
    expect(codesOnPage(await own.text())).toHaveLength(10);
  });

  test("start and confirm are refused once 2FA is on", async () => {
    await seedTotp(ids.member);
    const browser = await fullSession(ids.member);
    const started = await call("POST", `${PAGE}/start`, { token: browser.token });
    expect(decodeURIComponent(started.headers.get("location") ?? "")).toContain(
      "already on",
    );
    const [row] = await db
      .select({ pending: sessions.totpPendingSecret })
      .from(sessions)
      .where(eq(sessions.id, browser.id));
    expect(row?.pending).toBeNull();
    const confirmed = await call("POST", `${PAGE}/confirm`, {
      token: browser.token,
      body: { code: "123456" },
    });
    expect(decodeURIComponent(confirmed.headers.get("location") ?? "")).toContain(
      "Start the setup again",
    );
  });
});

/* ─── Login ─── */

describe("login with two-factor", () => {
  test("the password opens a 10-minute pending session and sends the browser to the second step", async () => {
    await seedTotp(ids.member);
    const check = spyOn(signInDevice, "recognizeSignInDevice");
    try {
      const response = await passwordLogin(MEMBER);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(SECOND_STEP);
      expect(sessionMaxAge(response)).toBe(600);
      /** No device cookie and no new-device check before the second factor (#282). */
      expect(
        response.headers.getSetCookie().some((c) => c.startsWith("bm_device=")),
      ).toBe(false);
      expect(check).not.toHaveBeenCalled();
      const token = sessionCookieOf(response);
      const [row] = await db
        .select({
          assurance: sessions.assurance,
          short: sql<boolean>`${sessions.expiresAt} <= now() + interval '10 minutes'`,
        })
        .from(sessions)
        .where(eq(sessions.userId, ids.member));
      expect(row).toEqual({ assurance: "pending", short: true });

      const form = await call("GET", SECOND_STEP, { token });
      expect(form.status).toBe(200);
      expect(form.headers.get("cache-control")).toBe("no-store");
      expect(await form.text()).toContain('name="code"');

      /** The pending session opens nothing else. */
      for (const path of ["/dashboard", "/dashboard/account/sessions", PAGE]) {
        const denied = await call("GET", path, { token });
        expect(denied.status).toBe(302);
        expect(denied.headers.get("location")).toBe("/dashboard/login");
      }
    } finally {
      check.mockRestore();
    }
  });

  test("an account without a second factor signs in as before", async () => {
    const response = await passwordLogin(MEMBER);
    expect(response.headers.get("location")).toBe("/dashboard");
    const [row] = await db
      .select({ assurance: sessions.assurance })
      .from(sessions)
      .where(eq(sessions.userId, ids.member));
    expect(row?.assurance).toBe("password");
  });

  test("the second step without a pending session goes nowhere", async () => {
    const none = await call("GET", SECOND_STEP);
    expect(none.headers.get("location")).toBe("/dashboard");
    const full = await fullSession(ids.member);
    const withFull = await call("GET", SECOND_STEP, { token: full.token });
    expect(withFull.headers.get("location")).toBe("/dashboard");
    const post = await submitCode(full.token, "123456");
    expect(post.headers.get("location")).toBe("/dashboard");
    /** A full session is never touched by the second step, nor its cookie cleared. */
    expect(post.headers.get("set-cookie")).toBeNull();
    expect(await assuranceOf(full.id)).toBe("password");
  });

  test("a valid code makes the session mfa with a new token; the pending token is dead; the new-device check runs now", async () => {
    const { key } = await seedTotp(ids.member);
    const pending = await pendingLogin(MEMBER);
    const check = spyOn(signInDevice, "recognizeSignInDevice");
    const info = spyOn(logger, "info");
    try {
      const response = await submitCode(pending, codeAt(key));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard");
      const token = sessionCookieOf(response);
      expect(token).not.toBe(pending);
      expect(sessionMaxAge(response)).toBeGreaterThan(7 * 24 * 3600 - 120);
      expect(
        response.headers.getSetCookie().some((c) => c.startsWith("bm_device=")),
      ).toBe(true);
      expect(check).toHaveBeenCalledTimes(1);
      expect(check.mock.calls[0]?.[0].userId).toBe(ids.member);
      await Promise.all(check.mock.results.map((r) => r.value));
      expect(info).toHaveBeenCalledWith(
        "Dashboard login successful",
        expect.objectContaining({ userId: ids.member, method: "totp" }),
      );

      const active = await sessionService.findActiveSession(token);
      expect(active?.assurance).toBe("mfa");
      expect(active?.hasTotp).toBe(true);
      expect(await sessionService.findActiveSession(pending)).toBeNull();
      expect(await sessionService.findPendingSession(pending)).toBeNull();
      expect((await call("GET", "/dashboard", { token })).status).toBe(200);
      const old = await call("GET", "/dashboard", { token: pending });
      expect(old.headers.get("location")).toBe("/dashboard/login");
      expect((await totpRow(ids.member))?.counter).toBe(STEP);
    } finally {
      check.mockRestore();
      info.mockRestore();
    }
  });

  test("a code is accepted once: replaying it in a new sign-in is refused", async () => {
    const { key } = await seedTotp(ids.member);
    const first = await submitCode(await pendingLogin(MEMBER), codeAt(key));
    expect(first.headers.get("location")).toBe("/dashboard");

    const pending = await pendingLogin(MEMBER);
    const replay = await submitCode(pending, codeAt(key));
    expect(replay.status).toBe(200);
    expect(await replay.text()).toContain("Invalid code");
    expect(await sessionService.findPendingSession(pending)).not.toBeNull();
    /** An older step than the accepted one is refused too. */
    const older = await submitCode(pending, codeAt(key, -1));
    expect(older.status).toBe(200);
    /** The next step's code works. */
    const next = await submitCode(pending, codeAt(key, 1));
    expect(next.headers.get("location")).toBe("/dashboard");
    expect((await totpRow(ids.member))?.counter).toBe(STEP + 1);
  });

  test("two racing submissions of one code from two browsers: exactly one wins", async () => {
    const { key } = await seedTotp(ids.member);
    const a = await pendingLogin(MEMBER, "198.51.100.1");
    const b = await pendingLogin(MEMBER, "198.51.100.2");
    const code = codeAt(key);
    const results = await Promise.all([submitCode(a, code), submitCode(b, code)]);
    const won = results.filter((r) => r.headers.get("location") === "/dashboard");
    expect(won).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });

  test("two racing submissions on one pending session: one wins, the other finds it gone", async () => {
    const { key } = await seedTotp(ids.member);
    const pending = await pendingLogin(MEMBER);
    const results = await Promise.all([
      submitCode(pending, codeAt(key)),
      submitCode(pending, codeAt(key, 1)),
    ]);
    const locations = results
      .map((r) => r.headers.get("location") ?? "")
      .toSorted((x, y) => x.localeCompare(y));
    /** The loser leaves the cookie alone (it may be the winner's fresh one). */
    expect(locations).toEqual(["/dashboard", "/dashboard"]);
    expect(results.filter((r) => r.headers.get("set-cookie") !== null)).toHaveLength(1);
    const [row] = await db
      .select({ assurance: sessions.assurance })
      .from(sessions)
      .where(eq(sessions.userId, ids.member));
    expect(row?.assurance).toBe("mfa");
  });

  test("one step either side is accepted, two steps are not", async () => {
    const { key } = await seedTotp(ids.member);
    const cases: Array<[number, boolean]> = [
      [-2, false],
      [2, false],
      [-1, true],
      [1, true],
    ];
    for (const [delta, accepted] of cases) {
      await db
        .update(userCredentials)
        .set({ counter: null })
        .where(eq(userCredentials.userId, ids.member));
      const response = await submitCode(await pendingLogin(MEMBER), codeAt(key, delta));
      expect(`${delta}: ${response.headers.get("location") === "/dashboard"}`).toBe(
        `${delta}: ${accepted}`,
      );
    }
  });

  test("a recovery code works once, in any case and spacing, and is logged with the codes left", async () => {
    const { codes } = await seedTotp(ids.member);
    const code = codes[0] ?? "";
    const warn = spyOn(logger, "warn");
    try {
      const response = await submitCode(
        await pendingLogin(MEMBER),
        ` ${code.toUpperCase().replaceAll("-", " ")} `,
      );
      expect(response.headers.get("location")).toBe("/dashboard");
      const token = sessionCookieOf(response);
      expect((await sessionService.findActiveSession(token))?.assurance).toBe("mfa");
      expect(warn).toHaveBeenCalledWith(
        "Recovery code used",
        expect.objectContaining({ userId: ids.member, recoveryCodesLeft: 9 }),
      );
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain(code);
    } finally {
      warn.mockRestore();
    }
    const used = (await recoveryRows(ids.member)).filter((r) => r.usedAt !== null);
    expect(used).toHaveLength(1);

    const again = await submitCode(await pendingLogin(MEMBER), code);
    expect(again.status).toBe(200);
    expect(await again.text()).toContain("Invalid code");
  });

  test("wrong codes: a generic error, then the budget revokes the pending session; the account stays locked for the window", async () => {
    const { key } = await seedTotp(ids.member);
    const pending = await pendingLogin(MEMBER);
    for (let i = 1; i < maxAttempts; i += 1) {
      const wrong = await submitCode(pending, "000000");
      expect(wrong.status).toBe(200);
      expect(await wrong.text()).toContain("Invalid code. Try again.");
    }
    const last = await submitCode(pending, "000000");
    expect(last.status).toBe(302);
    expect(last.headers.get("location")).toBe("/dashboard/login?error=two_factor_locked");
    expect(await sessionService.findPendingSession(pending)).toBeNull();
    const [row] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, ids.member));
    expect(row).toBeUndefined();

    const page = await call("GET", "/dashboard/login?error=two_factor_locked");
    expect(await page.text()).toContain("Too many invalid codes");

    /** From another address, even the right code is refused until the window ends. */
    const fresh = await pendingLogin(MEMBER, "198.51.100.77");
    const blocked = await submitCode(fresh, codeAt(key), "198.51.100.77");
    expect(blocked.headers.get("location")).toBe(
      "/dashboard/login?error=two_factor_locked",
    );
    expect((await totpRow(ids.member))?.counter).toBeNull();
  });

  test("the per-account budget is counted before any check: a parallel burst from many addresses checks at most the budget", async () => {
    expect(Reflect.set(config.dashboard, "trustedProxyHops", 1)).toBe(true);
    await seedTotp(ids.member);
    await seedTotp(ids.admin);
    const pending = await pendingLogin(MEMBER, "198.51.100.200");
    const match = spyOn(totp, "matchTotpStep");
    try {
      await Promise.all(
        Array.from({ length: maxAttempts + 5 }, (_, i) =>
          submitCode(pending, "000000", `203.0.113.${i + 1}`),
        ),
      );
      /**
       * At most the budget. Possibly fewer, even none: a request over the
       * budget revokes the pending session, and counted requests still in
       * flight then find it gone. Without the per-account count before the
       * check, every request (each from a fresh address) would verify.
       */
      expect(match.mock.calls.length).toBeLessThanOrEqual(maxAttempts);

      /** The spy does see verifications (the bound above is not vacuous). */
      const before = match.mock.calls.length;
      const other = await pendingLogin(ADMIN, "198.51.100.201");
      expect((await submitCode(other, "000000", "198.51.100.201")).status).toBe(200);
      expect(match.mock.calls.length).toBe(before + 1);
    } finally {
      match.mockRestore();
    }
  });

  test("the per-address budget spans accounts", async () => {
    expect(Reflect.set(config.dashboard, "trustedProxyHops", 1)).toBe(true);
    await seedTotp(ids.member);
    const { key } = await seedTotp(ids.admin);
    const ip = "198.51.100.9";
    const pending = await pendingLogin(MEMBER, ip);
    for (let i = 0; i < maxAttempts; i += 1) await submitCode(pending, "000000", ip);
    const other = await pendingLogin(ADMIN, ip);
    const blocked = await submitCode(other, codeAt(key), ip);
    expect(blocked.headers.get("location")).toBe(
      "/dashboard/login?error=two_factor_locked",
    );
  });

  test("a success clears the account's failures", async () => {
    const { key } = await seedTotp(ids.member);
    const pending = await pendingLogin(MEMBER);
    for (let i = 1; i < maxAttempts; i += 1) await submitCode(pending, "000000");
    expect((await submitCode(pending, codeAt(key))).headers.get("location")).toBe(
      "/dashboard",
    );
    expect(loginAttemptMap.has(`totp:user:${ids.member}`)).toBe(false);
  });

  test("a cross-origin second step is refused", async () => {
    const { key } = await seedTotp(ids.member);
    const pending = await pendingLogin(MEMBER);
    const response = await app.handle(
      new Request(`http://localhost${SECOND_STEP}`, {
        method: "POST",
        headers: {
          cookie: `bm_session=${pending}`,
          origin: "https://evil.example",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ code: codeAt(key) }).toString(),
      }),
    );
    expect(response.status).toBe(403);
    expect(await sessionService.findPendingSession(pending)).not.toBeNull();
  });

  test("logout ends a pending session", async () => {
    await seedTotp(ids.member);
    const pending = await pendingLogin(MEMBER);
    await call("POST", "/dashboard/logout", { token: pending });
    expect(await sessionService.findPendingSession(pending)).toBeNull();
  });
});

/* ─── Disable and regenerate ─── */

describe("disable and regenerate", () => {
  test("disabling needs the password AND a code; then the login needs the password only", async () => {
    const { key } = await seedTotp(ids.member);
    const browser = await fullSession(ids.member);
    const wrongPassword = await call("POST", `${PAGE}/disable`, {
      token: browser.token,
      body: { password: "not the password at all", code: codeAt(key) },
    });
    expect(decodeURIComponent(wrongPassword.headers.get("location") ?? "")).toContain(
      "The password or the code is incorrect.",
    );
    expect(await totpRow(ids.member)).toBeDefined();

    const wrongCode = await call("POST", `${PAGE}/disable`, {
      token: browser.token,
      body: { password: PASSWORD, code: "000000" },
    });
    expect(decodeURIComponent(wrongCode.headers.get("location") ?? "")).toContain(
      "The password or the code is incorrect.",
    );
    expect(await totpRow(ids.member)).toBeDefined();

    const done = await call("POST", `${PAGE}/disable`, {
      token: browser.token,
      body: { password: PASSWORD, code: codeAt(key) },
    });
    expect(decodeURIComponent(done.headers.get("location") ?? "")).toContain(
      "Two-factor authentication is off.",
    );
    expect(await totpRow(ids.member)).toBeUndefined();
    expect(await recoveryRows(ids.member)).toHaveLength(0);
    /** Sessions are kept. */
    expect(await assuranceOf(browser.id)).toBe("password");
    expect((await passwordLogin(MEMBER)).headers.get("location")).toBe("/dashboard");
  });

  test("a recovery code can disable it", async () => {
    const { codes } = await seedTotp(ids.member);
    const browser = await fullSession(ids.member);
    await call("POST", `${PAGE}/disable`, {
      token: browser.token,
      body: { password: PASSWORD, code: codes[3] ?? "" },
    });
    expect(await totpRow(ids.member)).toBeUndefined();
  });

  test("regenerating needs an app code (not a recovery code) and replaces every code", async () => {
    const { key, codes } = await seedTotp(ids.member);
    const browser = await fullSession(ids.member);
    const withRecovery = await call("POST", `${PAGE}/recovery-codes`, {
      token: browser.token,
      body: { code: codes[0] ?? "" },
    });
    expect(decodeURIComponent(withRecovery.headers.get("location") ?? "")).toContain(
      "Invalid code",
    );
    expect(
      (await recoveryRows(ids.member)).filter((r) => r.usedAt === null),
    ).toHaveLength(10);

    const done = await call("POST", `${PAGE}/recovery-codes`, {
      token: browser.token,
      body: { code: codeAt(key) },
    });
    const reveal = revealOf(done);
    const page = await call("GET", `${PAGE}?reveal=${reveal}`, { token: browser.token });
    const fresh = codesOnPage(await page.text());
    expect(fresh).toHaveLength(10);
    for (const old of codes) expect(fresh).not.toContain(old);
    const stored = await recoveryRows(ids.member);
    expect(stored).toHaveLength(10);
    expect(stored.map((r) => r.codeHash)).not.toContain(
      hashRecoveryCode(normalizeRecoveryCode(codes[0] ?? "") ?? ""),
    );

    /** An old code no longer signs in; a new one does. */
    const pending = await pendingLogin(MEMBER);
    expect((await submitCode(pending, codes[1] ?? "")).status).toBe(200);
    expect((await submitCode(pending, fresh[0] ?? "")).headers.get("location")).toBe(
      "/dashboard",
    );
  });
});

/* ─── Recovery semantics ─── */

describe("lost authenticator and other account flows", () => {
  test("a completed admin-issued reset removes the second factor; the new session is a password one", async () => {
    await seedTotp(ids.member);
    const issued = await issuePasswordReset(ids.admin, ids.member);
    if (!issued.ok) throw new Error(issued.reason);
    const token = new URL(issued.url).searchParams.get("token") ?? "";
    /** Issuing alone removes nothing. */
    expect(await totpRow(ids.member)).toBeDefined();
    const result = await completePasswordReset(token, NEW_PASSWORD);
    expect(result.ok && result.twoFactorRemoved).toBe(true);
    expect(await totpRow(ids.member)).toBeUndefined();
    expect(await recoveryRows(ids.member)).toHaveLength(0);
    if (result.ok) expect(await assuranceOf(result.sessionId)).toBe("password");
  });

  test("reset-owner: issuing the link keeps the owner's 2FA; completing it removes it", async () => {
    await seedTotp(ids.owner);
    const link = await issueOwnerSetupLink(OWNER);
    expect(await totpRow(ids.owner)).toBeDefined();
    /** Until the link is used, the password still needs the second factor. */
    expect((await passwordLogin(OWNER)).headers.get("location")).toBe(SECOND_STEP);
    const done = await completeOwnerSetup(link.token, NEW_PASSWORD);
    expect(done?.twoFactorRemoved).toBe(true);
    expect(await totpRow(ids.owner)).toBeUndefined();
    expect(await recoveryRows(ids.owner)).toHaveLength(0);
  });

  test("a password change keeps the second factor, and the new session stays mfa", async () => {
    const { key } = await seedTotp(ids.member);
    const signedIn = await submitCode(await pendingLogin(MEMBER), codeAt(key));
    const token = sessionCookieOf(signedIn);
    const changed = await call("POST", "/dashboard/account/password", {
      token,
      body: { current: PASSWORD, password: NEW_PASSWORD, confirm: NEW_PASSWORD },
    });
    expect(changed.status).toBe(302);
    const fresh = sessionCookieOf(changed);
    expect((await sessionService.findActiveSession(fresh))?.assurance).toBe("mfa");
    expect(await totpRow(ids.member)).toBeDefined();
    expect(
      (await recoveryRows(ids.member)).filter((r) => r.usedAt === null),
    ).toHaveLength(10);
  });

  test("an ownership transfer keeps both accounts' second factors", async () => {
    await seedTotp(ids.owner);
    await seedTotp(ids.admin);
    const result = await transferOwnership(ids.owner, ids.admin, PASSWORD, noLimit);
    expect(result.ok).toBe(true);
    expect(await totpRow(ids.owner)).toBeDefined();
    expect(await totpRow(ids.admin)).toBeDefined();
  });

  test("the Active sessions page lists no pending session", async () => {
    await seedTotp(ids.member);
    await pendingLogin(MEMBER);
    const listed = await sessionService.listUserSessions(ids.member);
    expect(listed).toHaveLength(0);
  });
});

/* ─── REQUIRE_2FA ─── */

describe("REQUIRE_2FA", () => {
  test("none: nobody is held back", async () => {
    expect(Reflect.set(config.dashboard, "require2fa", "none")).toBe(true);
    const owner = await fullSession(ids.owner);
    expect((await call("GET", "/dashboard", { token: owner.token })).status).toBe(200);
  });

  test("owner: the owner without 2FA can open only its Two-factor page; others are not held back", async () => {
    expect(Reflect.set(config.dashboard, "require2fa", "owner")).toBe(true);
    const owner = await fullSession(ids.owner);
    const admin = await fullSession(ids.admin);
    const home = await call("GET", "/dashboard", { token: owner.token });
    expect(home.status).toBe(302);
    expect(home.headers.get("location")).toBe(PAGE);
    const page = await call("GET", PAGE, { token: owner.token });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Your role requires two-factor authentication");
    expect((await call("GET", "/dashboard", { token: admin.token })).status).toBe(200);
    /** Logout stays reachable. */
    const out = await call("POST", "/dashboard/logout", { token: owner.token });
    expect(out.headers.get("location")).toBe("/dashboard/login");
  });

  test("admin: admins and the owner are held back until they enrol; members are not", async () => {
    expect(Reflect.set(config.dashboard, "require2fa", "admin")).toBe(true);
    const admin = await fullSession(ids.admin);
    const member = await fullSession(ids.member);
    expect(
      (await call("GET", "/dashboard/users", { token: admin.token })).headers.get(
        "location",
      ),
    ).toBe(PAGE);
    expect((await call("GET", "/dashboard/emails", { token: member.token })).status).toBe(
      200,
    );

    /** Enrolling through the page lets the admin in. */
    await call("POST", `${PAGE}/start`, { token: admin.token });
    const [row] = await db
      .select({ pending: sessions.totpPendingSecret })
      .from(sessions)
      .where(eq(sessions.id, admin.id));
    const key = totp.base32Decode(
      decryptSecret(row?.pending ?? "", config.dkimEncryptionKey),
    );
    if (!key) throw new Error("bad secret");
    await call("POST", `${PAGE}/confirm`, {
      token: admin.token,
      body: { code: codeAt(key) },
    });
    expect((await call("GET", "/dashboard/users", { token: admin.token })).status).toBe(
      200,
    );
  });

  test("a password session of an enrolled account is not held back", async () => {
    expect(Reflect.set(config.dashboard, "require2fa", "owner")).toBe(true);
    await seedTotp(ids.owner);
    const owner = await fullSession(ids.owner);
    expect((await call("GET", "/dashboard", { token: owner.token })).status).toBe(200);
  });
});

/* ─── Storage invariants ─── */

describe("storage", () => {
  test("one totp credential per account (database-enforced)", async () => {
    await seedTotp(ids.member);
    let failed = false;
    try {
      await seedTotp(ids.member);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });

  test("removing the credential removes its recovery codes (cascade)", async () => {
    const { credentialId } = await seedTotp(ids.member);
    await db.delete(userCredentials).where(eq(userCredentials.id, credentialId));
    expect(await recoveryRows(ids.member)).toHaveLength(0);
    const unused = await db
      .select()
      .from(userRecoveryCodes)
      .where(isNull(userRecoveryCodes.usedAt));
    expect(unused).toHaveLength(0);
  });
});
