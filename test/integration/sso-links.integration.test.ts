/**
 * SSO links (#224, part 2), through the real `pagesPlugin` over HTTP
 * against real Postgres and an in-process OpenID Connect provider
 * (`test/fixtures/fake-oidc-provider.ts`): the real `oauth4webapi` code
 * path, real tokens, real signatures. Nothing reaches a real provider.
 *
 * - Migration `0040`: `user_credentials.provider` is varchar(255) and the
 *   partial unique index `user_credentials_one_oauth_per_provider` holds.
 * - Linking: the current password first (audited when wrong), then the
 *   provider round trip, then a row keyed by `(oidc:<issuer>, sub)` with
 *   the provider email as its name and no secret; the security email and
 *   `auth.sso.linked`.
 * - Refusals: the owner without a second factor, one link per provider,
 *   an identity linked to another account, a session that changed, a
 *   sign-in flow, a replayed callback.
 * - Unlinking: the password (a wrong one audited), the sessions the
 *   identity opened end with it, only one's own link.
 * - The owner rule kept true afterwards: the owner's last second factor
 *   cannot be removed while it has a link, and ownership cannot go to an
 *   account with a link and no second factor.
 * - A failed round trip with a live session is audited (`flow_failed`).
 * - The page escapes the stored name; the sidebar keeps Sign-in methods
 *   for an account with a link even without configured providers.
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
import { and, eq, sql } from "drizzle-orm";
import { db, seed, sessions, truncateAll } from "./_helpers.ts";
import { FakeOidcProvider } from "../fixtures/fake-oidc-provider.ts";
import { pagesPlugin } from "../../src/pages/pages.plugin.tsx";
import { withRequestContext } from "../../src/middleware/request-context.ts";
import { readSsoFlowCookie } from "../../src/pages/session.ts";
import { loginAttemptMap } from "../../src/middleware/login-rate-limit.ts";
import { userCredentials } from "../../src/modules/users/models/user-credential.schema.ts";
import { auditEvents } from "../../src/modules/audit/models/audit-event.schema.ts";
import { users } from "../../src/modules/users/models/user.schema.ts";
import * as twoFactorAlert from "../../src/modules/users/services/two-factor-alert.service.ts";
import { clearSsoDiscoveryCache } from "../../src/modules/users/services/sso-discovery.service.ts";
import { startSsoFlow } from "../../src/modules/users/services/sso.service.ts";
import { generateId } from "../../src/utils/id.ts";
import { config, type SsoProviderSettings } from "../../src/config.ts";

/** With the request context, so the sidebar knows its viewer (the Sign-in methods link). */
const app = new Elysia().wrap(withRequestContext).use(html()).use(pagesPlugin);

const ORIGIN = "http://localhost";
const PASSWORD = "the account password, long enough";
const PAGE = "/dashboard/account/sso";

const originalSso = config.sso;
let idp: FakeOidcProvider;
let provider: SsoProviderSettings;
const ids = { owner: "", member: "", other: "" };
let alerts: ReturnType<typeof spyOn<typeof twoFactorAlert, "sendTwoFactorAlert">>;

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
  clearSsoDiscoveryCache();
  idp.claimOverrides = {};
  idp.hits.clear();
  loginAttemptMap.clear();
  alerts = spyOn(twoFactorAlert, "sendTwoFactorAlert").mockImplementation(() =>
    Promise.resolve({ sent: true }),
  );
  await truncateAll();
  ids.owner = (
    await seed.user({ email: "owner@example.com", role: "owner", password: PASSWORD })
  ).id;
  ids.member = (await seed.user({ email: "member@example.com", password: PASSWORD })).id;
  ids.other = (await seed.user({ email: "other@example.com", password: PASSWORD })).id;
});

afterEach(() => {
  alerts.mockRestore();
  expect(Reflect.set(config, "sso", originalSso)).toBe(true);
});

/* ─── Helpers ─── */

/** A request with optional cookies and a form body; POSTs are same-origin. */
function call(
  method: "GET" | "POST",
  path: string,
  opts: { token?: string; flow?: string; body?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  const cookies: string[] = [];
  if (opts.token) cookies.push(`bm_session=${opts.token}`);
  if (opts.flow) cookies.push(`bm_sso=${opts.flow}`);
  if (cookies.length > 0) headers["cookie"] = cookies.join("; ");
  const url = `${ORIGIN}${path}`;
  if (method === "GET") return app.handle(new Request(url, { headers }));
  headers["origin"] = ORIGIN;
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

/** The flash text and type of a redirect to the Sign-in methods page. */
function flashOf(response: Response): { path: string; flash: string; type: string } {
  const url = new URL(response.headers.get("location") ?? "", ORIGIN);
  return {
    path: url.pathname,
    flash: url.searchParams.get("flash") ?? "",
    type: url.searchParams.get("flashType") ?? "",
  };
}

/** Starts a link in `token`'s session; returns the provider URL and the flow cookie. */
async function startLink(
  token: string,
  password = PASSWORD,
): Promise<{ response: Response; location: string; flow: string | undefined }> {
  const response = await call("POST", `${PAGE}/corp/link`, { token, body: { password } });
  return {
    response,
    location: response.headers.get("location") ?? "",
    flow: flowCookieOf(response),
  };
}

/** The callback for a provider URL, as the browser would follow it. */
function callback(
  location: string,
  opts: { token?: string; flow?: string; mutate?: (p: URLSearchParams) => void } = {},
): Promise<Response> {
  const params = idp.issueCode(location);
  opts.mutate?.(params);
  return call("GET", `/dashboard/login/sso/corp/callback?${params.toString()}`, opts);
}

/** A full link: start, provider, callback. */
async function link(token: string): Promise<Response> {
  const started = await startLink(token);
  expect(started.response.status).toBe(302);
  return callback(started.location, { token, flow: started.flow });
}

/** The account's SSO link rows. */
function linkRows(userId: string) {
  return db
    .select()
    .from(userCredentials)
    .where(and(eq(userCredentials.userId, userId), eq(userCredentials.type, "oauth")));
}

/** Audit rows of one action. */
function auditRows(action: string) {
  return db
    .select({
      actorId: auditEvents.actorId,
      outcome: auditEvents.outcome,
      targetType: auditEvents.targetType,
      targetId: auditEvents.targetId,
      targetLabel: auditEvents.targetLabel,
      metadata: auditEvents.metadata,
    })
    .from(auditEvents)
    .where(eq(auditEvents.action, action));
}

/** Inserts an SSO link row directly. */
async function insertLink(
  userId: string,
  opts: { provider?: string; sub?: string } = {},
): Promise<string> {
  const id = generateId("crd");
  await db.insert(userCredentials).values({
    id,
    userId,
    type: "oauth",
    provider: opts.provider ?? `oidc:${idp.url}`,
    providerAccountId: opts.sub ?? "user-123",
    name: "alice@example.com",
  });
  return id;
}

/* ─── Schema ─── */

describe("migration 0040", () => {
  test("provider is varchar(255) and fits a 250-character issuer", async () => {
    const [column] = await db.execute<{ length: number }>(
      sql`SELECT character_maximum_length AS length FROM information_schema.columns WHERE table_name = 'user_credentials' AND column_name = 'provider'`,
    );
    expect(Number(column?.length)).toBe(255);
    await insertLink(ids.member, { provider: `oidc:https://${"a".repeat(234)}.example` });
    expect(await linkRows(ids.member)).toHaveLength(1);
  });

  test("one SSO link per provider per user; other providers and users are free", async () => {
    await insertLink(ids.member, { sub: "a" });
    const second = await insertLink(ids.member, { sub: "b" }).catch((e: unknown) => e);
    expect(String(second instanceof Error ? second.cause : second)).toContain(
      "user_credentials_one_oauth_per_provider",
    );
    await insertLink(ids.member, { provider: "oidc:https://other.example", sub: "b" });
    await insertLink(ids.other, { sub: "c" });
    expect(await linkRows(ids.member)).toHaveLength(2);
  });

  test("an identity links to one account only", async () => {
    await insertLink(ids.member, { sub: "same" });
    const error = await insertLink(ids.other, { sub: "same" }).catch((e: unknown) => e);
    expect(String(error instanceof Error ? error.cause : error)).toContain(
      "user_credentials_provider_account_unique",
    );
  });
});

/* ─── Linking ─── */

describe("linking (#224)", () => {
  test("password, provider, callback: the link is stored, emailed and audited", async () => {
    const session = await seed.session({ userId: ids.member });
    const started = await startLink(session.token);
    expect(started.response.status).toBe(302);
    expect(started.location.startsWith(`${idp.url}/authorize?`)).toBe(true);
    expect(started.flow).toBeDefined();
    const flowSetCookie = started.response.headers
      .getSetCookie()
      .find((c) => c.startsWith("bm_sso="));
    expect(flowSetCookie).toContain("SameSite=Lax");
    expect(flowSetCookie).toContain("HttpOnly");
    expect(flowSetCookie).toContain("Path=/dashboard");

    const response = await callback(started.location, {
      token: session.token,
      flow: started.flow,
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(flashOf(response)).toEqual({
      path: PAGE,
      flash: "Corp SSO linked.",
      type: "success",
    });
    /** The flow cookie is cleared. */
    expect(response.headers.getSetCookie()).toContain(
      "bm_sso=; HttpOnly; SameSite=Lax; Path=/dashboard; Max-Age=0",
    );

    const rows = await linkRows(ids.member);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: `oidc:${idp.url}`,
      providerAccountId: "user-123",
      name: "alice@example.com",
      secretHash: null,
      lastUsedAt: null,
    });
    const audits = await auditRows("auth.sso.linked");
    expect(audits).toEqual([
      {
        actorId: ids.member,
        outcome: "success",
        targetType: "sso_link",
        targetId: rows[0]?.id ?? "",
        targetLabel: "Corp SSO",
        metadata: { provider: "corp" },
      },
    ]);
    expect(JSON.stringify(await db.select().from(auditEvents))).not.toContain("user-123");
    expect(alerts.mock.calls.map(([input]) => [input.event, input.sso])).toEqual([
      ["sso_linked", { provider: "Corp SSO", account: "alice@example.com" }],
    ]);
  });

  test("a wrong password: refused and audited, no flow cookie, nothing called", async () => {
    const session = await seed.session({ userId: ids.member });
    const started = await startLink(session.token, "wrong password, long enough");
    expect(flashOf(started.response)).toMatchObject({
      flash: "Current password is incorrect.",
      type: "error",
    });
    expect(started.flow).toBeUndefined();
    expect(idp.hitCount("/.well-known/openid-configuration")).toBe(0);
    const refused = await auditRows("auth.sso.link_refused");
    expect(refused.map((r) => [r.actorId, r.outcome, r.metadata])).toEqual([
      [ids.member, "failure", { provider: "corp", reason: "wrong_password" }],
    ]);
  });

  test("the owner without a second factor is refused before the password", async () => {
    const session = await seed.session({ userId: ids.owner });
    const started = await startLink(session.token);
    expect(flashOf(started.response).flash).toContain("you need a second factor");
    const refused = await auditRows("auth.sso.link_refused");
    expect(refused.map((r) => r.metadata)).toEqual([
      { provider: "corp", reason: "second_factor_required" },
    ]);
    const page = await call("GET", PAGE, { token: session.token });
    expect(await page.text()).toContain("As the owner, you can link");
  });

  test("the owner with a second factor links", async () => {
    await db.insert(userCredentials).values({
      id: generateId("crd"),
      userId: ids.owner,
      type: "totp",
      secretHash: "enc:x",
    });
    const session = await seed.session({ userId: ids.owner, assurance: "mfa" });
    const response = await link(session.token);
    expect(flashOf(response).type).toBe("success");
    expect(await linkRows(ids.owner)).toHaveLength(1);
  });

  test("one link per provider: refused at the start, and at the callback for a racing flow", async () => {
    const session = await seed.session({ userId: ids.member });
    /** Two flows started before either finished. */
    const first = await startLink(session.token);
    const second = await startLink(session.token);
    expect(
      flashOf(await callback(first.location, { token: session.token, flow: first.flow }))
        .type,
    ).toBe("success");

    idp.claimOverrides = { sub: "user-456" };
    const late = await callback(second.location, {
      token: session.token,
      flow: second.flow,
    });
    expect(flashOf(late).flash).toBe(
      "Your account already has an account linked at that provider.",
    );
    const again = await startLink(session.token);
    expect(flashOf(again.response).flash).toBe(
      "Your account already has an account linked at that provider.",
    );
    expect(await linkRows(ids.member)).toHaveLength(1);
    const reasons = (await auditRows("auth.sso.link_refused")).map((r) => r.metadata);
    expect(reasons).toEqual([
      { provider: "corp", reason: "provider_already_linked" },
      { provider: "corp", reason: "provider_already_linked" },
    ]);
  });

  test("an identity linked to another account is refused (already_linked)", async () => {
    await insertLink(ids.other);
    const session = await seed.session({ userId: ids.member });
    const response = await link(session.token);
    expect(flashOf(response).flash).toBe(
      "That account at the provider is already linked to another BunMail account.",
    );
    expect(await linkRows(ids.member)).toHaveLength(0);
    const refused = await auditRows("auth.sso.link_refused");
    expect(refused.map((r) => [r.actorId, r.metadata])).toEqual([
      [ids.member, { provider: "corp", reason: "already_linked" }],
    ]);
    expect(alerts).not.toHaveBeenCalled();
  });

  test("the session that started the link must still be the browser's (session_changed)", async () => {
    const session = await seed.session({ userId: ids.member });
    const started = await startLink(session.token);
    /** Signed out at the provider's moment, then signed in again: another session. */
    await db.delete(sessions).where(eq(sessions.id, session.id));
    const fresh = await seed.session({ userId: ids.member });
    const response = await callback(started.location, {
      token: fresh.token,
      flow: started.flow,
    });
    expect(flashOf(response).flash).toContain("Your session changed");
    expect(await linkRows(ids.member)).toHaveLength(0);
    expect((await auditRows("auth.sso.link_refused")).map((r) => r.metadata)).toEqual([
      { provider: "corp", reason: "session_changed" },
    ]);
  });

  test("no session at the callback: the login page, nothing linked", async () => {
    const session = await seed.session({ userId: ids.member });
    const started = await startLink(session.token);
    const response = await callback(started.location, { flow: started.flow });
    expect(response.headers.get("location")).toBe("/dashboard/login?error=sso");
    expect(await linkRows(ids.member)).toHaveLength(0);
  });

  test("a sign-in flow is refused with the generic failure, nothing kept", async () => {
    const session = await seed.session({ userId: ids.member });
    const started = await startSsoFlow({ provider, baseUrl: ORIGIN, purpose: "login" });
    if (!started.ok) throw new Error("start failed");
    const response = await callback(started.authorizationUrl, {
      token: session.token,
      flow: started.flowCookie,
    });
    expect(response.headers.get("location")).toBe("/dashboard/login?error=sso");
    expect(await linkRows(ids.member)).toHaveLength(0);
  });

  test("a replayed callback is refused without a second token request", async () => {
    const session = await seed.session({ userId: ids.member });
    const started = await startLink(session.token);
    const params = idp.issueCode(started.location);
    const path = `/dashboard/login/sso/corp/callback?${params.toString()}`;
    const first = await call("GET", path, { token: session.token, flow: started.flow });
    expect(flashOf(first).type).toBe("success");
    const replay = await call("GET", path, { token: session.token, flow: started.flow });
    expect(flashOf(replay)).toMatchObject({ type: "error" });
    expect(flashOf(replay).flash).toContain("Linking did not complete");
    expect(idp.hitCount("/token")).toBe(1);
    /** The browser's live session names the account: the failed round trip is recorded. */
    const refused = await auditRows("auth.sso.link_refused");
    expect(refused.map((r) => [r.actorId, r.metadata])).toEqual([
      [ids.member, { provider: "corp", reason: "flow_failed" }],
    ]);
    expect(JSON.stringify(refused)).not.toContain(params.get("code") ?? "missing");
  });

  test("a failed callback counts against the IP; a success gives its attempt back", async () => {
    const session = await seed.session({ userId: ids.member });
    const started = await startLink(session.token);
    await callback(started.location, {
      token: session.token,
      flow: started.flow,
      mutate: (p) => p.set("state", "wrong"),
    });
    expect([...loginAttemptMap.values()].map((e) => e.count)).toEqual([1]);
    await link(session.token);
    expect([...loginAttemptMap.values()].map((e) => e.count)).toEqual([1]);
  });

  test("an unknown provider in the path is refused before anything is called", async () => {
    const session = await seed.session({ userId: ids.member });
    const response = await call(
      "GET",
      "/dashboard/login/sso/nope/callback?code=x&state=y",
      {
        token: session.token,
      },
    );
    expect(flashOf(response).type).toBe("error");
    expect(idp.hits.size).toBe(0);
  });
});

/* ─── Unlinking and the page ─── */

describe("unlinking and the page (#224)", () => {
  test("needs the password; ends the sessions the identity opened; audited and emailed", async () => {
    const linkId = await insertLink(ids.member);
    const current = await seed.session({ userId: ids.member });
    const viaSso = await seed.session({ userId: ids.member, credentialId: linkId });

    const wrong = await call("POST", `${PAGE}/${linkId}/unlink`, {
      token: current.token,
      body: { password: "wrong password, long enough" },
    });
    expect(flashOf(wrong).flash).toBe("Current password is incorrect.");
    expect(await linkRows(ids.member)).toHaveLength(1);
    expect(await auditRows("auth.sso.unlink_refused")).toEqual([
      {
        actorId: ids.member,
        outcome: "failure",
        targetType: "sso_link",
        targetId: linkId,
        targetLabel: "Corp SSO",
        metadata: { provider: "corp", reason: "wrong_password" },
      },
    ]);

    const response = await call("POST", `${PAGE}/${linkId}/unlink`, {
      token: current.token,
      body: { password: PASSWORD },
    });
    expect(flashOf(response)).toEqual({
      path: PAGE,
      flash: "Account unlinked.",
      type: "success",
    });
    expect(await linkRows(ids.member)).toHaveLength(0);
    const left = await db.select({ id: sessions.id }).from(sessions);
    expect(left.map((s) => s.id)).toEqual([current.id]);
    expect(viaSso.id).not.toBe(current.id);
    expect(await auditRows("auth.sso.unlinked")).toEqual([
      {
        actorId: ids.member,
        outcome: "success",
        targetType: "sso_link",
        targetId: linkId,
        targetLabel: "Corp SSO",
        metadata: { provider: "corp", sessionsRevoked: 1 },
      },
    ]);
    expect(alerts.mock.calls.map(([input]) => [input.event, input.sso])).toEqual([
      ["sso_unlinked", { provider: "Corp SSO", account: "alice@example.com" }],
    ]);
  });

  test("another account's link is not found, before any password work", async () => {
    const linkId = await insertLink(ids.other);
    const session = await seed.session({ userId: ids.member });
    const response = await call("POST", `${PAGE}/${linkId}/unlink`, {
      token: session.token,
      body: { password: PASSWORD },
    });
    expect(flashOf(response).flash).toBe("That link was not found: nothing was changed.");
    expect(await linkRows(ids.other)).toHaveLength(1);
  });

  test("the page lists providers and links, escaping the provider's name claim", async () => {
    idp.claimOverrides = { email: undefined, name: "<img src=x onerror=alert(1)>" };
    const session = await seed.session({ userId: ids.member });
    expect(flashOf(await link(session.token)).type).toBe("success");
    await insertLink(ids.member, { provider: "oidc:https://gone.example.org", sub: "z" });

    const page = await call("GET", PAGE, { token: session.token });
    expect(page.status).toBe(200);
    const pageHtml = await page.text();
    expect(pageHtml).toContain("Corp SSO");
    expect(pageHtml).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(pageHtml).not.toContain("<img src=x");
    /** A link whose provider is no longer configured: by its host, unlink only. */
    expect(pageHtml).toContain("gone.example.org");
    expect(pageHtml).not.toContain('/corp/link"');
    expect(pageHtml).toContain("/unlink");
  });

  test("SSO not configured: the page says so and offers nothing to link", async () => {
    expect(Reflect.set(config, "sso", { providers: [], baseUrl: ORIGIN })).toBe(true);
    const session = await seed.session({ userId: ids.member });
    const pageHtml = await (await call("GET", PAGE, { token: session.token })).text();
    expect(pageHtml).toContain("Single sign-on is not set up on this server.");
    expect(pageHtml).not.toContain("/link");
  });
});

/* ─── The owner rule after linking ─── */

describe("the owner rule stays true (#224)", () => {
  /** Gives an account a TOTP row (the rule is checked before any code). */
  async function addTotp(userId: string): Promise<void> {
    await db.insert(userCredentials).values({
      id: generateId("crd"),
      userId,
      type: "totp",
      secretHash: "enc:x",
    });
  }

  /** Gives an account a passkey row; returns its id. */
  async function addPasskey(userId: string): Promise<string> {
    const id = generateId("crd");
    await db.insert(userCredentials).values({
      id,
      userId,
      type: "passkey",
      providerAccountId: `pk-${crypto.randomUUID()}`,
      publicKey: "a2V5",
      counter: 0,
      name: "Laptop",
    });
    return id;
  }

  test("the owner with a link cannot turn off its only second factor (TOTP)", async () => {
    await addTotp(ids.owner);
    await insertLink(ids.owner);
    const session = await seed.session({ userId: ids.owner, assurance: "mfa" });
    const response = await call("POST", "/dashboard/account/two-factor/disable", {
      token: session.token,
      body: { password: PASSWORD, code: "000000" },
    });
    expect(response.status).toBe(302);
    expect(
      new URL(response.headers.get("location") ?? "", ORIGIN).searchParams.get("flash"),
    ).toContain("unlink it on the Sign-in methods page");
    const totp = await db
      .select()
      .from(userCredentials)
      .where(
        and(eq(userCredentials.userId, ids.owner), eq(userCredentials.type, "totp")),
      );
    expect(totp).toHaveLength(1);
    expect(
      (await auditRows("auth.two_factor.removal_refused")).map((r) => r.metadata),
    ).toEqual([{ factor: "totp", reason: "owner_sso_link" }]);
  });

  test("the owner with a link cannot remove its last passkey, but can remove one of two factors", async () => {
    const passkeyId = await addPasskey(ids.owner);
    await insertLink(ids.owner);
    const session = await seed.session({ userId: ids.owner, assurance: "mfa" });
    const refused = await call(
      "POST",
      `/dashboard/account/passkeys/${passkeyId}/delete`,
      {
        token: session.token,
        body: { password: PASSWORD },
      },
    );
    expect(
      new URL(refused.headers.get("location") ?? "", ORIGIN).searchParams.get("flash"),
    ).toContain("unlink it on the Sign-in methods page");
    expect(
      (await auditRows("auth.two_factor.removal_refused")).map((r) => r.metadata),
    ).toEqual([{ factor: "passkey", reason: "owner_sso_link" }]);

    await addTotp(ids.owner);
    const removed = await call(
      "POST",
      `/dashboard/account/passkeys/${passkeyId}/delete`,
      {
        token: session.token,
        body: { password: PASSWORD },
      },
    );
    expect(
      new URL(removed.headers.get("location") ?? "", ORIGIN).searchParams.get("flash"),
    ).toBe("Passkey removed.");
  });

  test("a member with a link may remove its last second factor (the rule is the owner's)", async () => {
    const passkeyId = await addPasskey(ids.member);
    await insertLink(ids.member);
    const session = await seed.session({ userId: ids.member, assurance: "mfa" });
    const response = await call(
      "POST",
      `/dashboard/account/passkeys/${passkeyId}/delete`,
      {
        token: session.token,
        body: { password: PASSWORD },
      },
    );
    expect(
      new URL(response.headers.get("location") ?? "", ORIGIN).searchParams.get("flash"),
    ).toBe("Passkey removed.");
  });

  test("ownership cannot go to an admin with a link and no second factor", async () => {
    const admin = (
      await seed.user({ email: "admin@example.com", role: "admin", password: PASSWORD })
    ).id;
    await insertLink(admin);
    const session = await seed.session({ userId: ids.owner });
    const refused = await call("POST", `/dashboard/users/${admin}/transfer`, {
      token: session.token,
      body: { password: PASSWORD },
    });
    expect(
      new URL(refused.headers.get("location") ?? "", ORIGIN).searchParams.get("flash"),
    ).toContain("must set up a second factor before becoming the owner");
    const [stillAdmin] = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, admin));
    expect(stillAdmin?.role).toBe("admin");

    await addTotp(admin);
    const done = await call("POST", `/dashboard/users/${admin}/transfer`, {
      token: session.token,
      body: { password: PASSWORD },
    });
    expect(done.status).toBe(302);
    const [owner] = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, admin));
    expect(owner?.role).toBe("owner");
  });

  test("the sidebar keeps Sign-in methods for an account with a link, providers or not", async () => {
    expect(Reflect.set(config, "sso", { providers: [], baseUrl: ORIGIN })).toBe(true);
    const member = await seed.session({ userId: ids.member });
    const without = await (
      await call("GET", "/dashboard/account/sessions", { token: member.token })
    ).text();
    expect(without).not.toContain('href="/dashboard/account/sso"');

    await insertLink(ids.member);
    const withLink = await (
      await call("GET", "/dashboard/account/sessions", { token: member.token })
    ).text();
    expect(withLink).toContain('href="/dashboard/account/sso"');
  });
});
