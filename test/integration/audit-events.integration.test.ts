/**
 * Every wired audit action (#221), through the real dashboard and REST
 * plugins (or the service, for the boot and `reset-owner` paths) against
 * real Postgres. Table-driven: each case performs one action and names
 * the event it must leave behind, with its actor, target, outcome,
 * metadata and client address. Then a sweep over a whole session of
 * actions: no password, key, token, code or secret ever reaches a row.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { Elysia } from "elysia";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, seed, truncateAll } from "./_helpers.ts";
import { pagesPlugin } from "../../src/pages/pages.plugin.tsx";
import { apiPlugins } from "../../src/modules/api-plugins.ts";
import { readSessionCookie } from "../../src/pages/session.ts";
import { loginAttemptMap } from "../../src/middleware/login-rate-limit.ts";
import { resetCodesExhaustedAlerts } from "../../src/pages/lib/two-factor-limiter.ts";
import { auditEvents } from "../../src/modules/audit/models/audit-event.schema.ts";
import { users } from "../../src/modules/users/models/user.schema.ts";
import { sessions } from "../../src/modules/users/models/session.schema.ts";
import { userCredentials } from "../../src/modules/users/models/user-credential.schema.ts";
import { createSession } from "../../src/modules/users/services/session.service.ts";
import { createInvitation } from "../../src/modules/users/services/invite.service.ts";
import {
  deactivateAccount,
  issuePasswordReset,
} from "../../src/modules/users/services/user-admin.service.ts";
import {
  bootstrapOwner,
  issueOwnerSetupLink,
} from "../../src/modules/users/services/owner.service.ts";
import * as totp from "../../src/modules/users/services/totp.service.ts";
import * as twoFactorAlert from "../../src/modules/users/services/two-factor-alert.service.ts";
import * as dnsVerification from "../../src/modules/domains/services/dns-verification.service.ts";
import { decryptSecret, encryptSecret } from "../../src/utils/crypto.ts";
import { generateId } from "../../src/utils/id.ts";
import { config } from "../../src/config.ts";

const dashboard = new Elysia().use(pagesPlugin);
const api = new Elysia().use(apiPlugins);

const PASSWORD = "the account password, long enough";
const NEW_PASSWORD = "a brand new passphrase, long enough";
const OWNER = "owner@example.com";
const ADMIN = "admin@example.com";
const MEMBER = "member@example.com";
const IP = "203.0.113.50";
const UA = "AuditTest/1.0";
const HOOK_URL = "https://93.184.216.34/hooks/s3cr3t-path?token=abc";
const originalProxyHops = config.dashboard.trustedProxyHops;

const ids = { owner: "", admin: "", member: "" };
const tokens = { owner: "", admin: "", member: "" };
const sessionIds = { owner: "", admin: "", member: "" };
let adminKey = { id: "", rawKey: "" };

beforeEach(async () => {
  loginAttemptMap.clear();
  resetCodesExhaustedAlerts();
  await truncateAll();
  expect(Reflect.set(config.dashboard, "trustedProxyHops", 1)).toBe(true);
  ids.owner = (await seed.user({ email: OWNER, role: "owner", password: PASSWORD })).id;
  ids.admin = (await seed.user({ email: ADMIN, role: "admin", password: PASSWORD })).id;
  ids.member = (
    await seed.user({ email: MEMBER, role: "member", password: PASSWORD })
  ).id;
  for (const role of ["owner", "admin", "member"] as const) {
    const created = await createSession({
      userId: ids[role],
      assurance: "password",
      authMethod: "password",
      ip: null,
      userAgent: null,
    });
    tokens[role] = created.token;
    sessionIds[role] = created.sessionId;
  }
  adminKey = await seed.apiKey({ name: "ops key", isAdmin: true });
  await db.delete(auditEvents);
});

afterEach(() => {
  expect(Reflect.set(config.dashboard, "trustedProxyHops", originalProxyHops)).toBe(true);
});

/* ─── Helpers ─── */

/** A same-origin dashboard request from `IP` with `UA`, optionally signed in. */
function dash(
  method: "GET" | "POST",
  path: string,
  opts: { token?: string; body?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "x-forwarded-for": IP, "user-agent": UA };
  if (opts.token) headers["cookie"] = `bm_session=${opts.token}`;
  const url = `http://localhost${path}`;
  if (method === "GET") return dashboard.handle(new Request(url, { headers }));
  headers["origin"] = "http://localhost";
  headers["content-type"] = "application/x-www-form-urlencoded";
  return dashboard.handle(
    new Request(url, {
      method: "POST",
      headers,
      body: new URLSearchParams(opts.body ?? {}).toString(),
    }),
  );
}

/** A REST call with the admin key, from `IP` with `UA`. */
function rest(
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  return api.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        authorization: `Bearer ${adminKey.rawKey}`,
        "content-type": "application/json",
        "x-forwarded-for": IP,
        "user-agent": UA,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

/** Reads `data.id` from a REST response. */
async function dataId(response: Response): Promise<string> {
  const json: unknown = await response.json();
  const data: unknown =
    typeof json === "object" && json !== null ? Reflect.get(json, "data") : undefined;
  const id: unknown =
    typeof data === "object" && data !== null ? Reflect.get(data, "id") : undefined;
  if (typeof id !== "string") throw new Error(`no data.id (status ${response.status})`);
  return id;
}

/** The `token` query value of a link. */
function tokenOf(url: string): string {
  const token = new URL(url).searchParams.get("token");
  if (!token) throw new Error("no token in link");
  return token;
}

/** Gives an account a confirmed TOTP second factor; returns its key. */
async function seedTotp(userId: string): Promise<Buffer> {
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

/** An `mfa` session of an account with a second factor (a `password` one no longer opens anything). */
async function mfaSession(userId: string): Promise<string> {
  const created = await createSession({
    userId,
    assurance: "mfa",
    authMethod: "password",
    ip: null,
    userAgent: null,
  });
  return created.token;
}

/** The current TOTP code of a key. */
function codeNow(key: Buffer): string {
  return totp.totpCode(key, totp.totpStep(Date.now()));
}

/** Password step of a 2FA account; returns the pending session token. */
async function pendingLogin(email: string): Promise<string> {
  const response = await dash("POST", "/dashboard/login", {
    body: { email, password: PASSWORD },
  });
  const token = readSessionCookie(response.headers.get("set-cookie"));
  if (!token) throw new Error("no pending session");
  return token;
}

/** The id of the user holding `email`. */
async function userIdOf(email: string): Promise<string> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email));
  if (!row) throw new Error(`no user ${email}`);
  return row.id;
}

/** What an action must have recorded (`undefined` fields are not checked). */
interface Expected {
  action: string;
  outcome?: "success" | "failure";
  actorType: "user" | "api_key" | "system";
  actorId: string | null;
  actorLabel?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  targetLabel?: string | null;
  metadata?: Record<string, unknown> | null;
  /** The client address; `IP` for every HTTP case, null for a script. */
  ip: string | null;
}

/** The dashboard user `role` as the actor, with its email as the label. */
function asUser(
  role: "owner" | "admin" | "member",
): Pick<Expected, "actorType" | "actorId" | "actorLabel" | "ip"> {
  const emails = { owner: OWNER, admin: ADMIN, member: MEMBER };
  return { actorType: "user", actorId: ids[role], actorLabel: emails[role], ip: IP };
}

/** The REST admin key as the actor. */
function asKey(): Pick<Expected, "actorType" | "actorId" | "actorLabel" | "ip"> {
  return { actorType: "api_key", actorId: adminKey.id, actorLabel: "ops key", ip: IP };
}

/** One case: performs the action, returns the event it must have left. */
interface Case {
  name: string;
  run: () => Promise<Expected>;
}

const CASES: Case[] = [
  /* ─── Sign-in ─── */
  {
    name: "password sign-in",
    run: async () => {
      await dash("POST", "/dashboard/login", {
        body: { email: MEMBER, password: PASSWORD },
      });
      return {
        action: "auth.login.succeeded",
        ...asUser("member"),
        targetType: "session",
        metadata: { method: "password" },
      };
    },
  },
  {
    name: "wrong password",
    run: async () => {
      await dash("POST", "/dashboard/login", {
        body: { email: MEMBER, password: "wrong" },
      });
      return {
        action: "auth.login.failed",
        outcome: "failure",
        ...asUser("member"),
        metadata: { step: "password", reason: "wrong_password" },
      };
    },
  },
  {
    name: "unknown account (the typed address is not stored)",
    run: async () => {
      await dash("POST", "/dashboard/login", {
        body: { email: "ghost@example.com", password: PASSWORD },
      });
      return {
        action: "auth.login.failed",
        outcome: "failure",
        actorType: "user",
        actorId: null,
        actorLabel: null,
        ip: IP,
        metadata: { step: "password", reason: "unknown_account" },
      };
    },
  },
  {
    name: "deactivated account",
    run: async () => {
      const id = (
        await seed.user({
          email: "gone@example.com",
          password: PASSWORD,
          disabledAt: new Date(),
        })
      ).id;
      await dash("POST", "/dashboard/login", {
        body: { email: "gone@example.com", password: PASSWORD },
      });
      return {
        action: "auth.login.failed",
        outcome: "failure",
        actorType: "user",
        actorId: id,
        actorLabel: "gone@example.com",
        ip: IP,
        metadata: { step: "password", reason: "deactivated" },
      };
    },
  },
  {
    name: "sign-out",
    run: async () => {
      await dash("POST", "/dashboard/logout", { token: tokens.member });
      return {
        action: "auth.logout",
        ...asUser("member"),
        targetType: "session",
        targetId: sessionIds.member,
      };
    },
  },
  {
    name: "two-factor: password accepted, second factor required",
    run: async () => {
      await seedTotp(ids.member);
      await pendingLogin(MEMBER);
      return { action: "auth.login.two_factor_required", ...asUser("member") };
    },
  },
  {
    name: "two-factor: a valid code completes the sign-in",
    run: async () => {
      const key = await seedTotp(ids.member);
      const pending = await pendingLogin(MEMBER);
      await dash("POST", "/dashboard/login/two-factor", {
        token: pending,
        body: { code: codeNow(key) },
      });
      return {
        action: "auth.login.succeeded",
        ...asUser("member"),
        targetType: "session",
        metadata: { method: "totp" },
      };
    },
  },
  {
    name: "two-factor: a wrong code",
    run: async () => {
      await seedTotp(ids.member);
      const pending = await pendingLogin(MEMBER);
      await dash("POST", "/dashboard/login/two-factor", {
        token: pending,
        body: { code: "not-a-code" },
      });
      return {
        action: "auth.login.failed",
        outcome: "failure",
        ...asUser("member"),
        metadata: { step: "two_factor", reason: "wrong_code" },
      };
    },
  },
  {
    name: "two-factor: budget exhausted, pending session revoked",
    run: async () => {
      await seedTotp(ids.member);
      const pending = await pendingLogin(MEMBER);
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await dash("POST", "/dashboard/login/two-factor", {
          token: pending,
          body: { code: "not-a-code" },
        });
      }
      return {
        action: "auth.login.two_factor_locked",
        outcome: "failure",
        ...asUser("member"),
      };
    },
  },

  /* ─── Sessions ─── */
  {
    name: "one session revoked by its user",
    run: async () => {
      const other = await seed.session({ userId: ids.member });
      await dash("POST", `/dashboard/account/sessions/${other.id}/revoke`, {
        token: tokens.member,
      });
      return {
        action: "auth.session.revoked",
        ...asUser("member"),
        targetType: "session",
        targetId: other.id,
        metadata: { current: false, reason: "user" },
      };
    },
  },
  {
    name: "every other session revoked",
    run: async () => {
      await seed.session({ userId: ids.member });
      await dash("POST", "/dashboard/account/sessions/revoke-others", {
        token: tokens.member,
      });
      return {
        action: "auth.session.others_revoked",
        ...asUser("member"),
        targetType: "user",
        targetId: ids.member,
        metadata: { sessionsRevoked: 1 },
      };
    },
  },
  {
    name: "session token reuse",
    run: async () => {
      const old = "o".repeat(43);
      await seed.session({
        userId: ids.member,
        previousToken: old,
        rotatedAt: sql`now() - interval '5 minutes'`,
      });
      await dash("GET", "/dashboard", { token: old });
      return {
        action: "auth.session.token_reuse_detected",
        outcome: "failure",
        actorType: "system",
        actorId: null,
        actorLabel: "session guard",
        targetType: "user",
        targetId: ids.member,
        targetLabel: MEMBER,
        ip: IP,
      };
    },
  },

  /* ─── Password and two-factor ─── */
  {
    name: "password changed",
    run: async () => {
      await dash("POST", "/dashboard/account/password", {
        token: tokens.member,
        body: { current: PASSWORD, password: NEW_PASSWORD, confirm: NEW_PASSWORD },
      });
      return {
        action: "auth.password.changed",
        ...asUser("member"),
        targetType: "user",
        targetId: ids.member,
        metadata: { sessionsRevoked: 1 },
      };
    },
  },
  {
    name: "two-factor enabled",
    run: async () => {
      await dash("POST", "/dashboard/account/two-factor/start", {
        token: tokens.member,
        body: { password: PASSWORD },
      });
      const [row] = await db
        .select({ pending: sessions.totpPendingSecret })
        .from(sessions)
        .where(eq(sessions.id, sessionIds.member));
      const key = totp.base32Decode(
        decryptSecret(row?.pending ?? "", config.dkimEncryptionKey),
      );
      if (!key) throw new Error("no pending secret");
      await dash("POST", "/dashboard/account/two-factor/confirm", {
        token: tokens.member,
        body: { code: codeNow(key) },
      });
      return {
        action: "auth.two_factor.enabled",
        ...asUser("member"),
        targetType: "user",
        targetId: ids.member,
        metadata: { sessionsRevoked: 0 },
      };
    },
  },
  {
    name: "recovery codes regenerated",
    run: async () => {
      const key = await seedTotp(ids.member);
      await dash("POST", "/dashboard/account/two-factor/recovery-codes", {
        token: await mfaSession(ids.member),
        body: { code: codeNow(key) },
      });
      return {
        action: "auth.two_factor.recovery_codes_regenerated",
        ...asUser("member"),
      };
    },
  },
  {
    name: "two-factor disabled",
    run: async () => {
      const key = await seedTotp(ids.member);
      await dash("POST", "/dashboard/account/two-factor/disable", {
        token: await mfaSession(ids.member),
        body: { password: PASSWORD, code: codeNow(key) },
      });
      return {
        action: "auth.two_factor.disabled",
        ...asUser("member"),
        metadata: { method: "totp" },
      };
    },
  },

  /* ─── Invitations ─── */
  {
    name: "invitation created",
    run: async () => {
      await dash("POST", "/dashboard/invitations", {
        token: tokens.admin,
        body: { email: "new@example.org", role: "member" },
      });
      return {
        action: "user.invitation.created",
        ...asUser("admin"),
        targetType: "invitation",
        targetLabel: "new@example.org",
        metadata: { role: "member", replaced: 0 },
      };
    },
  },
  {
    name: "invitation resent",
    run: async () => {
      const issued = await createInvitation(
        { id: ids.admin, role: "admin" },
        "new@example.org",
        "member",
      );
      if (!issued.ok) throw new Error("not issued");
      const previous = issued.invitation.invitationId;
      await dash("POST", `/dashboard/invitations/${previous}/resend`, {
        token: tokens.admin,
      });
      return {
        action: "user.invitation.resent",
        ...asUser("admin"),
        targetType: "invitation",
        targetLabel: "new@example.org",
        metadata: { role: "member", previousInvitationId: previous },
      };
    },
  },
  {
    name: "invitation revoked",
    run: async () => {
      const issued = await createInvitation(
        { id: ids.admin, role: "admin" },
        "new@example.org",
        "member",
      );
      if (!issued.ok) throw new Error("not issued");
      const id = issued.invitation.invitationId;
      await dash("POST", `/dashboard/invitations/${id}/revoke`, { token: tokens.owner });
      return {
        action: "user.invitation.revoked",
        ...asUser("owner"),
        targetType: "invitation",
        targetId: id,
        targetLabel: "new@example.org",
        metadata: { role: "member" },
      };
    },
  },
  {
    name: "invitation accepted",
    run: async () => {
      const issued = await createInvitation(
        { id: ids.admin, role: "admin" },
        "new@example.org",
        "member",
      );
      if (!issued.ok) throw new Error("not issued");
      await dash("POST", "/dashboard/invite", {
        body: {
          token: issued.invitation.token,
          name: "New Person",
          password: PASSWORD,
          confirm: PASSWORD,
        },
      });
      return {
        action: "user.invitation.accepted",
        actorType: "user",
        actorId: await userIdOf("new@example.org"),
        actorLabel: "new@example.org",
        ip: IP,
        targetType: "invitation",
        targetId: issued.invitation.invitationId,
        metadata: { role: "member", invitedBy: ids.admin },
      };
    },
  },

  /* ─── Account management ─── */
  {
    name: "role changed",
    run: async () => {
      await dash("POST", `/dashboard/users/${ids.member}/role`, {
        token: tokens.owner,
        body: { role: "admin" },
      });
      return {
        action: "user.role.changed",
        ...asUser("owner"),
        targetType: "user",
        targetId: ids.member,
        targetLabel: MEMBER,
        metadata: { from: "member", to: "admin" },
      };
    },
  },
  {
    name: "account deactivated",
    run: async () => {
      await dash("POST", `/dashboard/users/${ids.member}/deactivate`, {
        token: tokens.admin,
      });
      return {
        action: "user.deactivated",
        ...asUser("admin"),
        targetId: ids.member,
        metadata: { sessionsRevoked: 1, keysDisabled: 0 },
      };
    },
  },
  {
    name: "account reactivated",
    run: async () => {
      await deactivateAccount(ids.admin, ids.member);
      await dash("POST", `/dashboard/users/${ids.member}/reactivate`, {
        token: tokens.admin,
      });
      return { action: "user.reactivated", ...asUser("admin"), targetId: ids.member };
    },
  },
  {
    name: "account removed (the label survives the row)",
    run: async () => {
      await dash("POST", `/dashboard/users/${ids.member}/remove`, {
        token: tokens.admin,
        body: { confirm: MEMBER },
      });
      return {
        action: "user.removed",
        ...asUser("admin"),
        targetId: ids.member,
        targetLabel: MEMBER,
        metadata: { role: "member", keysDisabled: 0 },
      };
    },
  },
  {
    name: "ownership transferred",
    run: async () => {
      await dash("POST", `/dashboard/users/${ids.admin}/transfer`, {
        token: tokens.owner,
        body: { password: PASSWORD },
      });
      return {
        action: "user.ownership.transferred",
        ...asUser("owner"),
        targetId: ids.admin,
        targetLabel: ADMIN,
        metadata: null,
      };
    },
  },
  {
    name: "ownership transfer refused: wrong password",
    run: async () => {
      await dash("POST", `/dashboard/users/${ids.admin}/transfer`, {
        token: tokens.owner,
        body: { password: "not the password" },
      });
      return {
        action: "user.ownership.transferred",
        outcome: "failure",
        ...asUser("owner"),
        targetId: ids.admin,
        metadata: { reason: "wrong_password" },
      };
    },
  },
  {
    name: "password reset link issued",
    run: async () => {
      await dash("POST", `/dashboard/users/${ids.member}/reset-password`, {
        token: tokens.admin,
      });
      return {
        action: "auth.password_reset.issued",
        ...asUser("admin"),
        targetType: "user",
        targetId: ids.member,
      };
    },
  },
  {
    name: "password reset completed",
    run: async () => {
      const issued = await issuePasswordReset(ids.admin, ids.member);
      if (!issued.ok) throw new Error("not issued");
      await dash("POST", "/dashboard/reset", {
        body: {
          token: tokenOf(issued.url),
          password: NEW_PASSWORD,
          confirm: NEW_PASSWORD,
        },
      });
      return {
        action: "auth.password_reset.completed",
        ...asUser("member"),
        targetId: ids.member,
        metadata: { issuedBy: ids.admin, sessionsRevoked: 1 },
      };
    },
  },
  {
    name: "two-factor removed by a completed reset",
    run: async () => {
      await seedTotp(ids.member);
      const issued = await issuePasswordReset(ids.admin, ids.member);
      if (!issued.ok) throw new Error("not issued");
      await dash("POST", "/dashboard/reset", {
        body: {
          token: tokenOf(issued.url),
          password: NEW_PASSWORD,
          confirm: NEW_PASSWORD,
        },
      });
      return {
        action: "auth.two_factor.removed",
        ...asUser("member"),
        targetId: ids.member,
        metadata: { via: "password_reset" },
      };
    },
  },
  {
    name: "owner setup link issued by reset-owner",
    run: async () => {
      await issueOwnerSetupLink(null);
      return {
        action: "auth.owner_setup.issued",
        actorType: "system",
        actorId: null,
        actorLabel: "reset-owner",
        ip: null,
        targetType: "user",
        targetId: ids.owner,
        targetLabel: OWNER,
        metadata: { via: "reset_owner", sessionsRevoked: 1 },
      };
    },
  },
  {
    name: "owner setup link issued at boot",
    run: async () => {
      await truncateAll();
      await bootstrapOwner("boot@example.com");
      return {
        action: "auth.owner_setup.issued",
        actorType: "system",
        actorId: null,
        actorLabel: "boot",
        ip: null,
        targetType: "user",
        targetId: await userIdOf("boot@example.com"),
        targetLabel: "boot@example.com",
        metadata: { via: "boot", sessionsRevoked: 0 },
      };
    },
  },
  {
    name: "owner setup completed",
    run: async () => {
      const link = await issueOwnerSetupLink(null);
      await dash("POST", "/dashboard/setup", {
        body: { token: link.token, password: NEW_PASSWORD, confirm: NEW_PASSWORD },
      });
      return {
        action: "auth.owner_setup.completed",
        ...asUser("owner"),
        targetId: ids.owner,
      };
    },
  },

  /* ─── API keys ─── */
  {
    name: "API key created (dashboard)",
    run: async () => {
      await dash("POST", "/dashboard/api-keys", {
        token: tokens.member,
        body: { name: "member key", allowedSenders: "a@example.com" },
      });
      return {
        action: "api_key.created",
        ...asUser("member"),
        targetType: "api_key",
        targetLabel: "member key",
        metadata: { isAdmin: false, allowedSenders: 1 },
      };
    },
  },
  {
    name: "API key admin flag changed (dashboard)",
    run: async () => {
      const key = await seed.apiKey({ name: "promote me" });
      await dash("POST", `/dashboard/api-keys/${key.id}/admin`, {
        token: tokens.admin,
        body: { isAdmin: "true" },
      });
      return {
        action: "api_key.admin_changed",
        ...asUser("admin"),
        targetId: key.id,
        targetLabel: "promote me",
        metadata: { isAdmin: true },
      };
    },
  },
  {
    name: "API key allowed senders changed (dashboard)",
    run: async () => {
      const key = await seed.apiKey({ name: "senders", createdByUserId: ids.member });
      await dash("POST", `/dashboard/api-keys/${key.id}/senders`, {
        token: tokens.member,
        body: { allowedSenders: "a@example.com,b@example.com" },
      });
      return {
        action: "api_key.updated",
        ...asUser("member"),
        targetId: key.id,
        metadata: { fields: ["allowedSenders"], allowedSenders: 2 },
      };
    },
  },
  {
    name: "API key revoked (dashboard)",
    run: async () => {
      const key = await seed.apiKey({ name: "old key" });
      await dash("POST", `/dashboard/api-keys/${key.id}/revoke`, { token: tokens.admin });
      return {
        action: "api_key.revoked",
        ...asUser("admin"),
        targetId: key.id,
        targetLabel: "old key",
      };
    },
  },
  {
    name: "API key created (REST)",
    run: async () => {
      const id = await dataId(
        await rest("POST", "/api/v1/api-keys", { name: "via rest" }),
      );
      return {
        action: "api_key.created",
        ...asKey(),
        targetType: "api_key",
        targetId: id,
        targetLabel: "via rest",
        metadata: { isAdmin: false, allowedSenders: 0 },
      };
    },
  },
  {
    name: "API key updated (REST)",
    run: async () => {
      const key = await seed.apiKey({ name: "rename me" });
      await rest("PATCH", `/api/v1/api-keys/${key.id}`, { name: "renamed" });
      return {
        action: "api_key.updated",
        ...asKey(),
        targetId: key.id,
        targetLabel: "renamed",
        metadata: { fields: ["name"] },
      };
    },
  },
  {
    name: "API key revoked (REST)",
    run: async () => {
      const key = await seed.apiKey({ name: "doomed" });
      await rest("DELETE", `/api/v1/api-keys/${key.id}`);
      return {
        action: "api_key.revoked",
        ...asKey(),
        targetId: key.id,
        targetLabel: "doomed",
      };
    },
  },

  /* ─── Domains ─── */
  {
    name: "domain added (dashboard)",
    run: async () => {
      await dash("POST", "/dashboard/domains", {
        token: tokens.admin,
        body: { name: "added.example.org" },
      });
      return {
        action: "domain.created",
        ...asUser("admin"),
        targetType: "domain",
        targetLabel: "added.example.org",
      };
    },
  },
  {
    name: "domain deleted (dashboard)",
    run: async () => {
      const domain = await seed.domain({ name: "old.example.org" });
      await dash("POST", `/dashboard/domains/${domain.id}/delete`, {
        token: tokens.admin,
      });
      return {
        action: "domain.deleted",
        ...asUser("admin"),
        targetId: domain.id,
        targetLabel: "old.example.org",
      };
    },
  },
  {
    name: "domain notification address changed (dashboard)",
    run: async () => {
      const domain = await seed.domain({ name: "notify.example.org" });
      await dash("POST", `/dashboard/domains/${domain.id}/notify-email`, {
        token: tokens.admin,
        body: { notifyEmail: "ops@example.org" },
      });
      return {
        action: "domain.updated",
        ...asUser("admin"),
        targetId: domain.id,
        metadata: { fields: ["notifyEmail"] },
      };
    },
  },
  {
    name: "domain unsubscribe settings changed (dashboard)",
    run: async () => {
      const domain = await seed.domain({ name: "unsub.example.org" });
      await dash("POST", `/dashboard/domains/${domain.id}/unsubscribe`, {
        token: tokens.admin,
        body: { unsubscribeEmail: "unsub@example.org", unsubscribeUrl: "" },
      });
      return {
        action: "domain.updated",
        ...asUser("admin"),
        targetId: domain.id,
        metadata: { fields: ["unsubscribeEmail", "unsubscribeUrl"] },
      };
    },
  },
  {
    name: "domain verified (dashboard)",
    run: async () => {
      const domain = await seed.domain({ name: "verify.example.org" });
      const spy = spyOn(dnsVerification, "verifyDomain").mockResolvedValue({
        spf: true,
        dkim: false,
        dmarc: true,
        spfReason: undefined,
      });
      try {
        await dash("POST", `/dashboard/domains/${domain.id}/verify`, {
          token: tokens.admin,
        });
      } finally {
        spy.mockRestore();
      }
      return {
        action: "domain.verified",
        ...asUser("admin"),
        targetId: domain.id,
        targetLabel: "verify.example.org",
        metadata: { spf: true, dkim: false, dmarc: true },
      };
    },
  },
  {
    name: "domain added (REST)",
    run: async () => {
      const id = await dataId(
        await rest("POST", "/api/v1/domains", { name: "rest.example.org" }),
      );
      return {
        action: "domain.created",
        ...asKey(),
        targetId: id,
        targetLabel: "rest.example.org",
      };
    },
  },
  {
    name: "domain updated (REST)",
    run: async () => {
      const domain = await seed.domain({ name: "patch.example.org" });
      await rest("PATCH", `/api/v1/domains/${domain.id}`, {
        unsubscribeEmail: "unsub@example.org",
      });
      return {
        action: "domain.updated",
        ...asKey(),
        targetId: domain.id,
        metadata: { fields: ["unsubscribeEmail"] },
      };
    },
  },
  {
    name: "domain deleted (REST)",
    run: async () => {
      const domain = await seed.domain({ name: "rest-old.example.org" });
      await rest("DELETE", `/api/v1/domains/${domain.id}`);
      return {
        action: "domain.deleted",
        ...asKey(),
        targetId: domain.id,
        targetLabel: "rest-old.example.org",
      };
    },
  },
  {
    name: "domain verified (REST)",
    run: async () => {
      const domain = await seed.domain({ name: "rest-verify.example.org" });
      const spy = spyOn(dnsVerification, "verifyDomain").mockResolvedValue({
        spf: false,
        dkim: true,
        dmarc: false,
        spfReason: undefined,
      });
      try {
        await rest("POST", `/api/v1/domains/${domain.id}/verify`);
      } finally {
        spy.mockRestore();
      }
      return {
        action: "domain.verified",
        ...asKey(),
        targetId: domain.id,
        metadata: { spf: false, dkim: true, dmarc: false },
      };
    },
  },

  /* ─── Webhooks (labelled by origin: the path and query may hold a credential) ─── */
  {
    name: "webhook created (dashboard)",
    run: async () => {
      await seed.apiKey({
        name: "admin's key",
        createdByUserId: ids.admin,
        isAdmin: true,
      });
      await dash("POST", "/dashboard/webhooks", {
        token: tokens.admin,
        body: { url: HOOK_URL, events: "email.sent" },
      });
      return {
        action: "webhook.created",
        ...asUser("admin"),
        targetType: "webhook",
        targetLabel: "https://93.184.216.34",
        metadata: { events: ["email.sent"] },
      };
    },
  },
  {
    name: "webhook deleted (dashboard)",
    run: async () => {
      const hook = await seed.webhook({
        apiKeyId: adminKey.id,
        url: HOOK_URL,
        events: ["email.sent"],
      });
      await dash("POST", `/dashboard/webhooks/${hook.id}/delete`, {
        token: tokens.admin,
      });
      return {
        action: "webhook.deleted",
        ...asUser("admin"),
        targetId: hook.id,
        targetLabel: "https://93.184.216.34",
      };
    },
  },
  {
    name: "webhook created (REST)",
    run: async () => {
      const id = await dataId(
        await rest("POST", "/api/v1/webhooks", {
          url: HOOK_URL,
          events: ["email.bounced"],
        }),
      );
      return {
        action: "webhook.created",
        ...asKey(),
        targetId: id,
        targetLabel: "https://93.184.216.34",
        metadata: { events: ["email.bounced"] },
      };
    },
  },
  {
    name: "webhook deleted (REST)",
    run: async () => {
      const hook = await seed.webhook({
        apiKeyId: adminKey.id,
        url: HOOK_URL,
        events: ["email.sent"],
      });
      await rest("DELETE", `/api/v1/webhooks/${hook.id}`);
      return { action: "webhook.deleted", ...asKey(), targetId: hook.id };
    },
  },

  /* ─── Suppressions ─── */
  {
    name: "suppression added (REST)",
    run: async () => {
      const id = await dataId(
        await rest("POST", "/api/v1/suppressions", {
          email: "blocked@example.org",
          reason: "manual",
        }),
      );
      return {
        action: "suppression.created",
        ...asKey(),
        targetType: "suppression",
        targetId: id,
        targetLabel: "blocked@example.org",
        metadata: { reason: "manual" },
      };
    },
  },
  {
    name: "suppression removed (REST)",
    run: async () => {
      const row = await seed.suppression({
        apiKeyId: adminKey.id,
        email: "x@example.org",
      });
      await rest("DELETE", `/api/v1/suppressions/${row.id}`);
      return {
        action: "suppression.deleted",
        ...asKey(),
        targetId: row.id,
        targetLabel: "x@example.org",
      };
    },
  },
  {
    name: "suppression removed (dashboard)",
    run: async () => {
      const row = await seed.suppression({
        apiKeyId: adminKey.id,
        email: "y@example.org",
      });
      await dash("POST", `/dashboard/suppressions/${row.id}/delete`, {
        token: tokens.admin,
      });
      return {
        action: "suppression.deleted",
        ...asUser("admin"),
        targetId: row.id,
        targetLabel: "y@example.org",
      };
    },
  },
];

describe("every wired action is recorded (#221)", () => {
  test.each(CASES.map((c) => [c.name, c] as const))("%s", async (_name, wired) => {
    const alerts = spyOn(twoFactorAlert, "sendTwoFactorAlert").mockResolvedValue({
      sent: true,
    });
    let expected: Expected;
    try {
      expected = await wired.run();
    } finally {
      alerts.mockRestore();
    }
    const rows = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, expected.action),
          eq(auditEvents.outcome, expected.outcome ?? "success"),
        ),
      )
      .orderBy(desc(auditEvents.occurredAt));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const [event] = rows;
    const { outcome, ...fields } = expected;
    const wanted = Object.fromEntries(
      Object.entries({ ...fields, outcome: outcome ?? "success" }).filter(
        ([, value]) => value !== undefined,
      ),
    );
    expect(event).toMatchObject(wanted);
    /** Every HTTP case carries the client's user agent. */
    if (expected.ip !== null) expect(event?.userAgent).toBe(UA);
  });
});

describe("no secrets in the log", () => {
  test("a session of sensitive actions leaves no password, key, token, code or secret in any row", async () => {
    const secrets: string[] = [PASSWORD, NEW_PASSWORD, ...Object.values(tokens)];
    const alerts = spyOn(twoFactorAlert, "sendTwoFactorAlert").mockResolvedValue({
      sent: true,
    });
    try {
      /** Sign-in, a wrong password, a 2FA sign-in with its code. */
      const login = await dash("POST", "/dashboard/login", {
        body: { email: ADMIN, password: PASSWORD },
      });
      secrets.push(readSessionCookie(login.headers.get("set-cookie")) ?? "");
      await dash("POST", "/dashboard/login", {
        body: { email: ADMIN, password: "wrong-pass" },
      });
      secrets.push("wrong-pass");
      const key = await seedTotp(ids.member);
      const pending = await pendingLogin(MEMBER);
      secrets.push(pending);
      const code = codeNow(key);
      secrets.push(code);
      await dash("POST", "/dashboard/login/two-factor", {
        token: pending,
        body: { code },
      });

      /** Password change, reset link, invitation (token in the link). */
      await dash("POST", "/dashboard/account/password", {
        token: tokens.admin,
        body: { current: PASSWORD, password: NEW_PASSWORD, confirm: NEW_PASSWORD },
      });
      const reset = await issuePasswordReset(ids.owner, ids.admin);
      if (!reset.ok) throw new Error("not issued");
      secrets.push(tokenOf(reset.url));
      const invite = await createInvitation(
        { id: ids.owner, role: "owner" },
        "new@example.org",
        "admin",
      );
      if (!invite.ok) throw new Error("not issued");
      secrets.push(invite.invitation.token);

      /** An API key and a webhook over REST: both return their secret once. */
      const created: unknown = await (
        await rest("POST", "/api/v1/api-keys", { name: "secret holder" })
      ).json();
      const hook: unknown = await (
        await rest("POST", "/api/v1/webhooks", { url: HOOK_URL, events: ["email.sent"] })
      ).json();
      for (const body of [created, hook]) {
        const data: unknown =
          typeof body === "object" && body !== null
            ? Reflect.get(body, "data")
            : undefined;
        for (const field of ["key", "secret"]) {
          const value: unknown =
            typeof data === "object" && data !== null
              ? Reflect.get(data, field)
              : undefined;
          if (typeof value === "string") secrets.push(value);
        }
      }
      secrets.push(adminKey.rawKey, "s3cr3t-path", "token=abc");
    } finally {
      alerts.mockRestore();
    }

    const rows = await db.select().from(auditEvents);
    expect(rows.length).toBeGreaterThanOrEqual(8);
    const dump = JSON.stringify(rows);
    for (const secret of secrets.filter((value) => value.length >= 6)) {
      expect(dump).not.toContain(secret);
    }
    /** No metadata key is named like a secret. */
    for (const row of rows) {
      for (const field of Object.keys(row.metadata ?? {})) {
        expect(field).not.toMatch(/(?:password|secret|token|hash|cookie|credential)/i);
        expect(field).not.toMatch(/code$/i);
      }
    }
  });
});
