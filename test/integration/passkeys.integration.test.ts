/**
 * Passkeys (WebAuthn, #223), through the real `pagesPlugin` over HTTP
 * against real Postgres, with real signature verification: a software
 * authenticator (`_webauthn.ts`) holds a P-256 key pair and builds the
 * client data, the authenticator data and the `none` attestation by hand,
 * so `@simplewebauthn/server` verifies real signatures. Nothing of the
 * library is mocked.
 *
 * - Adding a passkey needs the current password; the challenge is bound
 *   to the session; the first one signs the other sessions out and makes
 *   this one `mfa`.
 * - Passwordless sign-in gives an `mfa` session; the second login step
 *   with a passkey completes a `pending` session.
 * - Refused: a wrong origin, a wrong RP ID, a replayed challenge, an
 *   expired challenge, a bad signature, no user verification, an unknown
 *   credential (one generic error), a deactivated account, a counter
 *   regression (with the alert and the audit row).
 * - Policy: a `password` session is refused once a passkey exists; a
 *   passkey satisfies `REQUIRE_2FA`; a reset link removes passkeys.
 * - Managing: rename, remove (password needed), only one's own.
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
import { and, eq } from "drizzle-orm";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";
import { db, seed, sessions, truncateAll } from "./_helpers.ts";
import { TestAuthenticator, type CeremonyOverrides } from "./_webauthn.ts";
import { readJson } from "../read-json.ts";
import { pagesPlugin } from "../../src/pages/pages.plugin.tsx";
import { readSessionCookie, readWebAuthnCookie } from "../../src/pages/session.ts";
import { loginAttemptMap } from "../../src/middleware/login-rate-limit.ts";
import { resetCodesExhaustedAlerts } from "../../src/pages/lib/two-factor-limiter.ts";
import { userCredentials } from "../../src/modules/users/models/user-credential.schema.ts";
import { users } from "../../src/modules/users/models/user.schema.ts";
import { auditEvents } from "../../src/modules/audit/models/audit-event.schema.ts";
import * as sessionService from "../../src/modules/users/services/session.service.ts";
import * as twoFactorAlert from "../../src/modules/users/services/two-factor-alert.service.ts";
import { passkeyChallenges } from "../../src/modules/users/services/passkey-challenge.service.ts";
import { issuePasswordReset } from "../../src/modules/users/services/user-admin.service.ts";
import { TWO_FACTOR_PAGE } from "../../src/modules/users/services/two-factor-policy.service.ts";
import { logger } from "../../src/utils/logger.ts";
import { config } from "../../src/config.ts";

const app = new Elysia().use(pagesPlugin);

const ORIGIN = "http://localhost";
const PASSWORD = "the account password, long enough";
const NEW_PASSWORD = "a brand new passphrase, long enough";
const OWNER = "owner@example.com";
const ADMIN = "admin@example.com";
const MEMBER = "member@example.com";
const PAGE = "/dashboard/account/passkeys";
const SECOND_STEP = "/dashboard/login/two-factor";

const originalBaseUrl = config.appBaseUrl;
const originalProxyHops = config.dashboard.trustedProxyHops;
const originalPolicy = config.dashboard.require2fa;
const ids = { owner: "", admin: "", member: "" };

beforeEach(async () => {
  expect(Reflect.set(config, "appBaseUrl", ORIGIN)).toBe(true);
  /** Read the client IP from `X-Forwarded-For`, as behind one proxy. */
  expect(Reflect.set(config.dashboard, "trustedProxyHops", 1)).toBe(true);
  loginAttemptMap.clear();
  resetCodesExhaustedAlerts();
  passkeyChallenges.clear();
  await truncateAll();
  ids.owner = (await seed.user({ email: OWNER, role: "owner", password: PASSWORD })).id;
  ids.admin = (await seed.user({ email: ADMIN, role: "admin", password: PASSWORD })).id;
  ids.member = (
    await seed.user({ email: MEMBER, role: "member", password: PASSWORD })
  ).id;
});

afterEach(() => {
  setSystemTime();
  expect(Reflect.set(config, "appBaseUrl", originalBaseUrl)).toBe(true);
  expect(Reflect.set(config.dashboard, "require2fa", originalPolicy)).toBe(true);
  expect(Reflect.set(config.dashboard, "trustedProxyHops", originalProxyHops)).toBe(true);
});

/* ─── Helpers ─── */

/** A request, same-origin by default, with optional cookies and a form body. */
function call(
  method: "GET" | "POST",
  path: string,
  opts: {
    token?: string;
    wa?: string;
    body?: Record<string, string>;
    ip?: string;
    origin?: string;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  const cookies: string[] = [];
  if (opts.token) cookies.push(`bm_session=${opts.token}`);
  if (opts.wa) cookies.push(`bm_wa=${opts.wa}`);
  if (cookies.length > 0) headers["cookie"] = cookies.join("; ");
  if (opts.ip) headers["x-forwarded-for"] = opts.ip;
  const url = `http://localhost${path}`;
  if (method === "GET") return app.handle(new Request(url, { headers }));
  headers["origin"] = opts.origin ?? ORIGIN;
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
  const cookie = response.headers
    .getSetCookie()
    .find((c) => c.startsWith("bm_session=") && !c.startsWith("bm_session=;"));
  const token = readSessionCookie(cookie ?? null);
  if (!token) throw new Error("no session cookie set");
  return token;
}

/** A full session of the account. */
async function fullSession(
  userId: string,
  assurance: "password" | "mfa" = "password",
): Promise<{ id: string; token: string }> {
  return seed.session({ userId, assurance });
}

/** The flash text of a redirect to the Passkeys page. */
function flashOf(response: Response): string {
  const location = response.headers.get("location") ?? "";
  return new URL(location, ORIGIN).searchParams.get("flash") ?? "";
}

/** Asks for creation options in `token`'s session. */
async function registrationOptions(
  token: string,
  body: { name?: string; password?: string } = {},
): Promise<{
  status: number;
  options?: PublicKeyCredentialCreationOptionsJSON;
  error?: string;
}> {
  const response = await call("POST", `${PAGE}/options`, {
    token,
    body: { name: body.name ?? "My laptop", password: body.password ?? PASSWORD },
  });
  const data = await readJson<{
    options?: PublicKeyCredentialCreationOptionsJSON;
    error?: string;
  }>(response);
  return { status: response.status, ...data };
}

/** Posts a finish form's credential. */
function finish(
  path: string,
  credential: unknown,
  opts: { token?: string; wa?: string; ip?: string } = {},
): Promise<Response> {
  return call("POST", path, {
    ...opts,
    body: { credential: JSON.stringify(credential) },
  });
}

/** Adds a passkey over HTTP in `token`'s session; returns the authenticator. */
async function addPasskey(
  token: string,
  opts: { counter?: number; name?: string } = {},
): Promise<TestAuthenticator> {
  const authenticator = await TestAuthenticator.create(ORIGIN, { counter: opts.counter });
  const { options } = await registrationOptions(token, { name: opts.name });
  if (!options) throw new Error("no options");
  const response = await finish(PAGE, await authenticator.register(options), { token });
  expect(response.status).toBe(302);
  expect(flashOf(response)).toStartWith("Passkey added");
  return authenticator;
}

/** The account's passkey rows. */
function passkeyRows(userId: string) {
  return db
    .select({
      id: userCredentials.id,
      name: userCredentials.name,
      counter: userCredentials.counter,
      credentialId: userCredentials.providerAccountId,
      publicKey: userCredentials.publicKey,
      transports: userCredentials.transports,
      lastUsedAt: userCredentials.lastUsedAt,
    })
    .from(userCredentials)
    .where(and(eq(userCredentials.userId, userId), eq(userCredentials.type, "passkey")));
}

/** A session row by id. */
async function sessionRow(id: string) {
  const [row] = await db
    .select({
      assurance: sessions.assurance,
      authMethod: sessions.authMethod,
      credentialId: sessions.credentialId,
    })
    .from(sessions)
    .where(eq(sessions.id, id));
  return row;
}

/** A session row by its cookie token (the guard's own lookup). */
function liveSessionOf(token: string) {
  return sessionService.findActiveSession(token);
}

/** Starts a passwordless sign-in: the options and the `bm_wa` cookie. */
async function signInOptions(
  ip?: string,
): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; wa: string }> {
  const response = await call("POST", "/dashboard/login/passkey/options", { ip });
  expect(response.status).toBe(200);
  const cookie = response.headers.getSetCookie().find((c) => c.startsWith("bm_wa="));
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Strict");
  expect(cookie).toContain("Path=/dashboard");
  const wa = readWebAuthnCookie(cookie ?? null);
  if (!wa) throw new Error("no bm_wa cookie");
  const { options } = await readJson<{ options: PublicKeyCredentialRequestOptionsJSON }>(
    response,
  );
  return { options, wa };
}

/** Client addresses for sign-ins that do not test the budget: one each, so none runs out. */
let nextAddress = 0;

/**
 * A whole passwordless sign-in with `authenticator`; returns the finish
 * response. Without `ip`, from a fresh address (each start costs one
 * attempt of the client's login budget).
 */
async function passwordless(
  authenticator: TestAuthenticator,
  overrides: CeremonyOverrides = {},
  address?: string,
): Promise<Response> {
  const ip =
    address ?? `198.18.${Math.floor(nextAddress / 250)}.${(nextAddress++ % 250) + 1}`;
  const { options, wa } = await signInOptions(ip);
  return finish(
    "/dashboard/login/passkey",
    await authenticator.assert(options, overrides),
    {
      wa,
      ip,
    },
  );
}

/** Spies on the security emails; never sends. */
function spyAlerts(): {
  calls: () => twoFactorAlert.SendTwoFactorAlertInput[];
  restore: () => void;
} {
  const spy = spyOn(twoFactorAlert, "sendTwoFactorAlert").mockImplementation(() =>
    Promise.resolve({ sent: true }),
  );
  return {
    calls: () => spy.mock.calls.map(([input]) => input),
    restore: () => spy.mockRestore(),
  };
}

/** Audit rows of one action. */
function auditRows(action: string) {
  return db
    .select({
      actorId: auditEvents.actorId,
      outcome: auditEvents.outcome,
      targetType: auditEvents.targetType,
      targetId: auditEvents.targetId,
      metadata: auditEvents.metadata,
    })
    .from(auditEvents)
    .where(eq(auditEvents.action, action));
}

/* ─── Registration ─── */

describe("Adding a passkey (#223)", () => {
  test("needs the current password; the first passkey signs the other sessions out and makes this one mfa", async () => {
    const browser = await fullSession(ids.member);
    const other = await fullSession(ids.member);
    const alerts = spyAlerts();
    try {
      const wrong = await registrationOptions(browser.token, { password: "not it" });
      expect(wrong.status).toBe(400);
      expect(wrong.error).toBe("Current password is incorrect.");
      expect(wrong.options).toBeUndefined();

      const badName = await registrationOptions(browser.token, { name: "   " });
      expect(badName.status).toBe(400);
      expect(badName.error).toBe("Give the passkey a name.");

      const { options } = await registrationOptions(browser.token, {
        name: " Work laptop ",
      });
      if (!options) throw new Error("no options");
      expect(options.rp.id).toBe("localhost");
      expect(options.attestation).toBe("none");
      expect(options.authenticatorSelection?.residentKey).toBe("required");
      expect(options.authenticatorSelection?.userVerification).toBe("required");
      expect(options.excludeCredentials).toEqual([]);

      const authenticator = await TestAuthenticator.create(ORIGIN);
      const response = await finish(PAGE, await authenticator.register(options), {
        token: browser.token,
      });
      expect(response.status).toBe(302);
      expect(flashOf(response)).toBe(
        "Passkey added. You were signed out on every other device.",
      );

      const [row] = await passkeyRows(ids.member);
      expect(row?.name).toBe("Work laptop");
      expect(row?.credentialId).toBe(authenticator.credentialId);
      expect(row?.publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(row?.transports).toBe("hybrid,internal");
      expect(row?.counter).toBe(0);

      expect((await sessionRow(browser.id))?.assurance).toBe("mfa");
      expect(await sessionRow(other.id)).toBeUndefined();

      expect(alerts.calls().map((c) => [c.event, c.passkeyName])).toEqual([
        ["passkey_added", "Work laptop"],
      ]);
      const [audit] = await auditRows("auth.passkey.added");
      expect(audit?.actorId).toBe(ids.member);
      expect(audit?.targetType).toBe("passkey");
      expect(audit?.targetId).toBe(row?.id ?? "");
      expect(audit?.metadata).toEqual({ sessionsRevoked: 1 });
    } finally {
      alerts.restore();
    }
  });

  test("the challenge is bound to the session, single use, and the existing passkeys are excluded", async () => {
    const browser = await fullSession(ids.member, "mfa");
    const first = await addPasskey(browser.token);

    const { options } = await registrationOptions(browser.token, { name: "Second" });
    if (!options) throw new Error("no options");
    expect(options.excludeCredentials?.map((c) => c.id)).toEqual([first.credentialId]);

    const second = await TestAuthenticator.create(ORIGIN);
    const registration = await second.register(options);

    /** Another session of the same account cannot use this session's challenge. */
    const elsewhere = await fullSession(ids.member, "mfa");
    const stolen = await finish(PAGE, registration, { token: elsewhere.token });
    expect(flashOf(stolen)).toBe(
      "The passkey setup expired or was already used. Start again.",
    );

    const done = await finish(PAGE, registration, { token: browser.token });
    expect(flashOf(done)).toBe("Passkey added.");
    /** A replay of the same response: the challenge is spent. */
    const replay = await finish(PAGE, registration, { token: browser.token });
    expect(flashOf(replay)).toBe(
      "The passkey setup expired or was already used. Start again.",
    );
    expect(await passkeyRows(ids.member)).toHaveLength(2);
    /** Not the first second factor: other sessions are kept. */
    expect(await sessionRow(elsewhere.id)).toBeDefined();
  });

  test("a registration from another origin or for another RP ID is refused, and spends the challenge", async () => {
    const browser = await fullSession(ids.member);
    for (const overrides of [
      { origin: "https://evil.example" },
      { rpID: "evil.example" },
    ]) {
      const { options } = await registrationOptions(browser.token);
      if (!options) throw new Error("no options");
      const authenticator = await TestAuthenticator.create(ORIGIN);
      const registration = await authenticator.register(options, overrides);
      const response = await finish(PAGE, registration, { token: browser.token });
      expect(flashOf(response)).toBe("The passkey could not be verified. Start again.");
    }
    expect(await passkeyRows(ids.member)).toHaveLength(0);
  });

  test("passkeys are off without APP_BASE_URL: the page says so and the options are refused", async () => {
    expect(Reflect.set(config, "appBaseUrl", "")).toBe(true);
    const browser = await fullSession(ids.member);
    const page = await call("GET", PAGE, { token: browser.token });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Passkeys are switched off on this server");
    const options = await registrationOptions(browser.token);
    expect(options.status).toBe(404);
    const login = await call("GET", "/dashboard/login");
    expect(await login.text()).not.toContain("Sign in with a passkey");
  });
});

/* ─── Passwordless sign-in ─── */

describe("Passwordless sign-in (#223)", () => {
  test("register, then a passkey alone opens an mfa session bound to it", async () => {
    const browser = await fullSession(ids.admin);
    const authenticator = await addPasskey(browser.token);
    const login = await call("GET", "/dashboard/login");
    expect(await login.text()).toContain("Sign in with a passkey");

    const { options, wa } = await signInOptions();
    expect(options.rpId).toBe("localhost");
    expect(options.userVerification).toBe("required");
    /** Discoverable: no account named, nothing typed. */
    expect(options.allowCredentials ?? []).toEqual([]);

    const response = await finish(
      "/dashboard/login/passkey",
      await authenticator.assert(options),
      { wa },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/dashboard");
    const token = sessionCookieOf(response);
    expect(response.headers.getSetCookie().some((c) => c.startsWith("bm_wa=;"))).toBe(
      true,
    );
    const live = await liveSessionOf(token);
    expect(live?.assurance).toBe("mfa");
    expect(live?.userId).toBe(ids.admin);
    const [row] = await passkeyRows(ids.admin);
    const session = live ? await sessionRow(live.sessionId) : undefined;
    expect(session?.authMethod).toBe("passkey");
    expect(session?.credentialId).toBe(row?.id ?? "");
    expect(row?.lastUsedAt).not.toBeNull();

    const [audit] = await auditRows("auth.login.succeeded");
    expect(audit?.metadata).toEqual({ method: "passkey" });

    /** Removing the passkey ends the sessions it opened (they are bound to it). */
    const removed = await call("POST", `${PAGE}/${row?.id ?? ""}/delete`, {
      token: browser.token,
      body: { password: PASSWORD },
    });
    expect(flashOf(removed)).toBe("Passkey removed.");
    expect(await liveSessionOf(token)).toBeNull();
  });

  test("a wrong origin, a wrong RP ID, a bad signature and no user verification are each refused", async () => {
    const browser = await fullSession(ids.member);
    const authenticator = await addPasskey(browser.token);
    const cases: CeremonyOverrides[] = [
      { origin: "https://evil.example" },
      { origin: "http://localhost:8080" },
      { rpID: "evil.example" },
      { badSignature: true },
      { userVerified: false },
      { userHandle: "dXNyX25vdF90aGlz" },
      { userHandle: null },
    ];
    for (const overrides of cases) {
      const response = await passwordless(authenticator, overrides);
      expect(`${JSON.stringify(overrides)} ${response.headers.get("location")}`).toBe(
        `${JSON.stringify(overrides)} /dashboard/login?error=passkey`,
      );
      expect(
        response.headers.getSetCookie().some((c) => c.startsWith("bm_session=")),
      ).toBe(false);
    }
    /** The same authenticator, untouched, still works. */
    const ok = await passwordless(authenticator);
    expect(ok.headers.get("location")).toBe("/dashboard");
  });

  test("a replayed challenge and an expired challenge are refused", async () => {
    const browser = await fullSession(ids.member);
    const authenticator = await addPasskey(browser.token);

    const { options, wa } = await signInOptions();
    const assertion = await authenticator.assert(options);
    const first = await finish("/dashboard/login/passkey", assertion, { wa });
    expect(first.headers.get("location")).toBe("/dashboard");
    const replay = await finish("/dashboard/login/passkey", assertion, { wa });
    expect(replay.headers.get("location")).toBe("/dashboard/login?error=passkey");
    /** A fresh signature over the spent challenge is refused too. */
    const resigned = await finish(
      "/dashboard/login/passkey",
      await authenticator.assert(options),
      { wa },
    );
    expect(resigned.headers.get("location")).toBe("/dashboard/login?error=passkey");

    const late = await signInOptions();
    setSystemTime(new Date(Date.now() + 5 * 60 * 1000 + 1000));
    const expired = await finish(
      "/dashboard/login/passkey",
      await authenticator.assert(late.options),
      { wa: late.wa },
    );
    expect(expired.headers.get("location")).toBe("/dashboard/login?error=passkey");
  });

  test("an unknown credential gets the generic error and a warn line with the IP, never an account", async () => {
    const browser = await fullSession(ids.member);
    await addPasskey(browser.token);
    const stranger = await TestAuthenticator.create(ORIGIN);
    stranger.userHandle = Buffer.from(ids.member).toString("base64url");
    const warn = spyOn(logger, "warn");
    try {
      const response = await passwordless(stranger, {}, "203.0.113.7");
      expect(response.headers.get("location")).toBe("/dashboard/login?error=passkey");
      expect(warn).toHaveBeenCalledWith("Passkey sign-in failed", {
        ip: "203.0.113.7",
        reason: "unknown_credential",
      });
    } finally {
      warn.mockRestore();
    }
    const page = await call("GET", "/dashboard/login?error=passkey");
    expect(await page.text()).toContain(
      "That passkey could not sign you in. Try again, or use your password.",
    );
    const [audit] = await auditRows("auth.login.failed");
    expect(audit?.actorId).toBeNull();
    expect(audit?.metadata).toEqual({ step: "passkey", reason: "unknown_passkey" });
  });

  test("a deactivated account is refused", async () => {
    const browser = await fullSession(ids.member);
    const authenticator = await addPasskey(browser.token);
    await db
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.id, ids.member));
    const response = await passwordless(authenticator);
    expect(response.headers.get("location")).toBe("/dashboard/login?error=passkey");
  });

  test("each start counts against the client's login budget; a success gives its own back", async () => {
    const browser = await fullSession(ids.member);
    const authenticator = await addPasskey(browser.token);
    const ip = "198.51.100.9";
    const { maxAttempts } = config.dashboard.loginRateLimit;
    expect((await passwordless(authenticator, {}, ip)).headers.get("location")).toBe(
      "/dashboard",
    );
    for (let i = 0; i < maxAttempts; i++) {
      await passwordless(authenticator, { badSignature: true }, ip);
    }
    const blocked = await call("POST", "/dashboard/login/passkey/options", { ip });
    expect(blocked.status).toBe(429);
    const body = await readJson<{ error: string }>(blocked);
    expect(body.error).toStartWith("Too many failed attempts.");
  });

  test("a cross-origin options request and a cross-origin finish are refused", async () => {
    const options = await call("POST", "/dashboard/login/passkey/options", {
      origin: "https://evil.example",
    });
    expect(options.status).toBe(403);
    const response = await call("POST", "/dashboard/login/passkey", {
      origin: "https://evil.example",
      body: { credential: "{}" },
    });
    expect(response.status).toBe(403);
  });
});

/* ─── Clone detection ─── */

describe("Signature counter (#223)", () => {
  test("a counter that does not increase is refused, emailed and recorded; counters that stay 0 are fine", async () => {
    const browser = await fullSession(ids.member);
    const counting = await addPasskey(browser.token, {
      counter: 1,
      name: "Security key",
    });
    const counterless = await addPasskey(browser.token, { name: "Phone" });

    expect((await passwordless(counting)).headers.get("location")).toBe("/dashboard");
    expect((await passwordless(counting)).headers.get("location")).toBe("/dashboard");
    const rows = await passkeyRows(ids.member);
    expect(rows.find((r) => r.name === "Security key")?.counter).toBe(3);

    /** Counter-less platform passkeys: 0 every time, accepted every time. */
    expect((await passwordless(counterless)).headers.get("location")).toBe("/dashboard");
    expect((await passwordless(counterless)).headers.get("location")).toBe("/dashboard");

    const alerts = spyAlerts();
    const warn = spyOn(logger, "warn");
    try {
      for (const counter of [3, 2]) {
        const response = await passwordless(counting, { counter }, "192.0.2.10");
        expect(response.headers.get("location")).toBe("/dashboard/login?error=passkey");
      }
      const key = rows.find((r) => r.name === "Security key");
      expect(alerts.calls().map((c) => [c.event, c.passkeyName, c.userId])).toEqual([
        ["passkey_counter_regressed", "Security key", ids.member],
        ["passkey_counter_regressed", "Security key", ids.member],
      ]);
      expect(warn).toHaveBeenCalledWith(
        "Passkey refused: signature counter did not increase (possible clone)",
        { userId: ids.member, passkeyId: key?.id ?? "", ip: "192.0.2.10" },
      );
      const audits = await auditRows("auth.passkey.counter_regressed");
      expect(audits).toHaveLength(2);
      expect(audits.map((a) => [a.outcome, a.targetId, a.metadata])).toEqual(
        expect.arrayContaining([
          ["failure", key?.id ?? "", { storedCounter: 3, receivedCounter: 3 }],
          ["failure", key?.id ?? "", { storedCounter: 3, receivedCounter: 2 }],
        ]),
      );
      /** Nothing was stored from the refused assertions. */
      expect(
        (await passkeyRows(ids.member)).find((r) => r.name === "Security key")?.counter,
      ).toBe(3);
    } finally {
      alerts.restore();
      warn.mockRestore();
    }
    /** The real key, counting on, still works. */
    expect((await passwordless(counting, { counter: 4 })).headers.get("location")).toBe(
      "/dashboard",
    );
  });
});

/* ─── Second factor ─── */

describe("The second login step with a passkey (#223)", () => {
  /** The password step for an account with a second factor: the pending token. */
  async function pendingLogin(email: string): Promise<string> {
    const response = await call("POST", "/dashboard/login", {
      body: { email, password: PASSWORD },
    });
    expect(response.headers.get("location")).toBe(SECOND_STEP);
    return sessionCookieOf(response);
  }

  /** Second-step options for a pending session. */
  async function secondStepOptions(
    pending: string,
  ): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const response = await call("POST", `${SECOND_STEP}/passkey/options`, {
      token: pending,
    });
    expect(response.status).toBe(200);
    return (await readJson<{ options: PublicKeyCredentialRequestOptionsJSON }>(response))
      .options;
  }

  test("a passkey-only account: password, then the passkey, gives an mfa session", async () => {
    const browser = await fullSession(ids.owner);
    const authenticator = await addPasskey(browser.token);

    const pending = await pendingLogin(OWNER);
    const page = await call("GET", SECOND_STEP, { token: pending });
    const html = await page.text();
    expect(html).toContain("Use a passkey");
    expect(html).not.toContain('name="code"');

    const options = await secondStepOptions(pending);
    expect(options.allowCredentials?.map((c) => c.id)).toEqual([
      authenticator.credentialId,
    ]);
    expect(options.userVerification).toBe("required");

    const response = await finish(
      `${SECOND_STEP}/passkey`,
      await authenticator.assert(options),
      { token: pending },
    );
    expect(response.headers.get("location")).toBe("/dashboard");
    const token = sessionCookieOf(response);
    expect(token).not.toBe(pending);
    expect((await liveSessionOf(token))?.assurance).toBe("mfa");
    /** The pending token is dead. */
    expect(await sessionService.findPendingSession(pending)).toBeNull();
    const [audit] = await auditRows("auth.login.succeeded");
    expect(audit?.metadata).toEqual({ method: "passkey" });
  });

  test("another account's passkey, a replay and a bad signature fail; the budget then ends the pending session", async () => {
    const owner = await fullSession(ids.owner);
    const ownerKey = await addPasskey(owner.token);
    const member = await fullSession(ids.member);
    await addPasskey(member.token);

    const pending = await pendingLogin(MEMBER);
    const options = await secondStepOptions(pending);
    /** The owner's passkey does not complete the member's sign-in. */
    const foreign = await finish(
      `${SECOND_STEP}/passkey`,
      await ownerKey.assert(options),
      {
        token: pending,
      },
    );
    expect(foreign.status).toBe(200);
    expect(await foreign.text()).toContain("That passkey was not accepted. Try again.");

    for (let i = 1; i < 5; i++) {
      const again = await secondStepOptions(pending);
      const response = await finish(
        `${SECOND_STEP}/passkey`,
        await ownerKey.assert(again),
        { token: pending },
      );
      if (i < 4) expect(response.status).toBe(200);
      else
        expect(response.headers.get("location")).toBe(
          "/dashboard/login?error=two_factor_locked",
        );
    }
    expect(await sessionService.findPendingSession(pending)).toBeNull();
  });
});

/* ─── Policy ─── */

describe("Passkeys as a second factor in the policy (#223)", () => {
  test("a password session is refused once the account has a passkey", async () => {
    const browser = await fullSession(ids.member);
    await addPasskey(browser.token);
    const late = await fullSession(ids.member, "password");
    expect(await liveSessionOf(late.token)).toBeNull();
    const response = await call("GET", "/dashboard/emails", { token: late.token });
    expect(response.headers.get("location")).toBe("/dashboard/login");
    /** The password step now asks for the second factor. */
    const login = await call("POST", "/dashboard/login", {
      body: { email: MEMBER, password: PASSWORD },
    });
    expect(login.headers.get("location")).toBe(SECOND_STEP);
  });

  test("REQUIRE_2FA: the Passkeys page stays open, and a passkey satisfies the policy", async () => {
    expect(Reflect.set(config.dashboard, "require2fa", "admin")).toBe(true);
    const browser = await fullSession(ids.admin);
    const held = await call("GET", "/dashboard/emails", { token: browser.token });
    expect(held.headers.get("location")).toBe(TWO_FACTOR_PAGE);
    const page = await call("GET", PAGE, { token: browser.token });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Your role requires a second factor");

    const authenticator = await addPasskey(browser.token);
    const open = await call("GET", "/dashboard/emails", { token: browser.token });
    expect(open.status).toBe(200);

    /** A passwordless session satisfies it too. */
    const response = await passwordless(authenticator);
    const token = sessionCookieOf(response);
    expect((await call("GET", "/dashboard/emails", { token })).status).toBe(200);
  });

  test("a completed reset link removes the passkeys, and the email and audit row say so", async () => {
    const browser = await fullSession(ids.member);
    const authenticator = await addPasskey(browser.token);
    await addPasskey(browser.token, { name: "Second" });
    const issued = await issuePasswordReset(ids.admin, ids.member);
    if (!issued.ok) throw new Error(issued.reason);
    const alerts = spyAlerts();
    try {
      const response = await call("POST", "/dashboard/reset", {
        body: {
          token: new URL(issued.url).searchParams.get("token") ?? "",
          password: NEW_PASSWORD,
          confirm: NEW_PASSWORD,
        },
      });
      expect(response.headers.get("location")).toBe("/dashboard");
      expect(await passkeyRows(ids.member)).toHaveLength(0);
      expect(alerts.calls().map((c) => [c.event, c.removed])).toEqual([
        ["removed_by_reset", { totp: false, passkeys: 2 }],
      ]);
      const [audit] = await auditRows("auth.two_factor.removed");
      expect(audit?.metadata).toEqual({
        via: "password_reset",
        totp: false,
        passkeys: 2,
      });
    } finally {
      alerts.restore();
    }
    expect((await passwordless(authenticator)).headers.get("location")).toBe(
      "/dashboard/login?error=passkey",
    );
  });
});

/* ─── Managing ─── */

describe("Managing passkeys (#223)", () => {
  test("the page lists name, added and last used; rename; remove needs the password", async () => {
    const browser = await fullSession(ids.member, "mfa");
    await addPasskey(browser.token, { name: "<b>Laptop</b>" });
    const [row] = await passkeyRows(ids.member);
    const id = row?.id ?? "";

    const page = await (await call("GET", PAGE, { token: browser.token })).text();
    expect(page).toContain(">&lt;b&gt;Laptop&lt;/b&gt;</p>");
    expect(page).not.toContain("<b>Laptop</b></p>");
    /** In the rename field's value only `"` matters, and it is escaped. */
    expect(page).toContain('value="<b>Laptop</b>"');
    expect(page).toContain("Last used");

    const renamed = await call("POST", `${PAGE}/${id}/rename`, {
      token: browser.token,
      body: { name: "Desk key" },
    });
    expect(flashOf(renamed)).toBe("Passkey renamed.");
    const tooLong = await call("POST", `${PAGE}/${id}/rename`, {
      token: browser.token,
      body: { name: "x".repeat(65) },
    });
    expect(flashOf(tooLong)).toBe("The name can be at most 64 characters.");
    expect((await passkeyRows(ids.member))[0]?.name).toBe("Desk key");

    const alerts = spyAlerts();
    try {
      const wrong = await call("POST", `${PAGE}/${id}/delete`, {
        token: browser.token,
        body: { password: "not the password" },
      });
      expect(flashOf(wrong)).toBe("Current password is incorrect.");
      expect(await passkeyRows(ids.member)).toHaveLength(1);

      const removed = await call("POST", `${PAGE}/${id}/delete`, {
        token: browser.token,
        body: { password: PASSWORD },
      });
      expect(flashOf(removed)).toBe("Passkey removed.");
      expect(await passkeyRows(ids.member)).toHaveLength(0);
      expect(alerts.calls().map((c) => [c.event, c.passkeyName])).toEqual([
        ["passkey_removed", "Desk key"],
      ]);
      const [audit] = await auditRows("auth.passkey.removed");
      expect(audit?.targetId).toBe(id);
    } finally {
      alerts.restore();
    }
  });

  test("a member manages only their own passkeys", async () => {
    const owner = await fullSession(ids.owner, "mfa");
    await addPasskey(owner.token, { name: "Owner key" });
    const [ownerRow] = await passkeyRows(ids.owner);
    const id = ownerRow?.id ?? "";
    const member = await fullSession(ids.member);

    const rename = await call("POST", `${PAGE}/${id}/rename`, {
      token: member.token,
      body: { name: "Mine now" },
    });
    expect(flashOf(rename)).toBe("That passkey was not found: nothing was changed.");
    const remove = await call("POST", `${PAGE}/${id}/delete`, {
      token: member.token,
      body: { password: PASSWORD },
    });
    expect(flashOf(remove)).toBe("That passkey was not found: nothing was changed.");
    const page = await (await call("GET", PAGE, { token: member.token })).text();
    expect(page).not.toContain("Owner key");
    expect((await passkeyRows(ids.owner))[0]?.name).toBe("Owner key");
  });
});
