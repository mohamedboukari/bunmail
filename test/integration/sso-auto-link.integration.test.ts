/**
 * Linking by verified email at SSO sign-in (#224, part 4), through the
 * real `pagesPlugin` over HTTP against real Postgres and an in-process
 * OpenID Connect provider (`test/fixtures/fake-oidc-provider.ts`): real
 * tokens, real signatures, nothing sent to a real provider.
 *
 * - Auto-link off: a verified, allowed email of an existing account is
 *   still refused as an unknown identity (as before part 4).
 * - Auto-link on: the identity is linked to the member with that address
 *   (the explicit link's row shape) and signs in with a `password`-level
 *   session; `auth.sso.auto_linked` and `auth.login.succeeded` recorded;
 *   the security email sent; the next sign-in goes through the link.
 * - Every refusal is shown like an unknown identity, counted, audited
 *   with its own reason, and links nothing: `email_verified` not the
 *   boolean `true`, a domain not allowed, no account, a disabled account,
 *   a member with a second factor, an admin, the owner (even with a second
 *   factor), an account already linked at the provider.
 * - Races against the real unique indexes and row locks: two auto-links
 *   for one account, and an auto-link against an explicit link of the same
 *   identity to another account, each end in one link and a clean refusal.
 * - No subject, provider email, code or token in a log line or audit row.
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
import { users } from "../../src/modules/users/models/user.schema.ts";
import { auditEvents } from "../../src/modules/audit/models/audit-event.schema.ts";
import * as twoFactorAlert from "../../src/modules/users/services/two-factor-alert.service.ts";
import * as signInDevice from "../../src/modules/users/services/sign-in-device.service.ts";
import * as totp from "../../src/modules/users/services/totp.service.ts";
import { autoLinkSsoIdentity } from "../../src/modules/users/services/sso-auto-link.service.ts";
import { clearSsoDiscoveryCache } from "../../src/modules/users/services/sso-discovery.service.ts";
import { linkSsoIdentity } from "../../src/modules/users/services/sso-link.service.ts";
import { encryptSecret } from "../../src/utils/crypto.ts";
import { generateId } from "../../src/utils/id.ts";
import { logger } from "../../src/utils/logger.ts";
import { config, type SsoProviderSettings } from "../../src/config.ts";

/** With the request context, as `src/index.ts` mounts it. */
const app = new Elysia().wrap(withRequestContext).use(html()).use(pagesPlugin);

const ORIGIN = "http://localhost";
const PASSWORD = "the account password, long enough";
const CALLBACK = "/dashboard/login/sso/corp/callback";
const CLIENT = { ip: "203.0.113.7", userAgent: "test" };

const originalSso = config.sso;
const originalLimit = config.dashboard.loginRateLimit;
let idp: FakeOidcProvider;
let provider: SsoProviderSettings;
const ids = { owner: "", member: "", other: "" };
let alerts: ReturnType<typeof spyOn<typeof twoFactorAlert, "sendTwoFactorAlert">>;
let deviceChecks: ReturnType<typeof spyOn<typeof signInDevice, "recognizeSignInDevice">>;

/** Sets the provider's auto-link switch for the next requests. */
function useProvider(autoLink: boolean): void {
  provider = { ...provider, autoLink };
  expect(Reflect.set(config, "sso", { providers: [provider], baseUrl: ORIGIN })).toBe(
    true,
  );
}

beforeAll(async () => {
  idp = await FakeOidcProvider.start();
  provider = {
    id: "corp",
    issuer: idp.url,
    clientId: idp.clientId,
    clientSecret: idp.clientSecret,
    label: "Corp SSO",
    scopes: "openid email profile",
    allowedDomains: ["example.com"],
    autoLink: true,
  };
});

afterAll(async () => {
  await idp.stop();
});

beforeEach(async () => {
  useProvider(true);
  expect(
    Reflect.set(config.dashboard, "loginRateLimit", {
      enabled: true,
      maxAttempts: 5,
      windowSec: 900,
    }),
  ).toBe(true);
  clearSsoDiscoveryCache();
  /** The provider proves `member@example.com`, verified, unless a test says otherwise. */
  idp.claimOverrides = { email: "Member@Example.com", email_verified: true };
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
  ids.other = (await seed.user({ email: "other@example.com", password: PASSWORD })).id;
});

afterEach(() => {
  alerts.mockRestore();
  deviceChecks.mockRestore();
  expect(Reflect.set(config, "sso", originalSso)).toBe(true);
  expect(Reflect.set(config.dashboard, "loginRateLimit", originalLimit)).toBe(true);
});

/* ─── Helpers ─── */

/** A full sign-in: the start (same-origin POST), the provider, the callback. */
async function signIn(): Promise<Response> {
  const start = await app.handle(
    new Request(`${ORIGIN}/dashboard/login/sso/corp`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "",
    }),
  );
  const location = handoffTargetOf(start, await start.text());
  const flowSetCookie = start.headers.getSetCookie().find((c) => c.startsWith("bm_sso="));
  const flow = readSsoFlowCookie(flowSetCookie ?? null) ?? "";
  const params = idp.issueCode(location);
  return app.handle(
    new Request(`${ORIGIN}${CALLBACK}?${params.toString()}`, {
      headers: { cookie: `bm_sso=${flow}` },
    }),
  );
}

/** The `bm_session` value a response sets, or `undefined`. */
function sessionCookieOf(response: Response): string | undefined {
  const cookie = response.headers.getSetCookie().find((c) => c.startsWith("bm_session="));
  const token = readSessionCookie(cookie ?? null);
  return token === "" ? undefined : token;
}

/** Every SSO link row. */
function links() {
  return db
    .select({
      id: userCredentials.id,
      userId: userCredentials.userId,
      provider: userCredentials.provider,
      providerAccountId: userCredentials.providerAccountId,
      name: userCredentials.name,
      secretHash: userCredentials.secretHash,
      lastUsedAt: userCredentials.lastUsedAt,
    })
    .from(userCredentials)
    .where(eq(userCredentials.type, "oauth"));
}

/** Every session row of an account. */
function sessionsOf(userId: string) {
  return db
    .select({
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
      targetType: auditEvents.targetType,
      targetId: auditEvents.targetId,
      targetLabel: auditEvents.targetLabel,
      metadata: auditEvents.metadata,
    })
    .from(auditEvents)
    .where(eq(auditEvents.action, action))
    .orderBy(auditEvents.occurredAt, auditEvents.id);
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

/* ─── Auto-link off ─── */

describe("auto-link off (#224 part 4)", () => {
  test("a verified, allowed email of an existing account is refused as an unknown identity, nothing linked", async () => {
    useProvider(false);
    const response = await signIn();
    expect(response.headers.get("location")).toBe("/dashboard/login?error=sso_unlinked");
    expect(await links()).toEqual([]);
    expect((await auditRows("auth.login.failed")).map((r) => r.metadata)).toEqual([
      { step: "sso", reason: "unknown_identity", provider: "corp" },
    ]);
    expect(await auditRows("auth.sso.auto_linked")).toEqual([]);
    expect(alerts).not.toHaveBeenCalled();
  });
});

/* ─── Success ─── */

describe("auto-link on: linked and signed in (#224 part 4)", () => {
  test("no second factor: the link row, a password-level session bound to it, both records, the email; the next sign-in uses the link", async () => {
    const response = await signIn();
    expect(response.headers.get("location")).toBe("/dashboard");
    const rows = await links();
    expect(rows).toEqual([
      {
        id: expect.any(String),
        userId: ids.member,
        provider: `oidc:${idp.url}`,
        providerAccountId: "user-123",
        name: "member@example.com",
        secretHash: null,
        lastUsedAt: expect.any(Date),
      },
    ]);
    const linkId = rows[0]?.id ?? "";
    expect(await sessionsOf(ids.member)).toEqual([
      { assurance: "password", authMethod: "oauth", credentialId: linkId },
    ]);
    expect(await auditRows("auth.sso.auto_linked")).toEqual([
      {
        actorId: ids.member,
        targetType: "sso_link",
        targetId: linkId,
        targetLabel: "Corp SSO",
        metadata: { provider: "corp" },
      },
    ]);
    expect((await auditRows("auth.login.succeeded")).map((r) => r.metadata)).toEqual([
      { method: "oauth", provider: "corp" },
    ]);
    expect(
      alerts.mock.calls.map(([alert]) => [alert.event, alert.userId, alert.sso]),
    ).toEqual([
      [
        "sso_auto_linked",
        ids.member,
        { provider: "Corp SSO", account: "member@example.com" },
      ],
    ]);
    expect(deviceChecks).toHaveBeenCalledTimes(1);

    /** The second time, the identity is linked: no new link, no new email. */
    expect((await signIn()).headers.get("location")).toBe("/dashboard");
    expect(await links()).toHaveLength(1);
    expect(await auditRows("auth.sso.auto_linked")).toHaveLength(1);
    expect(alerts).toHaveBeenCalledTimes(1);
  });
});

/* ─── Refusals ─── */

describe("auto-link on: refused like an unknown identity (#224 part 4)", () => {
  /** Signs in and checks the refusal: the shared message, counted, audited, nothing linked. */
  async function expectRefused(reason: string, actorId: string | null): Promise<void> {
    const response = await signIn();
    expect(response.headers.get("location")).toBe("/dashboard/login?error=sso_unlinked");
    expect(sessionCookieOf(response)).toBeUndefined();
    expect(
      (await auditRows("auth.login.failed")).map((r) => [r.actorId, r.metadata]),
    ).toEqual([[actorId, { step: "sso", reason, provider: "corp" }]]);
    expect(await auditRows("auth.sso.auto_linked")).toEqual([]);
    expect(loginAttemptMap.get("unknown")?.count).toBe(1);
    expect(alerts).not.toHaveBeenCalled();
  }

  test('email_verified as the string "true"', async () => {
    idp.claimOverrides = { email: "member@example.com", email_verified: "true" };
    await expectRefused("email_unverified", null);
    expect(await links()).toEqual([]);
  });

  test("email_verified missing", async () => {
    idp.claimOverrides = { email: "member@example.com", email_verified: undefined };
    await expectRefused("email_unverified", null);
  });

  test("a domain not allowed", async () => {
    expect(
      Reflect.set(config, "sso", {
        providers: [{ ...provider, allowedDomains: ["example.org"] }],
        baseUrl: ORIGIN,
      }),
    ).toBe(true);
    await expectRefused("domain_not_allowed", null);
    expect(await links()).toEqual([]);
  });

  test("no account with the address", async () => {
    idp.claimOverrides = { email: "nobody@example.com", email_verified: true };
    await expectRefused("no_account_for_email", null);
  });

  test("a disabled account", async () => {
    await db
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.id, ids.member));
    await expectRefused("deactivated", ids.member);
    expect(await links()).toEqual([]);
  });

  test("a member with a second factor: refused, it links explicitly instead (M1)", async () => {
    await addTotp(ids.member);
    await expectRefused("second_factor_enrolled", ids.member);
    expect(await links()).toEqual([]);
    expect(await sessionsOf(ids.member)).toEqual([]);
  });

  test("an admin, even without a second factor (L2)", async () => {
    const admin = await seed.user({
      email: "admin@example.com",
      role: "admin",
      password: PASSWORD,
    });
    idp.claimOverrides = { email: "admin@example.com", email_verified: true };
    await expectRefused("admin_not_auto_linked", admin.id);
    expect(await links()).toEqual([]);
  });

  test("the owner, even with a second factor", async () => {
    await addTotp(ids.owner);
    idp.claimOverrides = { email: "owner@example.com", email_verified: true };
    await expectRefused("owner_not_auto_linked", ids.owner);
    expect(await links()).toEqual([]);
  });

  test("an account already linked at the provider (another identity)", async () => {
    await db.insert(userCredentials).values({
      id: generateId("crd"),
      userId: ids.member,
      type: "oauth",
      provider: `oidc:${idp.url}`,
      providerAccountId: "another-sub",
      name: null,
    });
    await expectRefused("provider_already_linked", ids.member);
    expect((await links()).map((l) => l.providerAccountId)).toEqual(["another-sub"]);
  });
});

/* ─── Races against the real indexes and locks ─── */

describe("races (#224 part 4)", () => {
  const input = (sub: string) => ({
    providerKey: `oidc:${idp.url}`,
    sub,
    email: "member@example.com",
    provider: { id: "corp", label: "Corp SSO" },
    name: "member@example.com",
  });

  test("two concurrent auto-links for one account: one link, one clean refusal", async () => {
    const results = await Promise.all([
      autoLinkSsoIdentity(input("sub-a"), CLIENT),
      autoLinkSsoIdentity(input("sub-b"), CLIENT),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([
      { ok: false, reason: "provider_already_linked", userId: ids.member },
    ]);
    expect(await links()).toHaveLength(1);
    expect(await sessionsOf(ids.member)).toHaveLength(1);
  });

  test("an auto-link and an explicit link of the same identity to another account: one link, one clean refusal", async () => {
    const session = await seed.session({ userId: ids.other });
    const results = await Promise.all([
      autoLinkSsoIdentity(input("user-123"), CLIENT),
      linkSsoIdentity(
        {
          flowSessionId: session.id,
          session: {
            sessionId: session.id,
            userId: ids.other,
            matched: "current",
            graceOver: false,
          },
          provider: { key: `oidc:${idp.url}`, id: "corp", label: "Corp SSO" },
          sub: "user-123",
          name: null,
        },
        CLIENT,
      ),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([
      expect.objectContaining({ ok: false, reason: "already_linked" }),
    ]);
    const rows = await links();
    expect(rows).toHaveLength(1);
    /** The loser left nothing behind: no session for an account without the link. */
    const winner = rows[0]?.userId ?? "";
    const loser = winner === ids.member ? ids.other : ids.member;
    expect((await sessionsOf(loser)).filter((s) => s.authMethod === "oauth")).toEqual([]);
  });
});

/* ─── Nothing secret is kept ─── */

describe("no secret in logs or audit rows (#224 part 4)", () => {
  test("neither the subject, the provider email, the code nor a token", async () => {
    const lines: unknown[][] = [];
    const spies = (["debug", "info", "warn", "error"] as const).map((level) =>
      spyOn(logger, level).mockImplementation((...args: unknown[]) => {
        lines.push(args);
      }),
    );
    try {
      expect((await signIn()).headers.get("location")).toBe("/dashboard");
      idp.claimOverrides = { email: "owner@example.com", email_verified: true };
      await db
        .delete(userCredentials)
        .where(
          and(eq(userCredentials.userId, ids.member), eq(userCredentials.type, "oauth")),
        );
      await signIn();
      const logged = JSON.stringify(lines);
      const audited = JSON.stringify(
        await db
          .select({
            targetLabel: auditEvents.targetLabel,
            metadata: auditEvents.metadata,
          })
          .from(auditEvents),
      );
      for (const secret of [
        "user-123",
        "Member@Example.com",
        "fake-access-token",
        idp.clientSecret,
      ]) {
        expect(logged).not.toContain(secret);
        expect(audited).not.toContain(secret);
      }
      /** The provider email is stored as the link's label only, never in a record. */
      expect(audited).not.toContain("owner@example.com");
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
