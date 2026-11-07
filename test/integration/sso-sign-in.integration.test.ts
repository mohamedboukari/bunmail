/**
 * SSO sign-in (#224, part 3), through the real `pagesPlugin` over HTTP
 * against real Postgres and an in-process OpenID Connect provider
 * (`test/fixtures/fake-oidc-provider.ts`): the real `oauth4webapi` code
 * path, real tokens, real signatures. Nothing reaches a real provider.
 *
 * - The login page: one escaped "Sign in with <label>" button per
 *   provider while SSO is on, none otherwise.
 * - The start: same-origin only, the per-IP limiter checked, the `bm_sso`
 *   cookie (`purpose=login`) and a redirect to the provider.
 * - The round trip: an account without a second factor gets a
 *   `password`-level session bound to the link (`auth_method = 'oauth'`),
 *   its `last_used_at`, the new-device check and `auth.login.succeeded`;
 *   one with a second factor gets a `pending` session, then the existing
 *   second step, then `mfa`.
 * - Refusals, each audited (`auth.login.failed`, `step: "sso"`): the owner
 *   without a second factor, an unknown identity (never matched by email),
 *   a disabled account, a replayed callback.
 * - The per-IP limiter: a failed callback counts, a success nets zero, an
 *   address over budget is refused at the start and at the callback.
 * - The browser's previous session is replaced; unlinking ends the
 *   sessions the identity opened.
 * - No code, state, subject, provider email or token in a log line or an
 *   audit row.
 */
import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  spyOn,
} from "bun:test";
import { Elysia } from "elysia";
import { html } from "@elysiajs/html";
import { and, eq } from "drizzle-orm";
import { db, seed, sessions, truncateAll } from "./_helpers.ts";
import { FakeOidcProvider } from "../fixtures/fake-oidc-provider.ts";
import { handoffTargetOf } from "../fixtures/sso-handoff.ts";
import { pagesPlugin } from "../../src/pages/pages.plugin.tsx";
import { withRequestContext } from "../../src/middleware/request-context.ts";
import { readSessionCookie, readSsoFlowCookie } from "../../src/pages/session.ts";
import { loginAttemptMap } from "../../src/middleware/login-rate-limit.ts";
import { userCredentials } from "../../src/modules/users/models/user-credential.schema.ts";
import { auditEvents } from "../../src/modules/audit/models/audit-event.schema.ts";
import { users } from "../../src/modules/users/models/user.schema.ts";
import * as twoFactorAlert from "../../src/modules/users/services/two-factor-alert.service.ts";
import * as signInDevice from "../../src/modules/users/services/sign-in-device.service.ts";
import * as totp from "../../src/modules/users/services/totp.service.ts";
import { clearSsoDiscoveryCache } from "../../src/modules/users/services/sso-discovery.service.ts";
import { ssoFlowPurposeOf } from "../../src/modules/users/services/sso-flow-cookie.service.ts";
import { startSsoFlow } from "../../src/modules/users/services/sso.service.ts";
import { encryptSecret } from "../../src/utils/crypto.ts";
import { generateId } from "../../src/utils/id.ts";
import { logger } from "../../src/utils/logger.ts";
import { config, type SsoProviderSettings } from "../../src/config.ts";

/** With the request context, as `src/index.ts` mounts it. */
const app = new Elysia().wrap(withRequestContext).use(html()).use(pagesPlugin);

const ORIGIN = "http://localhost";
const PASSWORD = "the account password, long enough";
const CALLBACK = "/dashboard/login/sso/corp/callback";

const originalSso = config.sso;
const originalLimit = config.dashboard.loginRateLimit;
let idp: FakeOidcProvider;
let provider: SsoProviderSettings;
const ids = { owner: "", member: "" };
let alerts: ReturnType<typeof spyOn<typeof twoFactorAlert, "sendTwoFactorAlert">>;
let deviceChecks: ReturnType<typeof spyOn<typeof signInDevice, "recognizeSignInDevice">>;

beforeAll(async () => {
  idp = await FakeOidcProvider.start();
  provider = {
    id: "corp",
    issuer: idp.url,
    clientId: idp.clientId,
    clientSecret: idp.clientSecret,
    label: "Corp SSO",
    scopes: "openid email profile",
    allowedDomains: [],
    autoLink: false,
  };
});

afterAll(async () => {
  await idp.stop();
});

beforeEach(async () => {
  expect(Reflect.set(config, "sso", { providers: [provider], baseUrl: ORIGIN })).toBe(
    true,
  );
  expect(
    Reflect.set(config.dashboard, "loginRateLimit", {
      enabled: true,
      maxAttempts: 5,
      windowSec: 900,
    }),
  ).toBe(true);
  clearSsoDiscoveryCache();
  idp.claimOverrides = {};
  idp.hits.clear();
  loginAttemptMap.clear();
  alerts = spyOn(twoFactorAlert, "sendTwoFactorAlert").mockImplementation(() =>
    Promise.resolve({ sent: true }),
  );
  deviceChecks = spyOn(signInDevice, "recognizeSignInDevice").mockImplementation(() =>
    Promise.resolve(),
  );
  await truncateAll();
  ids.owner = (
    await seed.user({ email: "owner@example.com", role: "owner", password: PASSWORD })
  ).id;
  ids.member = (await seed.user({ email: "member@example.com", password: PASSWORD })).id;
});

afterEach(() => {
  alerts.mockRestore();
  deviceChecks.mockRestore();
  expect(Reflect.set(config, "sso", originalSso)).toBe(true);
  expect(Reflect.set(config.dashboard, "loginRateLimit", originalLimit)).toBe(true);
});

/* ─── Helpers ─── */

/** A request with optional cookies; POSTs are same-origin unless told otherwise. */
function call(
  method: "GET" | "POST",
  path: string,
  opts: {
    token?: string;
    flow?: string;
    body?: Record<string, string>;
    origin?: string;
    /** `Sec-Fetch-Dest` as a browser sends it (none by default). */
    dest?: string;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.dest) headers["sec-fetch-dest"] = opts.dest;
  const cookies: string[] = [];
  if (opts.token) cookies.push(`bm_session=${opts.token}`);
  if (opts.flow) cookies.push(`bm_sso=${opts.flow}`);
  if (cookies.length > 0) headers["cookie"] = cookies.join("; ");
  const url = `${ORIGIN}${path}`;
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

/** The `bm_sso` value a response sets (not a clearing one), or `undefined`. */
function flowCookieOf(response: Response): string | undefined {
  const cookie = response.headers.getSetCookie().find((c) => c.startsWith("bm_sso="));
  return readSsoFlowCookie(cookie ?? null);
}

/** The `bm_session` value a response sets, or `undefined`. */
function sessionCookieOf(response: Response): string | undefined {
  const cookie = response.headers.getSetCookie().find((c) => c.startsWith("bm_session="));
  const token = readSessionCookie(cookie ?? null);
  return token === "" ? undefined : token;
}

/** Clicks "Sign in with Corp SSO": the provider URL and the flow cookie. */
async function startSignIn(): Promise<{
  response: Response;
  location: string;
  flow: string | undefined;
}> {
  const response = await call("POST", "/dashboard/login/sso/corp");
  return {
    response,
    location:
      response.status === 200 ? handoffTargetOf(response, await response.text()) : "",
    flow: flowCookieOf(response),
  };
}

/** The callback for a provider URL, as the browser would follow it. */
function callback(
  location: string,
  opts: {
    token?: string;
    flow?: string;
    dest?: string;
    mutate?: (p: URLSearchParams) => void;
  } = {},
): Promise<Response> {
  const params = idp.issueCode(location);
  opts.mutate?.(params);
  return call("GET", `${CALLBACK}?${params.toString()}`, opts);
}

/** A full sign-in: start, provider, callback. */
async function signIn(opts: { token?: string } = {}): Promise<Response> {
  const started = await startSignIn();
  expect(started.response.status).toBe(200);
  return callback(started.location, { ...opts, flow: started.flow });
}

/** Inserts an SSO link row directly (the link flow is covered by `sso-links`). */
async function insertLink(userId: string, sub: string = "user-123"): Promise<string> {
  const id = generateId("crd");
  await db.insert(userCredentials).values({
    id,
    userId,
    type: "oauth",
    provider: `oidc:${idp.url}`,
    providerAccountId: sub,
    name: "alice@example.com",
  });
  return id;
}

/** Gives an account a confirmed TOTP second factor; returns its key. */
async function addTotp(userId: string): Promise<Buffer> {
  const secret = totp.generateTotpSecret();
  await db.insert(userCredentials).values({
    id: generateId("crd"),
    userId,
    type: "totp",
    secretHash: encryptSecret(secret, config.dkimEncryptionKey),
  });
  const key = totp.base32Decode(secret);
  if (!key) throw new Error("bad secret");
  return key;
}

/** Every session row of an account. */
function sessionsOf(userId: string) {
  return db
    .select({
      id: sessions.id,
      assurance: sessions.assurance,
      authMethod: sessions.authMethod,
      credentialId: sessions.credentialId,
    })
    .from(sessions)
    .where(eq(sessions.userId, userId));
}

/** Audit rows of one action, oldest first. */
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
    .where(eq(auditEvents.action, action))
    .orderBy(auditEvents.occurredAt, auditEvents.id);
}

/**
 * The client's count on the login limiter. Requests here have no socket,
 * so the address resolves to `unknown`, its own bucket.
 */
function ipAttempts(): number {
  return loginAttemptMap.get("unknown")?.count ?? 0;
}

/** The client's count on the SSO start budget (`sso-start:ip:<bucket>`). */
function startAttempts(): number {
  return loginAttemptMap.get("sso-start:ip:unknown")?.count ?? 0;
}

/** A sealed login flow for the fake provider, without the start route. */
async function mintedFlow(): Promise<{ location: string; flow: string }> {
  const started = await startSsoFlow({ provider, baseUrl: ORIGIN, purpose: "login" });
  if (!started.ok) throw new Error("start failed");
  return { location: started.authorizationUrl, flow: started.flowCookie };
}

/* ─── The login page and the start ─── */

describe("the login page and the start (#224)", () => {
  test("one escaped button per provider while SSO is on; none when it is off", async () => {
    expect(
      Reflect.set(config, "sso", {
        providers: [{ ...provider, label: "<b>Corp</b>" }],
        baseUrl: ORIGIN,
      }),
    ).toBe(true);
    const page = await (await call("GET", "/dashboard/login")).text();
    expect(page).toContain('action="/dashboard/login/sso/corp"');
    expect(page).toContain("Sign in with &lt;b&gt;Corp&lt;/b&gt;");
    expect(page).not.toContain("<b>Corp</b>");
    expect(page).not.toContain(idp.clientSecret);

    expect(Reflect.set(config, "sso", { providers: [provider], baseUrl: null })).toBe(
      true,
    );
    const off = await (await call("GET", "/dashboard/login")).text();
    expect(off).not.toContain("/dashboard/login/sso/");
  });

  test("the start: a login flow cookie and the provider's URL with the fixed redirect URI; not counted", async () => {
    const started = await startSignIn();
    /** A hand-off page, not a 302: CSP `form-action 'self'` blocks that redirect (#409). */
    expect(started.response.status).toBe(200);
    expect(started.response.headers.get("cache-control")).toBe("no-store");
    const url = new URL(started.location);
    expect(`${url.origin}${url.pathname}`).toBe(`${idp.url}/authorize`);
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}${CALLBACK}`);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(ssoFlowPurposeOf(started.flow)).toBe("login");
    const flowSetCookie = started.response.headers
      .getSetCookie()
      .find((c) => c.startsWith("bm_sso="));
    expect(flowSetCookie).toContain("SameSite=Lax");
    expect(flowSetCookie).toContain("HttpOnly");
    /** The login limiter is checked, not counted; the start budget counts one. */
    expect(ipAttempts()).toBe(0);
    expect(startAttempts()).toBe(1);
  });

  test("a cross-origin start is refused before anything else", async () => {
    const response = await call("POST", "/dashboard/login/sso/corp", {
      origin: "https://evil.example",
    });
    expect(response.status).toBe(403);
    expect(flowCookieOf(response)).toBeUndefined();
    expect(idp.hits.size).toBe(0);
  });

  test("an unknown provider, or SSO off: the login page's generic message, nothing called", async () => {
    const unknown = await call("POST", "/dashboard/login/sso/nope");
    expect(unknown.headers.get("location")).toBe("/dashboard/login?error=sso");
    expect(Reflect.set(config, "sso", { providers: [provider], baseUrl: null })).toBe(
      true,
    );
    const off = await call("POST", "/dashboard/login/sso/corp");
    expect(off.headers.get("location")).toBe("/dashboard/login?error=sso");
    expect(idp.hits.size).toBe(0);
  });
});

/* ─── The round trip ─── */

describe("signing in (#224)", () => {
  test("no second factor: a password-level oauth session bound to the link, audited, the new-device check run", async () => {
    const linkId = await insertLink(ids.member);
    const response = await signIn();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/dashboard");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const cookies = response.headers.getSetCookie();
    expect(cookies).toContain(
      "bm_sso=; HttpOnly; SameSite=Lax; Path=/dashboard; Max-Age=0",
    );
    expect(cookies.some((c) => c.startsWith("bm_device="))).toBe(true);

    const rows = await sessionsOf(ids.member);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      assurance: "password",
      authMethod: "oauth",
      credentialId: linkId,
    });
    const [link] = await db
      .select({ lastUsedAt: userCredentials.lastUsedAt })
      .from(userCredentials)
      .where(eq(userCredentials.id, linkId));
    expect(link?.lastUsedAt).toBeInstanceOf(Date);

    expect(await auditRows("auth.login.succeeded")).toEqual([
      {
        actorId: ids.member,
        outcome: "success",
        targetType: "session",
        targetId: rows[0]?.id ?? "",
        metadata: { method: "oauth", provider: "corp" },
      },
    ]);
    /** The alert names the provider (L3). */
    expect(
      deviceChecks.mock.calls.map(([event]) => [event.userId, event.ssoProvider]),
    ).toEqual([[ids.member, "Corp SSO"]]);

    /** The new session opens the dashboard. */
    const token = sessionCookieOf(response);
    expect(token).toBeDefined();
    const page = await call("GET", "/dashboard/account/sessions", { token: token ?? "" });
    expect(page.status).toBe(200);
    /** A success gives back the callback's attempt; the start counted none. */
    expect(ipAttempts()).toBe(0);
  });

  test("a second factor: pending, the second step, then mfa; the session stays bound to the link", async () => {
    const linkId = await insertLink(ids.member);
    const key = await addTotp(ids.member);
    const response = await signIn();
    expect(response.headers.get("location")).toBe("/dashboard/login/two-factor");
    const pending = sessionCookieOf(response) ?? "";
    expect((await sessionsOf(ids.member))[0]).toMatchObject({
      assurance: "pending",
      authMethod: "oauth",
      credentialId: linkId,
    });
    expect(
      (await auditRows("auth.login.two_factor_required")).map((r) => r.metadata),
    ).toEqual([{ method: "oauth", provider: "corp" }]);
    /** A pending session opens nothing, and no new-device check ran yet. */
    const blocked = await call("GET", "/dashboard", { token: pending });
    expect(blocked.headers.get("location")).toBe("/dashboard/login");
    expect(deviceChecks).not.toHaveBeenCalled();
    expect(
      await (await call("GET", "/dashboard/login/two-factor", { token: pending })).text(),
    ).toContain('name="code"');

    const done = await call("POST", "/dashboard/login/two-factor", {
      token: pending,
      body: { code: totp.totpCode(key, totp.totpStep(Date.now())) },
    });
    expect(done.headers.get("location")).toBe("/dashboard");
    expect((await sessionsOf(ids.member))[0]).toMatchObject({
      assurance: "mfa",
      authMethod: "oauth",
      credentialId: linkId,
    });
    expect((await auditRows("auth.login.succeeded")).map((r) => r.metadata)).toEqual([
      { method: "totp" },
    ]);
    expect(deviceChecks.mock.calls.map(([event]) => event.ssoProvider)).toEqual([
      "Corp SSO",
    ]);
  });

  test("the owner without a second factor is refused; with one, it gets the second step", async () => {
    await insertLink(ids.owner);
    const refused = await signIn();
    /** The same message as an unknown identity (L4); the audit keeps the reason. */
    expect(refused.headers.get("location")).toBe("/dashboard/login?error=sso_unlinked");
    expect(sessionCookieOf(refused)).toBeUndefined();
    expect(await sessionsOf(ids.owner)).toEqual([]);
    expect(
      (await auditRows("auth.login.failed")).map((r) => [
        r.actorId,
        r.outcome,
        r.metadata,
      ]),
    ).toEqual([
      [
        ids.owner,
        "failure",
        { step: "sso", reason: "owner_second_factor_required", provider: "corp" },
      ],
    ]);

    await addTotp(ids.owner);
    const pending = await signIn();
    expect(pending.headers.get("location")).toBe("/dashboard/login/two-factor");
    expect((await sessionsOf(ids.owner)).map((s) => s.assurance)).toEqual(["pending"]);
  });

  test("an unknown identity is refused with its own message, counted and audited, never matched by email", async () => {
    /** The provider says member@example.com, verified: there is still no link. */
    idp.claimOverrides = { email: "member@example.com", email_verified: true };
    const response = await signIn();
    expect(response.headers.get("location")).toBe("/dashboard/login?error=sso_unlinked");
    expect(await sessionsOf(ids.member)).toEqual([]);
    expect(
      (await auditRows("auth.login.failed")).map((r) => [r.actorId, r.metadata]),
    ).toEqual([[null, { step: "sso", reason: "unknown_identity", provider: "corp" }]]);
    expect(ipAttempts()).toBe(1);

    const page = await (await call("GET", "/dashboard/login?error=sso_unlinked")).text();
    expect(page).toContain(
      "This sign-in is not linked to a BunMail account. Sign in with your password and link it under Account.",
    );
  });

  test("a disabled account is refused and audited against it", async () => {
    await insertLink(ids.member);
    await db
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.id, ids.member));
    const response = await signIn();
    expect(response.headers.get("location")).toBe("/dashboard/login?error=sso_unlinked");
    expect(await sessionsOf(ids.member)).toEqual([]);
    expect(
      (await auditRows("auth.login.failed")).map((r) => [r.actorId, r.metadata]),
    ).toEqual([[ids.member, { step: "sso", reason: "deactivated", provider: "corp" }]]);
  });

  test("a replayed callback is refused without a second token request or session", async () => {
    await insertLink(ids.member);
    const started = await startSignIn();
    const params = idp.issueCode(started.location);
    const path = `${CALLBACK}?${params.toString()}`;
    const first = await call("GET", path, { flow: started.flow });
    expect(first.headers.get("location")).toBe("/dashboard");
    const replay = await call("GET", path, { flow: started.flow });
    expect(replay.headers.get("location")).toBe("/dashboard/login?error=sso");
    expect(idp.hitCount("/token")).toBe(1);
    expect(await sessionsOf(ids.member)).toHaveLength(1);
    expect((await auditRows("auth.login.failed")).map((r) => r.metadata)).toEqual([
      { step: "sso", reason: "flow_replayed", provider: "corp" },
    ]);
  });

  test("a forged state is refused before the token endpoint and audited", async () => {
    await insertLink(ids.member);
    const started = await startSignIn();
    const response = await callback(started.location, {
      flow: started.flow,
      mutate: (p) => p.set("state", "forged"),
    });
    expect(response.headers.get("location")).toBe("/dashboard/login?error=sso");
    expect(idp.hitCount("/token")).toBe(0);
    expect((await auditRows("auth.login.failed")).map((r) => r.metadata)).toEqual([
      { step: "sso", reason: "state_mismatch", provider: "corp" },
    ]);
  });

  test("the browser's previous session is replaced", async () => {
    await insertLink(ids.member);
    const previous = await seed.session({ userId: ids.owner });
    const response = await signIn({ token: previous.token });
    expect(response.headers.get("location")).toBe("/dashboard");
    expect(await sessionsOf(ids.owner)).toEqual([]);
    expect(await sessionsOf(ids.member)).toHaveLength(1);
  });

  test("a refused sign-in leaves the browser's session alone", async () => {
    const previous = await seed.session({ userId: ids.owner });
    const response = await signIn({ token: previous.token });
    expect(response.headers.get("location")).toBe("/dashboard/login?error=sso_unlinked");
    expect((await sessionsOf(ids.owner)).map((s) => s.id)).toEqual([previous.id]);
  });

  test("unlinking ends the session the identity opened", async () => {
    const linkId = await insertLink(ids.member);
    const viaSso = sessionCookieOf(await signIn()) ?? "";
    const other = await seed.session({ userId: ids.member });
    const unlinked = await call("POST", `/dashboard/account/sso/${linkId}/unlink`, {
      token: other.token,
      body: { password: PASSWORD },
    });
    expect(
      new URL(unlinked.headers.get("location") ?? "", ORIGIN).searchParams.get("flash"),
    ).toBe("Account unlinked.");
    expect((await sessionsOf(ids.member)).map((s) => s.id)).toEqual([other.id]);
    const gone = await call("GET", "/dashboard", { token: viaSso });
    expect(gone.headers.get("location")).toBe("/dashboard/login");
  });
});

/* ─── The limiter ─── */

describe("the per-IP limiter (#224)", () => {
  test("failed callbacks count; over budget the start and the callback are refused", async () => {
    expect(
      Reflect.set(config.dashboard, "loginRateLimit", {
        enabled: true,
        maxAttempts: 2,
        windowSec: 900,
      }),
    ).toBe(true);
    for (let i = 0; i < 2; i++) {
      const started = await startSignIn();
      await callback(started.location, {
        flow: started.flow,
        mutate: (p) => p.set("state", "wrong"),
      });
    }
    expect(ipAttempts()).toBe(2);

    const blockedStart = await call("POST", "/dashboard/login/sso/corp");
    expect(blockedStart.status).toBe(429);
    expect(flowCookieOf(blockedStart)).toBeUndefined();
    expect(await blockedStart.text()).toContain("Too many failed attempts");

    const hitsBefore = idp.hitCount("/token");
    const minted = await mintedFlow();
    const blockedCallback = await callback(minted.location, { flow: minted.flow });
    expect(blockedCallback.headers.get("location")).toBe(
      "/dashboard/login?error=rate_limited",
    );
    expect(idp.hitCount("/token")).toBe(hitsBefore);
    /** Recorded once per address and window. */
    expect(await auditRows("auth.login.rate_limited")).toHaveLength(1);
  });

  test("a success gives back only its own attempt", async () => {
    await insertLink(ids.member);
    const started = await startSignIn();
    await callback(started.location, {
      flow: started.flow,
      mutate: (p) => p.set("state", "wrong"),
    });
    expect(ipAttempts()).toBe(1);
    expect((await signIn()).headers.get("location")).toBe("/dashboard");
    expect(ipAttempts()).toBe(1);
  });

  test("no flow cookie, or an embedded request: refused at once, never counted or recorded (M1)", async () => {
    await insertLink(ids.member);
    /** What `<img src=".../callback">` on another site sends, many times over. */
    for (let i = 0; i < 10; i++) {
      const hit = await call("GET", `${CALLBACK}?code=x&state=y`, { dest: "image" });
      expect(hit.headers.get("location")).toBe("/dashboard/login?error=sso");
    }
    for (let i = 0; i < 10; i++) {
      const hit = await call("GET", `${CALLBACK}?code=x&state=y`);
      expect(hit.headers.get("location")).toBe("/dashboard/login?error=sso");
    }
    /** Even with a real flow cookie, an embedded request is not a callback. */
    const embedded = await mintedFlow();
    const refused = await callback(embedded.location, {
      flow: embedded.flow,
      dest: "image",
    });
    expect(refused.headers.get("location")).toBe("/dashboard/login?error=sso");
    expect(idp.hitCount("/token")).toBe(0);
    expect(ipAttempts()).toBe(0);
    expect(await auditRows("auth.login.failed")).toEqual([]);
    expect(await auditRows("auth.login.rate_limited")).toEqual([]);

    /** The visitor can still sign in, as a top-level navigation. */
    const started = await startSignIn();
    const response = await callback(started.location, {
      flow: started.flow,
      dest: "document",
    });
    expect(response.headers.get("location")).toBe("/dashboard");
  });

  test("the start has its own budget: 20 per address and window, never given back (L1)", async () => {
    await insertLink(ids.member);
    for (let i = 0; i < 20; i++) {
      expect((await startSignIn()).response.status).toBe(200);
    }
    const blocked = await startSignIn();
    expect(blocked.response.status).toBe(429);
    expect(blocked.flow).toBeUndefined();
    expect(await blocked.response.text()).toContain("Too many sign-in attempts");
    expect(startAttempts()).toBe(20);
    /** The login limiter was not touched by the starts. */
    expect(ipAttempts()).toBe(0);
    expect(await auditRows("auth.login.rate_limited")).toHaveLength(1);
  });
});

/* ─── Nothing secret is kept ─── */

describe("no secret in logs or audit rows (#224)", () => {
  test("neither the code, the state, the subject, the provider email nor a token", async () => {
    const lines: unknown[][] = [];
    const spies = (["debug", "info", "warn", "error"] as const).map((level) =>
      spyOn(logger, level).mockImplementation((...args: unknown[]) => {
        lines.push(args);
      }),
    );
    try {
      await insertLink(ids.member);
      const started = await startSignIn();
      const params = idp.issueCode(started.location);
      await call("GET", `${CALLBACK}?${params.toString()}`, { flow: started.flow });
      /** A refusal after the round trip too. */
      await db
        .delete(userCredentials)
        .where(
          and(eq(userCredentials.userId, ids.member), eq(userCredentials.type, "oauth")),
        );
      const second = await startSignIn();
      const secondParams = idp.issueCode(second.location);
      await call("GET", `${CALLBACK}?${secondParams.toString()}`, { flow: second.flow });

      const logged = JSON.stringify(lines);
      const audited = JSON.stringify(
        await db
          .select({
            actorLabel: auditEvents.actorLabel,
            targetLabel: auditEvents.targetLabel,
            metadata: auditEvents.metadata,
          })
          .from(auditEvents),
      );
      for (const secret of [
        params.get("code") ?? "missing",
        params.get("state") ?? "missing",
        secondParams.get("code") ?? "missing",
        "user-123",
        "alice@example.com",
        "Alice@Example.com",
        "fake-access-token",
        idp.clientSecret,
        started.flow ?? "missing",
      ]) {
        expect(logged).not.toContain(secret);
        expect(audited).not.toContain(secret);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
