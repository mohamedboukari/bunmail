import { describe, test, expect, mock, beforeAll, beforeEach } from "bun:test";
import { Elysia } from "elysia";
import type {
  AcceptInvitationResult,
  AccountActionResult,
  AccountSummary,
  ActiveSession,
  AttemptLimiter,
  CompletePasswordResetResult,
  CompletedOwnerSetup,
  CreatedSession,
  InviteAcceptance,
  InviteActor,
  InviteTarget,
  IssueInvitationResult,
  IssuePasswordResetResult,
  PasswordResetTarget,
  PendingInvitation,
  LoginResult,
  NewSessionInput,
  RotatedSession,
  SessionAssurance,
  SessionClient,
  UserRole,
} from "../../src/modules/users/types/user.types.ts";

/**
 * E2E tests for the dashboard.
 *
 * Tests the full HTTP request/response cycle for dashboard routes
 * including login, session management, and page rendering.
 *
 * Mocks the DB and services to avoid requiring a running database. The
 * session and login services (#216) are replaced by in-memory fakes; their
 * SQL is covered by dashboard-session.integration.test.ts.
 */

/* ─── Mock config ─── */

/** The dashboard config the pages plugin reads. */
const dashboardConfig = {
  /** Unset in this stub; the owner bootstrap runs in index.ts, not here. */
  ownerEmail: null,
  /** Read only by index.ts; present so a leak of this stub has no holes. */
  legacyAuthEnv: [],
  /** Trust one proxy hop so tests can drive distinct client IPs via
   *  the X-Forwarded-For header (app.handle has no real socket). */
  trustedProxyHops: 1,
  loginRateLimit: { enabled: true, maxAttempts: 5, windowSec: 900 },
};

void mock.module("../../src/config.ts", () => ({
  config: {
    env: "development",
    appBaseUrl: "",
    database: { url: "postgres://test:test@localhost/test" },
    server: { port: 3000, host: "0.0.0.0" },
    mail: { hostname: "localhost" },
    dashboard: dashboardConfig,
    /** Read by the invitation services (#217), which are mocked below. */
    systemMailFrom: null,
    invites: { expiryDays: 7 },
    logLevel: "error",
    logRedactPii: false,
  },
}));

/* ─── Mock logger ─── */

/** Kept so tests can assert audit lines (#215, #216). */
const warnLog = mock((_message: string, _data?: Record<string, unknown>) => {});
const errorLog = mock((_message: string, _data?: Record<string, unknown>) => {});
const infoLog = mock((_message: string, _data?: Record<string, unknown>) => {});

void mock.module("../../src/utils/logger.ts", () => ({
  logger: {
    debug: mock(() => {}),
    info: infoLog,
    warn: warnLog,
    error: errorLog,
  },
}));

/* ─── Mock services ─── */
void mock.module("../../src/modules/emails/services/stats.service.ts", () => ({
  getDashboardStats: mock(() =>
    Promise.resolve({
      totalEmails: 42,
      sentCount: 35,
      failedCount: 3,
      queuedCount: 4,
      sentLast24h: 7,
      failedLast24h: 0,
      successRate: 35 / 38,
      inboundTotal: 9,
      inboundLast24h: 2,
      emailsInTrash: 1,
      inboundInTrash: 0,
      totalApiKeys: 5,
      activeApiKeys: 4,
      totalDomains: 2,
      totalTemplates: 6,
      totalWebhooks: 1,
    }),
  ),
}));

void mock.module("../../src/modules/emails/services/email.service.ts", () => ({
  /** Reads */
  listAllEmails: mock(() => Promise.resolve({ data: [], total: 0 })),
  listEmails: mock(() => Promise.resolve({ data: [], total: 0 })),
  getEmailByIdUnscoped: mock(() => Promise.resolve(undefined)),
  getEmailById: mock(() => Promise.resolve(undefined)),
  createEmail: mock(() => Promise.resolve({})),
  /** Trash: included so this mock can leak into other e2e tests
   *  without stripping fields they depend on. */
  trashEmail: mock(() => Promise.resolve(undefined)),
  trashEmails: mock(() => Promise.resolve(0)),
  trashEmailUnscoped: mock(() => Promise.resolve(undefined)),
  trashEmailsUnscoped: mock(() => Promise.resolve(0)),
  restoreEmail: mock(() => Promise.resolve(undefined)),
  restoreEmailUnscoped: mock(() => Promise.resolve(undefined)),
  permanentDeleteEmail: mock(() => Promise.resolve(undefined)),
  permanentDeleteEmailUnscoped: mock(() => Promise.resolve(undefined)),
  emptyEmailsTrash: mock(() => Promise.resolve(0)),
  emptyEmailsTrashUnscoped: mock(() => Promise.resolve(0)),
  listTrashedEmails: mock(() => Promise.resolve({ data: [], total: 0 })),
  listTrashedEmailsUnscoped: mock(() => Promise.resolve({ data: [], total: 0 })),
  getTrashedEmailByIdUnscoped: mock(() => Promise.resolve(undefined)),
}));

/** A key row as the fake api-key service returns it. */
function fakeKey(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "key_test123",
    name: "Test Key",
    keyHash: "abc",
    keyPrefix: "bm_live_test",
    isActive: true,
    isAdmin: false,
    allowedSenders: [],
    createdByUserId: null,
    disabledReason: null,
    lastUsedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

/** Every export of api-key.service.ts: mock.module leaks across files (#121). */
const listApiKeys = mock((_actor?: unknown) => Promise.resolve([]));
const createApiKey = mock((_input: unknown, _actor?: unknown) =>
  Promise.resolve({
    apiKey: fakeKey(),
    rawKey: "bm_live_test1234567890abcdef12345678",
  }),
);
void mock.module("../../src/modules/api-keys/services/api-key.service.ts", () => ({
  listApiKeys,
  createApiKey,
  revokeApiKey: mock(() => Promise.resolve(fakeKey({ isActive: false }))),
  /**
   * Included so a cross-file `mock.module` leak (this mock shadowing
   * api-keys-api.test.ts under CI's file order) can't leave `updateApiKey`
   * undefined. See #126 / the redact.test.ts leak fix (#121).
   */
  updateApiKey: mock(() => Promise.resolve(fakeKey())),
  findByHash: mock(() => Promise.resolve(undefined)),
  findById: mock(() => Promise.resolve(undefined)),
  setApiKeyAdmin: mock(() => Promise.resolve({ ok: false, reason: "not_found" })),
  findDashboardKeyFor: mock(() => Promise.resolve(undefined)),
}));

void mock.module("../../src/modules/domains/services/domain.service.ts", () => ({
  listDomains: mock(() => Promise.resolve([])),
  createDomain: mock(() =>
    Promise.resolve({
      id: "dom_test123",
      name: "example.com",
      dkimPrivateKey: null,
      dkimPublicKey: null,
      dkimSelector: "bunmail",
      spfVerified: false,
      dkimVerified: false,
      dmarcVerified: false,
      verifiedAt: null,
      unsubscribeEmail: null,
      unsubscribeUrl: null,
      notifyEmail: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  ),
  getDomainById: mock(() => Promise.resolve(undefined)),
  deleteDomain: mock(() => Promise.resolve(undefined)),
  getDkimDnsRecord: mock(() => null),
}));

void mock.module(
  "../../src/modules/domains/services/dns-verification.service.ts",
  () => ({
    verifyDomain: mock(() => Promise.resolve()),
  }),
);

/** What the fake ownership-checked template changes answer (#219); tests swap it. */
type FakeTemplateChange = { ok: false; reason: "not_found" | "forbidden" };
const updateTemplateAs = mock(
  (_id: string, _actor: unknown, _input: unknown): Promise<FakeTemplateChange> =>
    Promise.resolve({ ok: false, reason: "not_found" }),
);
const deleteTemplateAs = mock(
  (_id: string, _actor: unknown): Promise<FakeTemplateChange> =>
    Promise.resolve({ ok: false, reason: "not_found" }),
);

/** Every export of template.service.ts: mock.module leaks across files. */
void mock.module("../../src/modules/templates/services/template.service.ts", () => ({
  MAX_RENDERED_BODY_LENGTH: 5 * 1024 * 1024,
  MAX_RENDERED_SUBJECT_LENGTH: 500,
  renderTemplate: mock(() => ""),
  createTemplate: mock(() => Promise.resolve({})),
  listTemplates: mock(() => Promise.resolve([])),
  listAllTemplates: mock(() => Promise.resolve([])),
  getTemplateByIdUnscoped: mock(() => Promise.resolve(undefined)),
  getTemplateById: mock(() => Promise.resolve(undefined)),
  updateTemplate: mock(() => Promise.resolve({})),
  deleteTemplate: mock(() => Promise.resolve(undefined)),
  updateTemplateAs,
  deleteTemplateAs,
}));

void mock.module("../../src/modules/webhooks/services/webhook.service.ts", () => ({
  createWebhook: mock(() => Promise.resolve({})),
  listWebhooks: mock(() => Promise.resolve([])),
  listAllWebhooks: mock(() => Promise.resolve([])),
  deleteWebhook: mock(() => Promise.resolve(undefined)),
  findWebhooksForEvent: mock(() => Promise.resolve([])),
}));

void mock.module("../../src/modules/inbound/services/inbound.service.ts", () => ({
  listInboundEmails: mock(() => Promise.resolve({ data: [], total: 0 })),
  listTrashedInboundEmails: mock(() => Promise.resolve({ data: [], total: 0 })),
  getInboundEmailById: mock(() => Promise.resolve(undefined)),
  getTrashedInboundEmailById: mock(() => Promise.resolve(undefined)),
  trashInboundEmail: mock(() => Promise.resolve(undefined)),
  trashInboundEmails: mock(() => Promise.resolve(0)),
  restoreInboundEmail: mock(() => Promise.resolve(undefined)),
  permanentDeleteInboundEmail: mock(() => Promise.resolve(undefined)),
  emptyInboundTrash: mock(() => Promise.resolve(0)),
}));

/**
 * Owner setup (#215). `db` is mocked as `{}` below, so the real service
 * cannot run here; its database behaviour is covered by
 * owner-setup.integration.test.ts. Well-formed tokens (43 base64url
 * characters): LIVE_TOKEN is live, anything else is not.
 */
const LIVE_TOKEN = "L".repeat(40) + "i_v";
const UNKNOWN_TOKEN = "U".repeat(40) + "n-k";
const OWNER = { userId: "usr_owner", email: "owner@example.com" };

/* ─── In-memory sessions (#216) ─── */

/** One fake session, keyed in `fakeSessions` by its current token. */
interface FakeSession {
  sessionId: string;
  userId: string;
  /** The account's email and role (#222); the owner unless a test says otherwise. */
  email: string;
  role: UserRole;
  assurance: SessionAssurance;
  /** The token the last rotation replaced, if any. */
  previous: string | null;
  /** Every token the session rotated away from (`session_token_history`). */
  history: string[];
  /** What `findActiveSession` reports; tests flip these. */
  rotationDue: boolean;
  graceOver: boolean;
}

const fakeSessions = new Map<string, FakeSession>();
let fakeCounter = 0;

/** A well-formed (43 base64url characters), unique fake token. */
function fakeToken(): string {
  fakeCounter += 1;
  return `T${String(fakeCounter).padStart(42, "0")}`;
}

/** Stores a fake session and returns its token. */
function seedSession(overrides: Partial<FakeSession> = {}): string {
  const token = fakeToken();
  fakeSessions.set(token, {
    sessionId: `ses_${fakeCounter}`,
    userId: OWNER.userId,
    email: OWNER.email,
    role: "owner",
    assurance: "password",
    previous: null,
    history: [],
    rotationDue: false,
    graceOver: false,
    ...overrides,
  });
  return token;
}

const createSession = mock(
  (input: NewSessionInput, _executor?: unknown): Promise<CreatedSession> => {
    const token = seedSession({ userId: input.userId, assurance: input.assurance });
    return Promise.resolve({ sessionId: `ses_${fakeCounter}`, token });
  },
);

/** Mirrors the real query: current or previous token, admitted assurance only. */
const findActiveSession = mock((token: string): Promise<ActiveSession | null> => {
  for (const [current, s] of fakeSessions) {
    if (current !== token && s.previous !== token) continue;
    if (s.assurance !== "password" && s.assurance !== "mfa") return Promise.resolve(null);
    return Promise.resolve({
      sessionId: s.sessionId,
      userId: s.userId,
      email: s.email,
      role: s.role,
      assurance: s.assurance,
      matched: current === token ? "current" : "previous",
      rotationDue: s.rotationDue,
      graceOver: s.graceOver,
    });
  }
  return Promise.resolve(null);
});

const rotateSession = mock(
  (_sessionId: string, presented: string): Promise<RotatedSession | null> => {
    const s = fakeSessions.get(presented);
    if (!s) return Promise.resolve(null);
    const token = fakeToken();
    fakeSessions.delete(presented);
    fakeSessions.set(token, {
      ...s,
      previous: presented,
      history: [...s.history, presented],
      rotationDue: false,
    });
    return Promise.resolve({ token, maxAgeSec: 3600 });
  },
);

const revokeSessionByToken = mock((token: string): Promise<string | null> => {
  for (const [current, s] of fakeSessions) {
    if (current === token || s.previous === token) {
      fakeSessions.delete(current);
      return Promise.resolve(s.sessionId);
    }
  }
  return Promise.resolve(null);
});

const revokeAllUserSessions = mock(
  (userId: string, _executor?: unknown): Promise<number> => {
    let count = 0;
    for (const [current, s] of fakeSessions) {
      if (s.userId === userId) {
        fakeSessions.delete(current);
        count += 1;
      }
    }
    return Promise.resolve(count);
  },
);

/** Mirrors the real history lookup: any token a live session rotated away from. */
const findSessionBySupersededToken = mock(
  (token: string): Promise<{ sessionId: string; userId: string } | null> => {
    for (const s of fakeSessions.values()) {
      if (s.history.includes(token)) {
        return Promise.resolve({ sessionId: s.sessionId, userId: s.userId });
      }
    }
    return Promise.resolve(null);
  },
);

/** Every export of session.service.ts: mock.module leaks across files. */
void mock.module("../../src/modules/users/services/session.service.ts", () => ({
  createSession,
  findActiveSession,
  findSessionBySupersededToken,
  rotateSession,
  revokeSessionByToken,
  revokeAllUserSessions,
  purgeExpiredSessions: mock(() => Promise.resolve(0)),
}));

/** The one account the fake login service knows. */
const ACCOUNT = { email: "owner@example.com", password: "the owner password, long" };

const verifyPasswordLogin = mock(
  (email: string, password: string): Promise<LoginResult> => {
    if (email !== ACCOUNT.email) return Promise.resolve({ ok: false, reason: "unknown" });
    if (password !== ACCOUNT.password) {
      return Promise.resolve({ ok: false, reason: "bad_password" });
    }
    return Promise.resolve({
      ok: true,
      userId: OWNER.userId,
      assurance: "password",
      credentialId: "crd_owner",
    });
  },
);

/** Every export of login.service.ts. */
void mock.module("../../src/modules/users/services/login.service.ts", () => ({
  verifyPasswordLogin,
}));

const findLiveOwnerSetup = mock((token: string) =>
  Promise.resolve(token === LIVE_TOKEN ? OWNER : null),
);
/** The session token the last successful fake setup opened. */
let lastSetupSessionToken = "";

const completeOwnerSetup = mock(
  (
    token: string,
    _password: string,
    _client?: SessionClient,
  ): Promise<CompletedOwnerSetup | null> => {
    if (token !== LIVE_TOKEN) return Promise.resolve(null);
    lastSetupSessionToken = seedSession();
    return Promise.resolve({ ...OWNER, sessionToken: lastSetupSessionToken });
  },
);

void mock.module("../../src/modules/users/services/owner.service.ts", () => ({
  findLiveOwnerSetup,
  completeOwnerSetup,
  /** Included so this mock can leak into other files without holes. */
  bootstrapOwner: mock(() => Promise.resolve({ kind: "complete" })),
  issueOwnerSetupLink: mock(() =>
    Promise.resolve({ token: LIVE_TOKEN, email: OWNER.email, expiresAt: new Date() }),
  ),
  /** Used by user-admin.service.ts (#218), which is mocked below. */
  withOwnerLock: mock(() => Promise.reject(new Error("no database in e2e"))),
}));

/* ─── Invitations (#217) ─── */

/**
 * Fake invitation service: the real one needs Postgres and is covered by
 * invitations.integration.test.ts. INVITE_TOKEN is live, anything else is
 * not; TAKEN_INVITE_TOKEN is live but its address got an account.
 */
const INVITE_TOKEN = "I".repeat(40) + "n_v";
const TAKEN_INVITE_TOKEN = "K".repeat(40) + "t-k";
const INVITE_TARGET: InviteTarget = {
  invitationId: "utk_invite",
  email: "new@example.com",
  role: "admin",
};
/** The raw accept link the fake create returns; must never reach a URL. */
const INVITE_URL = `http://localhost:3000/dashboard/invite?token=${INVITE_TOKEN}`;

const findLiveInvitation = mock((token: string): Promise<InviteTarget | null> =>
  Promise.resolve(
    token === INVITE_TOKEN || token === TAKEN_INVITE_TOKEN ? INVITE_TARGET : null,
  ),
);

const acceptInvitation = mock(
  (
    token: string,
    _acceptance: InviteAcceptance,
    _client?: SessionClient,
  ): Promise<AcceptInvitationResult> => {
    if (token === TAKEN_INVITE_TOKEN) {
      return Promise.resolve({ ok: false, reason: "account_exists" });
    }
    if (token !== INVITE_TOKEN) return Promise.resolve({ ok: false, reason: "invalid" });
    const sessionToken = seedSession({ userId: "usr_new", role: "admin" });
    return Promise.resolve({
      ok: true,
      userId: "usr_new",
      email: INVITE_TARGET.email,
      role: "admin",
      invitedBy: OWNER.userId,
      sessionId: `ses_${fakeCounter}`,
      sessionToken,
    });
  },
);

/** What the fake create and resend answer; tests swap it. */
let issueResult: IssueInvitationResult = { ok: false, reason: "invalid_email" };

const createInvitation = mock(
  (_actor: InviteActor, _email: string, _role: string): Promise<IssueInvitationResult> =>
    Promise.resolve(issueResult),
);

const pendingInvitations: PendingInvitation[] = [
  {
    id: "utk_pending",
    email: "<img src=x>@example.com",
    role: "member",
    invitedBy: "<b>Ann</b>",
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
  },
];

/** Every export of invite.service.ts: mock.module leaks across files. */
void mock.module("../../src/modules/users/services/invite.service.ts", () => ({
  findLiveInvitation,
  acceptInvitation,
  createInvitation,
  resendInvitation: mock(
    (_actor: InviteActor, _id: string): Promise<IssueInvitationResult> =>
      Promise.resolve(issueResult),
  ),
  revokeInvitation: mock(() => Promise.resolve({ ok: true })),
  listPendingInvitations: mock(() => Promise.resolve(pendingInvitations)),
  revokeInvitesIssuedBy: mock(() => Promise.resolve(0)),
}));

/* ─── Users (#218) ─── */

/**
 * Fake account management service: the real one needs Postgres and is
 * covered by users-admin.integration.test.ts. The list carries markup in
 * stored values to prove the page escapes them.
 */
const ACCOUNTS: AccountSummary[] = [
  {
    id: OWNER.userId,
    email: OWNER.email,
    name: null,
    role: "owner",
    disabled: false,
    createdAt: new Date(),
  },
  {
    id: "usr_admin",
    email: "admin@example.com",
    name: "<b>Ada</b>",
    role: "admin",
    disabled: false,
    createdAt: new Date(),
  },
  {
    id: "usr_member",
    email: "<i>m</i>@example.com",
    name: "Max",
    role: "member",
    disabled: true,
    createdAt: new Date(),
  },
];

/** What the fake actions answer; tests swap it. */
let accountResult: AccountActionResult = { ok: true };

/** One fake for every action: records the call, answers `accountResult`. */
const accountAction = mock(
  (
    _actorId: string,
    _targetId: string,
    _input?: string,
    _limiter?: AttemptLimiter,
  ): Promise<AccountActionResult> => Promise.resolve(accountResult),
);

/* ─── Password resets (#277) ─── */

/**
 * Fake password reset service: the real one needs Postgres and is covered
 * by password-reset.integration.test.ts. RESET_TOKEN is live; RACED_RESET_TOKEN
 * passes the lookup but its spend fails (an issuer changed meanwhile);
 * anything else is dead.
 */
const RESET_TOKEN = "P".repeat(40) + "r_s";
const RACED_RESET_TOKEN = "Q".repeat(40) + "r-c";
const RESET_TARGET: PasswordResetTarget = {
  resetId: "utk_reset",
  userId: "usr_admin",
  email: "<i>a</i>@example.com",
};
/** The raw reset link the fake issue returns; must never reach a URL or a log. */
const RESET_URL = `https://mail.example.com/dashboard/reset?token=${RESET_TOKEN}`;

const findLivePasswordReset = mock((token: string): Promise<PasswordResetTarget | null> =>
  Promise.resolve(
    token === RESET_TOKEN || token === RACED_RESET_TOKEN ? RESET_TARGET : null,
  ),
);

const completePasswordReset = mock(
  (
    token: string,
    _password: string,
    _client?: SessionClient,
  ): Promise<CompletePasswordResetResult> => {
    if (token !== RESET_TOKEN) return Promise.resolve({ ok: false, reason: "invalid" });
    const sessionToken = seedSession({ userId: "usr_admin", role: "admin" });
    return Promise.resolve({
      ok: true,
      resetId: RESET_TARGET.resetId,
      userId: RESET_TARGET.userId,
      email: RESET_TARGET.email,
      issuedBy: OWNER.userId,
      sessionsRevoked: 2,
      tokensRevoked: 0,
      issuedTokensRevoked: 1,
      sessionId: `ses_${fakeCounter}`,
      sessionToken,
    });
  },
);

/** Every export of password-reset.service.ts: mock.module leaks across files. */
void mock.module("../../src/modules/users/services/password-reset.service.ts", () => ({
  findLivePasswordReset,
  completePasswordReset,
  replaceResetToken: mock(() => Promise.reject(new Error("no database in e2e"))),
  revokeResetLinks: mock(() => Promise.resolve(0)),
}));

/** What the fake reset-link issue answers; tests swap it. */
let resetIssueResult: IssuePasswordResetResult = {
  ok: true,
  resetId: RESET_TARGET.resetId,
  url: RESET_URL,
  usedFallback: false,
  expiresAt: new Date(Date.now() + 3_600_000),
};

const issuePasswordReset = mock(
  (_actorId: string, _targetId: string): Promise<IssuePasswordResetResult> =>
    Promise.resolve(resetIssueResult),
);

/** Every export of user-admin.service.ts: mock.module leaks across files. */
void mock.module("../../src/modules/users/services/user-admin.service.ts", () => ({
  listAccounts: mock(() => Promise.resolve(ACCOUNTS)),
  changeAccountRole: accountAction,
  deactivateAccount: accountAction,
  reactivateAccount: accountAction,
  removeAccount: accountAction,
  transferOwnership: accountAction,
  issuePasswordReset,
}));

void mock.module("../../src/db/index.ts", () => ({
  db: {},
}));

/* ─── Import plugin after mocking ─── */
const { pagesPlugin } = await import("../../src/pages/pages.plugin.tsx");
const { withRequestContext } = await import("../../src/middleware/request-context.ts");
const { UserStoreError } = await import("../../src/modules/users/errors.ts");

/** Test app instance with the pages plugin */
const app = new Elysia().use(pagesPlugin);

/* ─── Helpers ─── */

/** Form-POSTs to /dashboard/login; same-origin unless overridden. */
function postLogin(
  fields: Record<string, string>,
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
      body: new URLSearchParams(fields).toString(),
    }),
  );
}

/** A GET of `path` carrying `bm_session=<token>`. */
function getWithSession(path: string, token: string): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      headers: { cookie: `bm_session=${token}` },
    }),
  );
}

/** The `bm_session` value a response sets, or null. */
function cookieValue(response: Response): string | null {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) return null;
  return setCookie.match(/bm_session=([^;]*)/)?.[1] ?? null;
}

/* ─── Tests ─── */

describe("Dashboard E2E", () => {
  describe("GET /dashboard/login", () => {
    test("returns 200 with the email and password form", async () => {
      const response = await app.handle(new Request("http://localhost/dashboard/login"));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Sign in");
      expect(html).toContain('name="email"');
      expect(html).toContain('name="password"');
    });

    test("carries the auth-page headers: no-store, nosniff, DENY, strict-origin", async () => {
      const response = await app.handle(new Request("http://localhost/dashboard/login"));
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("referrer-policy")).toBe("strict-origin");
    });

    test("shows the generic error when error=invalid", async () => {
      const response = await app.handle(
        new Request("http://localhost/dashboard/login?error=invalid"),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Invalid email or password.");
    });
  });

  describe("POST /dashboard/login", () => {
    beforeEach(() => {
      fakeSessions.clear();
    });

    test("correct email and password: session cookie and 302 to /dashboard", async () => {
      infoLog.mockClear();
      const response = await postLogin(
        { email: " Owner@Example.com ", password: ACCOUNT.password },
        { "x-forwarded-for": "198.51.100.1", "user-agent": "e2e-agent" },
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard");
      expect(response.headers.get("cache-control")).toBe("no-store");

      const setCookie = response.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Lax");
      expect(setCookie).toContain("Path=/dashboard");
      expect(setCookie).toContain("Max-Age=604800");
      expect(setCookie).not.toContain("Secure");
      const token = cookieValue(response) ?? "";
      expect(fakeSessions.has(token)).toBe(true);

      /** The email is normalized before the check; the session gets the client data. */
      expect(verifyPasswordLogin).toHaveBeenLastCalledWith(
        "owner@example.com",
        ACCOUNT.password,
      );
      expect(createSession).toHaveBeenLastCalledWith({
        userId: OWNER.userId,
        assurance: "password",
        authMethod: "password",
        credentialId: "crd_owner",
        ip: "198.51.100.1",
        userAgent: "e2e-agent",
      });

      /** The success log carries ids, never the token. */
      const call = infoLog.mock.calls.find(([m]) => m === "Dashboard login successful");
      expect(call?.[1]).toEqual({
        userId: OWNER.userId,
        sessionId: expect.stringMatching(/^ses_/),
        ip: "198.51.100.1",
      });
      expect(JSON.stringify(infoLog.mock.calls)).not.toContain(token);
    });

    test("two logins get distinct cookies (fresh token each time)", async () => {
      const first = cookieValue(
        await postLogin({ email: ACCOUNT.email, password: ACCOUNT.password }),
      );
      const second = cookieValue(
        await postLogin({ email: ACCOUNT.email, password: ACCOUNT.password }),
      );
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(first).not.toBe(second);
    });

    test("an unknown email and a wrong password get identical responses", async () => {
      warnLog.mockClear();
      const unknown = await postLogin(
        { email: "nobody@example.com", password: ACCOUNT.password },
        { "x-forwarded-for": "198.51.100.2" },
      );
      const wrong = await postLogin(
        { email: ACCOUNT.email, password: "not the password" },
        { "x-forwarded-for": "198.51.100.3" },
      );
      for (const response of [unknown, wrong]) {
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("/dashboard/login?error=invalid");
        expect(response.headers.get("set-cookie")).toBeNull();
      }
      expect(await unknown.text()).toBe(await wrong.text());

      /** The reason reaches the server log only. */
      expect(warnLog).toHaveBeenCalledWith(
        "Dashboard login failed",
        expect.objectContaining({ reason: "unknown", email: "nobody@example.com" }),
      );
      expect(warnLog).toHaveBeenCalledWith(
        "Dashboard login failed",
        expect.objectContaining({ reason: "bad_password" }),
      );
    });

    test("over-long input fails the same way without reaching the password check", async () => {
      const calls = verifyPasswordLogin.mock.calls.length;
      const longPassword = await postLogin(
        { email: ACCOUNT.email, password: "p".repeat(257) },
        { "x-forwarded-for": "198.51.100.4" },
      );
      const longEmail = await postLogin(
        { email: `${"a".repeat(250)}@example.com`, password: ACCOUNT.password },
        { "x-forwarded-for": "198.51.100.4" },
      );
      for (const response of [longPassword, longEmail]) {
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("/dashboard/login?error=invalid");
      }
      expect(verifyPasswordLogin.mock.calls.length).toBe(calls);
    });

    test("a cross-origin or origin-less login is 403 before any work", async () => {
      const calls = verifyPasswordLogin.mock.calls.length;
      const evil = await postLogin(
        { email: ACCOUNT.email, password: ACCOUNT.password },
        { origin: "http://evil.example" },
      );
      expect(evil.status).toBe(403);
      expect(evil.headers.get("set-cookie")).toBeNull();

      const none = await app.handle(
        new Request("http://localhost/dashboard/login", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            email: ACCOUNT.email,
            password: ACCOUNT.password,
          }).toString(),
        }),
      );
      expect(none.status).toBe(403);
      expect(verifyPasswordLogin.mock.calls.length).toBe(calls);
      expect(warnLog).toHaveBeenCalledWith(
        "Dashboard login POST rejected: cross-origin (possible CSRF)",
        expect.objectContaining({ origin: "http://evil.example" }),
      );
    });

    test("a session the browser already holds is revoked before the new one opens", async () => {
      const old = seedSession();
      const response = await postLogin(
        { email: ACCOUNT.email, password: ACCOUNT.password },
        { cookie: `bm_session=${old}` },
      );
      expect(response.status).toBe(302);
      expect(revokeSessionByToken).toHaveBeenLastCalledWith(old);
      expect(fakeSessions.has(old)).toBe(false);
      expect(fakeSessions.has(cookieValue(response) ?? "")).toBe(true);
    });

    test("a legacy cookie on login is not looked up, just replaced", async () => {
      const calls = revokeSessionByToken.mock.calls.length;
      const response = await postLogin(
        { email: ACCOUNT.email, password: ACCOUNT.password },
        { cookie: `bm_session=1700000000.${"a".repeat(64)}` },
      );
      expect(response.status).toBe(302);
      expect(revokeSessionByToken.mock.calls.length).toBe(calls);
    });

    test("a session store error is a 503 page, not a 500", async () => {
      createSession.mockImplementationOnce(() => Promise.reject(new Error("db down")));
      const response = await postLogin(
        { email: ACCOUNT.email, password: ACCOUNT.password },
        { "x-forwarded-for": "198.51.100.5" },
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.text()).toBe("Dashboard temporarily unavailable");
      expect(errorLog).toHaveBeenCalledWith(
        "Dashboard login failed: session store error",
        expect.objectContaining({ error: "db down" }),
      );
    });

    test("a credential replaced between the check and the session (#277) is a failed login", async () => {
      createSession.mockImplementationOnce(() =>
        Promise.reject(new UserStoreError("23503")),
      );
      warnLog.mockClear();
      const response = await postLogin(
        { email: ACCOUNT.email, password: ACCOUNT.password },
        { "x-forwarded-for": "198.51.100.6" },
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard/login?error=invalid");
      expect(response.headers.get("set-cookie")).toBeNull();
      const failed = warnLog.mock.calls.find(([m]) => m === "Dashboard login failed");
      expect(failed?.[1]).toMatchObject({ reason: "credential_replaced" });
    });
  });

  describe("POST /dashboard/login brute-force protection (#109)", () => {
    /** Each test uses a distinct X-Forwarded-For so the module-level
     *  attempt map doesn't bleed across cases. */
    const wrongLogin = (ip: string): Promise<Response> =>
      postLogin(
        { email: ACCOUNT.email, password: "wrongpassword" },
        { "x-forwarded-for": ip },
      );

    test("blocks with 429 + Retry-After after 5 failed attempts from one IP", async () => {
      const ip = "9.9.9.9";
      /** First 5 wrong attempts redirect with the generic error. */
      for (let i = 0; i < 5; i++) {
        const res = await wrongLogin(ip);
        expect(res.status).toBe(302);
      }
      /** The 6th is locked out, before the password check. */
      const calls = verifyPasswordLogin.mock.calls.length;
      const blocked = await wrongLogin(ip);
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("retry-after")).toBeTruthy();
      expect(verifyPasswordLogin.mock.calls.length).toBe(calls);
      const html = await blocked.text();
      expect(html).toContain("Too many failed attempts");
      /** The lockout response disables the form (standalone `disabled`
       *  attribute, distinct from the `disabled:` Tailwind classes). */
      expect(/disabled(?![:\w-])/.test(html)).toBe(true);
    });

    test("a parallel burst cannot outrun the limit (attempt counted before the password check)", async () => {
      const ip = "9.9.9.14";
      const calls = verifyPasswordLogin.mock.calls.length;
      const responses = await Promise.all(
        Array.from({ length: 10 }, () => wrongLogin(ip)),
      );
      const blocked = responses.filter((r) => r.status === 429).length;
      expect(verifyPasswordLogin.mock.calls.length - calls).toBeLessThanOrEqual(5);
      expect(blocked).toBeGreaterThanOrEqual(5);
    });

    test("every failure kind counts: unknown emails lock the IP out too", async () => {
      const ip = "9.9.9.13";
      for (let i = 0; i < 5; i++) {
        await postLogin(
          { email: `nobody${i}@example.com`, password: "x" },
          { "x-forwarded-for": ip },
        );
      }
      expect((await wrongLogin(ip)).status).toBe(429);
    });

    test("lockout is per-IP: a different IP is unaffected", async () => {
      const attacker = "9.9.9.10";
      for (let i = 0; i < 6; i++) await wrongLogin(attacker);

      /** A wrong password from a fresh IP still gets the normal redirect,
       *  not a 429. */
      const other = await wrongLogin("9.9.9.11");
      expect(other.status).toBe(302);
      expect(other.headers.get("location")).toBe("/dashboard/login?error=invalid");
    });

    test("a successful login clears the IP's failure counter", async () => {
      const ip = "9.9.9.12";
      /** Burn 4 failures (still under the limit of 5). */
      for (let i = 0; i < 4; i++) await wrongLogin(ip);

      /** The right password from the same IP succeeds and resets the counter. */
      const ok = await postLogin(
        { email: ACCOUNT.email, password: ACCOUNT.password },
        { "x-forwarded-for": ip },
      );
      expect(ok.status).toBe(302);
      expect(ok.headers.get("location")).toBe("/dashboard");

      /** With the counter cleared, 5 fresh failures are needed again, so a
       *  single wrong attempt still just redirects. */
      const after = await wrongLogin(ip);
      expect(after.status).toBe(302);
      expect(after.headers.get("location")).toBe("/dashboard/login?error=invalid");
    });
  });

  describe("Protected routes without a usable session", () => {
    test("GET /dashboard redirects to login", async () => {
      const response = await app.handle(new Request("http://localhost/dashboard"));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard/login");
    });

    test("GET /dashboard/emails redirects to login", async () => {
      const response = await app.handle(new Request("http://localhost/dashboard/emails"));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard/login");
    });

    test("a legacy <ts>.<hmac> cookie is cleared with no lookup", async () => {
      const calls = findActiveSession.mock.calls.length;
      const response = await getWithSession(
        "/dashboard",
        `${Math.floor(Date.now() / 1000)}.${"a".repeat(64)}`,
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard/login");
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
      expect(cookieValue(response)).toBe("");
      expect(findActiveSession.mock.calls.length).toBe(calls);
    });

    test("an unknown well-formed token is looked up, then cleared", async () => {
      const response = await getWithSession("/dashboard", fakeToken());
      expect(response.status).toBe(302);
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    });

    test("a pending (second factor outstanding) session is rejected", async () => {
      const token = seedSession({ assurance: "pending" });
      const response = await getWithSession("/dashboard", token);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard/login");
    });

    test("a session lookup error is a 503, never a pass-through or a logout", async () => {
      const token = seedSession();
      findActiveSession.mockImplementationOnce(() =>
        Promise.reject(new Error("User store query failed (SQLSTATE 57P01)")),
      );
      const response = await getWithSession("/dashboard", token);
      expect(response.status).toBe(503);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.text()).toBe("Dashboard temporarily unavailable");
      expect(errorLog).toHaveBeenCalledWith(
        "Dashboard session lookup failed",
        expect.objectContaining({ error: "User store query failed (SQLSTATE 57P01)" }),
      );
      /** The session itself is untouched: the next request works. */
      expect((await getWithSession("/dashboard", token)).status).toBe(200);
    });
  });

  describe("Session rotation and reuse detection (#216)", () => {
    /**
     * A thief who keeps a stolen session active rotates it every minute,
     * so the victim's copy falls two or more generations behind. The
     * history table still recognizes it: every session of the user ends.
     */
    test("a token two or more rotations old is reuse: every session of the user is revoked", async () => {
      const stale = fakeToken();
      const thief = seedSession({ history: [stale, fakeToken()] });
      const otherDevice = seedSession();
      const revokes = revokeAllUserSessions.mock.calls.length;

      const response = await getWithSession("/dashboard", stale);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard/login");
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
      expect(revokeAllUserSessions.mock.calls.length).toBe(revokes + 1);
      expect(fakeSessions.has(thief)).toBe(false);
      expect(fakeSessions.has(otherDevice)).toBe(false);
    });

    test("signing in again with a superseded cookie also ends the thief's session", async () => {
      const stale = fakeToken();
      const thief = seedSession({ history: [stale] });
      const response = await postLogin(
        { email: ACCOUNT.email, password: ACCOUNT.password },
        { "x-forwarded-for": "9.9.8.1", cookie: `bm_session=${stale}` },
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard");
      expect(fakeSessions.has(thief)).toBe(false);
    });

    test("logging out with a superseded cookie also ends the thief's session", async () => {
      const stale = fakeToken();
      const thief = seedSession({ history: [stale] });
      const response = await app.handle(
        new Request("http://localhost/dashboard/logout", {
          method: "POST",
          headers: { origin: "http://localhost", cookie: `bm_session=${stale}` },
        }),
      );
      expect(response.status).toBe(302);
      expect(fakeSessions.has(thief)).toBe(false);
    });

    test("an unknown well-formed token is rejected without revoking anything", async () => {
      const bystander = seedSession();
      const revokes = revokeAllUserSessions.mock.calls.length;
      const response = await getWithSession("/dashboard", fakeToken());
      expect(response.status).toBe(302);
      expect(revokeAllUserSessions.mock.calls.length).toBe(revokes);
      expect(fakeSessions.has(bystander)).toBe(true);
    });

    test("a due rotation sends a new cookie that then works", async () => {
      const token = seedSession({ rotationDue: true });
      const response = await getWithSession("/dashboard", token);
      expect(response.status).toBe(200);
      const fresh = cookieValue(response) ?? "";
      expect(fresh).not.toBe(token);
      expect(fresh).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(response.headers.get("set-cookie")).toContain("Max-Age=3600");
      expect(response.headers.get("set-cookie")).toContain("HttpOnly");

      const next = await getWithSession("/dashboard", fresh);
      expect(next.status).toBe(200);
      expect(next.headers.get("set-cookie")).toBeNull();
    });

    test("no rotation due: served without a new cookie and without a write", async () => {
      const calls = rotateSession.mock.calls.length;
      const response = await getWithSession("/dashboard", seedSession());
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(rotateSession.mock.calls.length).toBe(calls);
    });

    test("the previous token inside the grace period is served, no cookie, no write", async () => {
      const token = seedSession({ rotationDue: true });
      await getWithSession("/dashboard", token);
      const calls = rotateSession.mock.calls.length;

      const late = await getWithSession("/dashboard", token);
      expect(late.status).toBe(200);
      expect(late.headers.get("set-cookie")).toBeNull();
      expect(rotateSession.mock.calls.length).toBe(calls);
    });

    test("a lost rotation race is served without a new cookie", async () => {
      rotateSession.mockImplementationOnce(() => Promise.resolve(null));
      const response = await getWithSession(
        "/dashboard",
        seedSession({ rotationDue: true }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toBeNull();
    });

    test("a rotation error is logged and the request still served", async () => {
      rotateSession.mockImplementationOnce(() => Promise.reject(new Error("db hiccup")));
      const response = await getWithSession(
        "/dashboard",
        seedSession({ rotationDue: true }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(errorLog).toHaveBeenCalledWith(
        "Dashboard session rotation failed",
        expect.objectContaining({ error: "db hiccup" }),
      );
    });

    test("the previous token after the grace period revokes every session of the user", async () => {
      warnLog.mockClear();
      const stolen = seedSession({ rotationDue: true, userId: "usr_victim" });
      const rotated = await getWithSession("/dashboard", stolen);
      const fresh = cookieValue(rotated) ?? "";
      const otherDevice = seedSession({ userId: "usr_victim" });
      const bystander = seedSession({ userId: "usr_someone_else" });

      /** The grace period runs out. */
      const session = fakeSessions.get(fresh);
      if (session) session.graceOver = true;

      const reuse = await app.handle(
        new Request("http://localhost/dashboard", {
          headers: { cookie: `bm_session=${stolen}`, "x-forwarded-for": "203.0.113.9" },
        }),
      );
      expect(reuse.status).toBe(302);
      expect(reuse.headers.get("location")).toBe("/dashboard/login");
      expect(reuse.headers.get("set-cookie")).toContain("Max-Age=0");
      expect(revokeAllUserSessions).toHaveBeenLastCalledWith("usr_victim");
      expect(warnLog).toHaveBeenCalledWith(
        "Session token reuse detected: all sessions of the user revoked",
        {
          userId: "usr_victim",
          sessionId: expect.stringMatching(/^ses_/),
          ip: "203.0.113.9",
        },
      );

      /** Both of the victim's sessions are gone, the other user's stays. */
      expect((await getWithSession("/dashboard", fresh)).status).toBe(302);
      expect((await getWithSession("/dashboard", otherDevice)).status).toBe(302);
      expect((await getWithSession("/dashboard", bystander)).status).toBe(200);
    });

    test("a failed revoke on reuse is a 503, never a pass-through", async () => {
      const stolen = seedSession({ rotationDue: true });
      const fresh = cookieValue(await getWithSession("/dashboard", stolen)) ?? "";
      const session = fakeSessions.get(fresh);
      if (session) session.graceOver = true;

      revokeAllUserSessions.mockImplementationOnce(() =>
        Promise.reject(new Error("down")),
      );
      const response = await getWithSession("/dashboard", stolen);
      expect(response.status).toBe(503);
    });

    test("a cross-origin POST is refused before any rotation", async () => {
      const calls = rotateSession.mock.calls.length;
      const response = await app.handle(
        new Request("http://localhost/dashboard/api-keys", {
          method: "POST",
          headers: {
            cookie: `bm_session=${seedSession({ rotationDue: true })}`,
            "content-type": "application/x-www-form-urlencoded",
            origin: "http://evil.example",
          },
          body: "name=CsrfKey",
        }),
      );
      expect(response.status).toBe(403);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(rotateSession.mock.calls.length).toBe(calls);
    });
  });

  describe("Protected routes with valid session", () => {
    /** Get a valid session cookie by logging in */
    let sessionCookie: string;

    beforeAll(async () => {
      const loginResponse = await postLogin({
        email: ACCOUNT.email,
        password: ACCOUNT.password,
      });
      sessionCookie = `bm_session=${cookieValue(loginResponse) ?? ""}`;
    });

    test("GET /dashboard returns 200 with stats", async () => {
      const response = await app.handle(
        new Request("http://localhost/dashboard", {
          headers: { cookie: sessionCookie },
        }),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Dashboard");
      expect(html).toContain("42"); /** totalEmails */
    });

    test("GET /dashboard/emails returns 200", async () => {
      const response = await app.handle(
        new Request("http://localhost/dashboard/emails", {
          headers: { cookie: sessionCookie },
        }),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Emails");
    });

    test("GET /dashboard/api-keys returns 200", async () => {
      const response = await app.handle(
        new Request("http://localhost/dashboard/api-keys", {
          headers: { cookie: sessionCookie },
        }),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("API Keys");
    });

    test("GET /dashboard/domains returns 200", async () => {
      const response = await app.handle(
        new Request("http://localhost/dashboard/domains", {
          headers: { cookie: sessionCookie },
        }),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Domains");
    });

    test("POST /dashboard/api-keys creates key, redirects with a reveal token, NOT the raw key (#132)", async () => {
      const response = await app.handle(
        new Request("http://localhost/dashboard/api-keys", {
          method: "POST",
          headers: {
            cookie: sessionCookie,
            "content-type": "application/x-www-form-urlencoded",
            /** Same-origin: passes the CSRF guard (#133). */
            origin: "http://localhost",
          },
          body: "name=TestKey",
        }),
      );
      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(location).toContain("/dashboard/api-keys");
      /** The raw key MUST NOT appear in the URL (leaks to logs/history/Referer). */
      expect(location).not.toContain("rawKey=");
      expect(location).not.toContain("bm_live_");
      /** Only an opaque one-time reveal token rides in the query. */
      expect(location).toMatch(/[?&]reveal=[a-f0-9]{64}\b/);
    });

    describe("dashboard pagination is clamped, never a 500 (#172)", () => {
      /** Renders /dashboard/inbound and checks what reached the service. */
      const expectListedWith = async (qs: string, expected: object): Promise<void> => {
        const inbound =
          await import("../../src/modules/inbound/services/inbound.service.ts");
        const res = await app.handle(
          new Request(`http://localhost/dashboard/inbound?${qs}`, {
            headers: { cookie: sessionCookie },
          }),
        );
        expect(res.status).toBe(200);
        expect(inbound.listInboundEmails).toHaveBeenLastCalledWith(
          expect.objectContaining(expected),
        );
      };

      test("garbage page/limit fall back to defaults", async () => {
        await expectListedWith("page=0&limit=abc", { page: 1, limit: 20 });
        await expectListedWith("page=-1&limit=0", { page: 1, limit: 20 });
      });

      test("huge page/limit are capped", async () => {
        await expectListedWith("page=99999999999999999999&limit=99999999", {
          page: 1_000_000,
          limit: 100,
        });
      });
    });

    describe("POST /dashboard/send header-injection guard (#202)", () => {
      /** Form-encodes a send with one field overridden. */
      const sendForm = (overrides: Record<string, string>): Promise<Response> =>
        app.handle(
          new Request("http://localhost/dashboard/send", {
            method: "POST",
            headers: {
              cookie: sessionCookie,
              "content-type": "application/x-www-form-urlencoded",
              origin: "http://localhost",
            },
            body: new URLSearchParams({
              apiKeyId: "key_test123",
              from: "hello@example.com",
              to: "user@example.com",
              subject: "hi",
              text: "body",
              ...overrides,
            }).toString(),
          }),
        );

      test("a clean payload passes validation and reaches the handler", async () => {
        /** The mocked key list is empty, so the handler redirects: proof
         *  validation didn't reject it. */
        const response = await sendForm({ cc: "a@example.com, b@example.com" });
        expect(response.status).toBe(302);
      });

      for (const field of ["cc", "bcc", "subject", "replyTo"]) {
        test(`rejects CR/LF in ${field} with 422`, async () => {
          const response = await sendForm({
            [field]: "a@example.com\r\nBcc: victim@example.com",
          });
          expect(response.status).toBe(422);
        });
      }

      test("rejects an over-long cc with 422", async () => {
        const response = await sendForm({ cc: "a@example.com,".repeat(200) });
        expect(response.status).toBe(422);
      });
    });

    test("reveal token shows the raw key exactly once, then is spent (#132)", async () => {
      /** Create → capture the reveal token from the redirect. */
      const created = await app.handle(
        new Request("http://localhost/dashboard/api-keys", {
          method: "POST",
          headers: {
            cookie: sessionCookie,
            "content-type": "application/x-www-form-urlencoded",
            origin: "http://localhost",
          },
          body: "name=RevealKey",
        }),
      );
      const location = created.headers.get("location")!;
      const token = location.match(/[?&]reveal=([a-f0-9]{64})\b/)![1];

      /** First GET with the token renders the raw key from the mock. */
      const first = await app.handle(
        new Request(`http://localhost/dashboard/api-keys?reveal=${token}`, {
          headers: { cookie: sessionCookie },
        }),
      );
      expect(first.status).toBe(200);
      expect(await first.text()).toContain("bm_live_test1234567890abcdef12345678");

      /** Second GET with the SAME token no longer reveals it (single-use). */
      const second = await app.handle(
        new Request(`http://localhost/dashboard/api-keys?reveal=${token}`, {
          headers: { cookie: sessionCookie },
        }),
      );
      expect(second.status).toBe(200);
      expect(await second.text()).not.toContain("bm_live_test1234567890abcdef12345678");
    });

    /** Creates an API key in the session behind `cookie`; returns its reveal token. */
    async function createKeyRevealToken(cookie: string): Promise<string> {
      const created = await app.handle(
        new Request("http://localhost/dashboard/api-keys", {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/x-www-form-urlencoded",
            origin: "http://localhost",
          },
          body: "name=BoundKey",
        }),
      );
      return (
        created.headers.get("location")?.match(/[?&]reveal=([a-f0-9]{64})\b/)?.[1] ?? ""
      );
    }

    /** GETs `path` with `cookie` and returns the HTML. */
    async function pageText(path: string, cookie: string): Promise<string> {
      const response = await app.handle(
        new Request(`http://localhost${path}`, { headers: { cookie } }),
      );
      expect(response.status).toBe(200);
      return response.text();
    }

    test("another session cannot redeem the reveal token, and the creator still can (#280)", async () => {
      const token = await createKeyRevealToken(sessionCookie);
      expect(token).not.toBe("");
      const otherSession = `bm_session=${seedSession()}`;

      const stolen = await pageText(`/dashboard/api-keys?reveal=${token}`, otherSession);
      expect(stolen).not.toContain("bm_live_test1234567890abcdef12345678");

      /** The mismatch did not burn it: the creator still sees the key once. */
      const own = await pageText(`/dashboard/api-keys?reveal=${token}`, sessionCookie);
      expect(own).toContain("bm_live_test1234567890abcdef12345678");
    });

    test("an API-key reveal token shows nothing on the webhooks page (#280)", async () => {
      const token = await createKeyRevealToken(sessionCookie);
      const webhooks = await pageText(
        `/dashboard/webhooks?reveal=${token}`,
        sessionCookie,
      );
      expect(webhooks).not.toContain("bm_live_test1234567890abcdef12345678");

      const own = await pageText(`/dashboard/api-keys?reveal=${token}`, sessionCookie);
      expect(own).toContain("bm_live_test1234567890abcdef12345678");
    });

    test("POST /dashboard/domains creates domain and redirects", async () => {
      const response = await app.handle(
        new Request("http://localhost/dashboard/domains", {
          method: "POST",
          headers: {
            cookie: sessionCookie,
            "content-type": "application/x-www-form-urlencoded",
            origin: "http://localhost",
          },
          body: "name=example.com",
        }),
      );
      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(location).toContain("/dashboard/domains");
      expect(location).toContain("flash=");
    });

    test("rejects a cross-origin POST with 403 (CSRF guard, #133)", async () => {
      const response = await app.handle(
        new Request("http://localhost/dashboard/api-keys", {
          method: "POST",
          headers: {
            cookie: sessionCookie,
            "content-type": "application/x-www-form-urlencoded",
            /** Attacker's origin ≠ request host → rejected. */
            origin: "http://evil.example",
          },
          body: "name=CsrfKey",
        }),
      );
      expect(response.status).toBe(403);
    });

    test("rejects a POST with no Origin/Referer header (CSRF guard, #133)", async () => {
      const response = await app.handle(
        new Request("http://localhost/dashboard/api-keys", {
          method: "POST",
          headers: {
            cookie: sessionCookie,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "name=NoOriginKey",
        }),
      );
      expect(response.status).toBe(403);
    });
  });

  describe("Owner setup", () => {
    const GOOD_PASSWORD = "correct horse battery staple";

    /** Form-POSTs to /dashboard/setup; same-origin unless overridden. */
    const postSetup = (
      fields: Record<string, string>,
      headers: Record<string, string> = { origin: "http://localhost" },
    ): Promise<Response> =>
      app.handle(
        new Request("http://localhost/dashboard/setup", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
          body: new URLSearchParams(fields).toString(),
        }),
      );

    /** The leak-hardening headers every setup response carries. */
    const expectAuthPageHeaders = (response: Response): void => {
      expect(response.headers.get("cache-control")).toBe("no-store");
      /**
       * strict-origin, never no-referrer: under no-referrer browsers send
       * `Origin: null` on the form POST and setup could never complete.
       */
      expect(response.headers.get("referrer-policy")).toBe("strict-origin");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
    };

    test("GET with a live token and no cookie renders the form (public route)", async () => {
      const response = await app.handle(
        new Request(`http://localhost/dashboard/setup?token=${LIVE_TOKEN}`),
      );
      expect(response.status).toBe(200);
      expectAuthPageHeaders(response);
      const html = await response.text();
      expect(html).toContain('action="/dashboard/setup"');
      expect(html).toContain(`name="token" value="${LIVE_TOKEN}"`);
      expect(html).toContain("owner@example.com");
      expect(html).toContain('<meta name="referrer" content="strict-origin"');
    });

    test("GET without, with a malformed or with an unknown token: identical 400s", async () => {
      const calls = findLiveOwnerSetup.mock.calls.length;
      const missing = await app.handle(new Request("http://localhost/dashboard/setup"));
      const malformed = await app.handle(
        new Request("http://localhost/dashboard/setup?token=not-a-token"),
      );
      /** Neither reached the database. */
      expect(findLiveOwnerSetup.mock.calls.length).toBe(calls);

      const unknown = await app.handle(
        new Request(`http://localhost/dashboard/setup?token=${UNKNOWN_TOKEN}`),
      );
      expect(findLiveOwnerSetup.mock.calls.length).toBe(calls + 1);

      const bodies: string[] = [];
      for (const response of [missing, malformed, unknown]) {
        expect(response.status).toBe(400);
        expectAuthPageHeaders(response);
        bodies.push(await response.text());
      }
      expect(bodies[1]).toBe(bodies[0]);
      expect(bodies[2]).toBe(bodies[0]);
      expect(bodies[0]).toContain("reset-owner");
      expect(bodies[1]).not.toContain("not-a-token");
      expect(bodies[2]).not.toContain(UNKNOWN_TOKEN);
    });

    test("POST with Origin: null (what a no-referrer page would send) is 403", async () => {
      /**
       * Pins why the setup pages use strict-origin: a page under
       * no-referrer makes browsers send `Origin: null`, which the
       * same-origin check rightly rejects, so setup would be impossible.
       */
      const calls = completeOwnerSetup.mock.calls.length;
      const response = await postSetup(
        {
          token: LIVE_TOKEN,
          password: "a-long-enough-password",
          confirm: "a-long-enough-password",
        },
        { origin: "null" },
      );
      expect(response.status).toBe(403);
      expect(completeOwnerSetup.mock.calls.length).toBe(calls);
    });

    test("POST from another origin, or with no origin, is 403 before any work", async () => {
      const findCalls = findLiveOwnerSetup.mock.calls.length;
      const completeCalls = completeOwnerSetup.mock.calls.length;
      const fields = {
        token: LIVE_TOKEN,
        password: GOOD_PASSWORD,
        confirm: GOOD_PASSWORD,
      };

      const evil = await postSetup(fields, { origin: "http://evil.example" });
      expect(evil.status).toBe(403);
      expectAuthPageHeaders(evil);
      expect(evil.headers.get("set-cookie")).toBeNull();

      const noOrigin = await postSetup(fields, {});
      expect(noOrigin.status).toBe(403);

      expect(findLiveOwnerSetup.mock.calls.length).toBe(findCalls);
      expect(completeOwnerSetup.mock.calls.length).toBe(completeCalls);
      expect(warnLog).toHaveBeenCalledWith(
        "Owner setup POST rejected: cross-origin (possible CSRF)",
        expect.objectContaining({ origin: "http://evil.example" }),
      );
    });

    test("POST with a short password or a mismatch re-renders the form, no write", async () => {
      const completeCalls = completeOwnerSetup.mock.calls.length;

      const short = await postSetup({
        token: LIVE_TOKEN,
        password: "short",
        confirm: "short",
      });
      expect(short.status).toBe(200);
      expectAuthPageHeaders(short);
      const shortHtml = await short.text();
      expect(shortHtml).toContain("at least 15 characters");
      expect(shortHtml).toContain(`name="token" value="${LIVE_TOKEN}"`);

      const mismatch = await postSetup({
        token: LIVE_TOKEN,
        password: GOOD_PASSWORD,
        confirm: `${GOOD_PASSWORD}!`,
      });
      expect(mismatch.status).toBe(200);
      const mismatchHtml = await mismatch.text();
      expect(mismatchHtml).toContain("do not match");
      expect(mismatchHtml).toContain(`name="token" value="${LIVE_TOKEN}"`);
      /** The password is never echoed back. */
      expect(mismatchHtml).not.toContain(GOOD_PASSWORD);

      expect(completeOwnerSetup.mock.calls.length).toBe(completeCalls);
    });

    test("POST with an unknown or malformed token is the invalid page, no write", async () => {
      const completeCalls = completeOwnerSetup.mock.calls.length;
      for (const token of [UNKNOWN_TOKEN, "bad"]) {
        const response = await postSetup({
          token,
          password: GOOD_PASSWORD,
          confirm: GOOD_PASSWORD,
        });
        expect(response.status).toBe(400);
        expect(await response.text()).toContain("not valid");
      }
      expect(completeOwnerSetup.mock.calls.length).toBe(completeCalls);
    });

    test("a valid POST signs in with the session cookie and redirects to /dashboard", async () => {
      warnLog.mockClear();
      const response = await postSetup({
        token: LIVE_TOKEN,
        password: GOOD_PASSWORD,
        confirm: GOOD_PASSWORD,
      });
      expect(response.status).toBe(302);
      expectAuthPageHeaders(response);
      const location = response.headers.get("location");
      expect(location).toBe("/dashboard");
      expect(location).not.toContain(LIVE_TOKEN);

      const setCookie = response.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("bm_session=");
      /** The cookie is the session completeOwnerSetup opened, nothing else. */
      expect(cookieValue(response)).toBe(lastSetupSessionToken);
      expect(setCookie).toContain("Max-Age=604800");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Lax");
      expect(setCookie).toContain("Path=/dashboard");

      expect(completeOwnerSetup).toHaveBeenLastCalledWith(LIVE_TOKEN, GOOD_PASSWORD, {
        ip: "unknown",
        userAgent: null,
      });
      expect(warnLog).toHaveBeenCalledWith(
        "Owner setup completed",
        expect.objectContaining({ owner: "owner@example.com" }),
      );

      /** The issued cookie opens the dashboard. */
      const cookie = setCookie.match(/bm_session=([^;]+)/)?.[1] ?? "";
      const home = await app.handle(
        new Request("http://localhost/dashboard", {
          headers: { cookie: `bm_session=${cookie}` },
        }),
      );
      expect(home.status).toBe(200);
    });

    test("a token spent between the check and the write gets the invalid page", async () => {
      completeOwnerSetup.mockImplementationOnce(() => Promise.resolve(null));
      const response = await postSetup({
        token: LIVE_TOKEN,
        password: GOOD_PASSWORD,
        confirm: GOOD_PASSWORD,
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.text()).toContain("not valid");
    });

    test("protected routes still redirect to login without a cookie", async () => {
      const response = await app.handle(new Request("http://localhost/dashboard/emails"));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard/login");
    });
  });

  describe("Invitations (#217)", () => {
    const GOOD_PASSWORD = "correct horse battery staple";

    /** Form-POSTs to /dashboard/invite; same-origin unless overridden. */
    const postInvite = (
      fields: Record<string, string>,
      headers: Record<string, string> = { origin: "http://localhost" },
    ): Promise<Response> =>
      app.handle(
        new Request("http://localhost/dashboard/invite", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
          body: new URLSearchParams(fields).toString(),
        }),
      );

    /** Same-origin form POST with a session cookie. */
    const postWithSession = (
      path: string,
      token: string,
      fields: Record<string, string>,
    ): Promise<Response> =>
      app.handle(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: "http://localhost",
            cookie: `bm_session=${token}`,
          },
          body: new URLSearchParams(fields).toString(),
        }),
      );

    beforeEach(() => {
      fakeSessions.clear();
    });

    test("GET with a live token renders the form with the auth-page headers (public)", async () => {
      const response = await app.handle(
        new Request(`http://localhost/dashboard/invite?token=${INVITE_TOKEN}`),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("strict-origin");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      const html = await response.text();
      expect(html).toContain('action="/dashboard/invite"');
      expect(html).toContain(`name="token" value="${INVITE_TOKEN}"`);
      expect(html).toContain("new@example.com");
      expect(html).toContain('name="name"');
      expect(html).toContain('<meta name="referrer" content="strict-origin"');
    });

    test("GET without, with a malformed or with an unknown token: identical 400s", async () => {
      const calls = findLiveInvitation.mock.calls.length;
      const missing = await app.handle(new Request("http://localhost/dashboard/invite"));
      const malformed = await app.handle(
        new Request("http://localhost/dashboard/invite?token=not-a-token"),
      );
      expect(findLiveInvitation.mock.calls.length).toBe(calls);
      const unknown = await app.handle(
        new Request(`http://localhost/dashboard/invite?token=${UNKNOWN_TOKEN}`),
      );
      const bodies: string[] = [];
      for (const response of [missing, malformed, unknown]) {
        expect(response.status).toBe(400);
        bodies.push(await response.text());
      }
      expect(new Set(bodies).size).toBe(1);
      expect(bodies[0]).toContain("This invitation link is not valid");
    });

    test("POST cross-origin is refused before any lookup", async () => {
      const calls = findLiveInvitation.mock.calls.length;
      const response = await postInvite(
        {
          token: INVITE_TOKEN,
          name: "Ann",
          password: GOOD_PASSWORD,
          confirm: GOOD_PASSWORD,
        },
        { origin: "https://evil.example.com" },
      );
      expect(response.status).toBe(403);
      expect(findLiveInvitation.mock.calls.length).toBe(calls);
    });

    test("POST with a policy problem re-renders the form and never accepts", async () => {
      const calls = acceptInvitation.mock.calls.length;
      const short = await postInvite({
        token: INVITE_TOKEN,
        name: "Ann",
        password: "short",
        confirm: "short",
      });
      expect(short.status).toBe(200);
      expect(await short.text()).toContain("at least 15 characters");
      const noName = await postInvite({
        token: INVITE_TOKEN,
        name: "   ",
        password: GOOD_PASSWORD,
        confirm: GOOD_PASSWORD,
      });
      expect(noName.status).toBe(200);
      expect(await noName.text()).toContain("Enter your name.");
      expect(acceptInvitation.mock.calls.length).toBe(calls);
    });

    test("POST success: new session cookie, the presented session revoked, 302 to /dashboard", async () => {
      const old = seedSession();
      warnLog.mockClear();
      const response = await postInvite(
        {
          token: INVITE_TOKEN,
          name: "  Ann  ",
          password: GOOD_PASSWORD,
          confirm: GOOD_PASSWORD,
        },
        { origin: "http://localhost", cookie: `bm_session=${old}` },
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard");
      const token = cookieValue(response) ?? "";
      expect(fakeSessions.has(token)).toBe(true);
      expect(fakeSessions.has(old)).toBe(false);
      expect(acceptInvitation).toHaveBeenLastCalledWith(
        INVITE_TOKEN,
        { name: "Ann", password: GOOD_PASSWORD },
        { ip: "unknown", userAgent: null },
      );
      const accepted = warnLog.mock.calls.find(([m]) => m === "Invitation accepted");
      expect(accepted?.[1]).toMatchObject({ userId: "usr_new", role: "admin" });
      expect(JSON.stringify(accepted)).not.toContain(INVITE_TOKEN);
    });

    test("POST when the address got an account meanwhile: 409, no cookie", async () => {
      const response = await postInvite({
        token: TAKEN_INVITE_TOKEN,
        name: "Ann",
        password: GOOD_PASSWORD,
        confirm: GOOD_PASSWORD,
      });
      expect(response.status).toBe(409);
      expect(cookieValue(response)).toBeNull();
      expect(await response.text()).toContain("An account already exists");
    });

    test("the Invitations page escapes stored values; a member gets 403", async () => {
      const owner = seedSession();
      const page = await getWithSession("/dashboard/invitations", owner);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("&lt;img src=x&gt;@example.com");
      expect(html).toContain("&lt;b&gt;Ann&lt;/b&gt;");
      expect(html).not.toContain("<img src=x>");
      /** The owner may grant both roles. */
      expect(html).toContain('<option value="admin">');

      const member = seedSession({ role: "member" });
      const denied = await getWithSession("/dashboard/invitations", member);
      expect(denied.status).toBe(403);
    });

    test.each(["/dashboard/invitations", "/dashboard/api-keys", "/dashboard/webhooks"])(
      "%s (can reveal a one-time secret) is sent with Cache-Control: no-store",
      async (path) => {
        const owner = seedSession();
        const response = await getWithSession(path, owner);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
      },
    );

    test("a higher-role pending invitation is an error flash, not a 403", async () => {
      issueResult = { ok: false, reason: "pending_higher_role" };
      const admin = seedSession({ role: "admin" });
      const response = await postWithSession("/dashboard/invitations", admin, {
        email: "new@example.com",
        role: "member",
      });
      expect(response.status).toBe(302);
      const location = decodeURIComponent(response.headers.get("location") ?? "");
      expect(location).toContain("A pending invitation from a higher role exists");
      expect(location).toContain("flashType=error");
    });

    test("an admin's role select offers member only", async () => {
      const admin = seedSession({ role: "admin" });
      const html = await (await getWithSession("/dashboard/invitations", admin)).text();
      expect(html).toContain('<option value="member">');
      expect(html).not.toContain('<option value="admin">');
    });

    test("email not sent: the link is revealed once, never in the redirect URL", async () => {
      issueResult = {
        ok: true,
        invitation: {
          invitationId: "utk_new",
          token: INVITE_TOKEN,
          email: "new@example.com",
          role: "member",
          expiresAt: new Date(),
          replaced: 0,
        },
        url: INVITE_URL,
        delivery: { sent: false, reason: "not_configured" },
      };
      const owner = seedSession();
      const response = await postWithSession("/dashboard/invitations", owner, {
        email: "new@example.com",
        role: "member",
      });
      expect(response.status).toBe(302);
      const location = response.headers.get("location") ?? "";
      expect(location).not.toContain(INVITE_TOKEN);
      expect(decodeURIComponent(location)).toContain("no system sender is configured");
      const reveal = new URL(location, "http://localhost").searchParams.get("reveal");
      expect(reveal).toBeTruthy();

      const first = await (await getWithSession(location, owner)).text();
      expect(first).toContain(INVITE_URL);
      const second = await (await getWithSession(location, owner)).text();
      expect(second).not.toContain(INVITE_URL);
    });

    test("email sent: a plain success flash and no reveal", async () => {
      issueResult = {
        ok: true,
        invitation: {
          invitationId: "utk_new",
          token: INVITE_TOKEN,
          email: "new@example.com",
          role: "member",
          expiresAt: new Date(),
          replaced: 0,
        },
        url: INVITE_URL,
        delivery: { sent: true },
      };
      const owner = seedSession();
      const response = await postWithSession("/dashboard/invitations", owner, {
        email: "new@example.com",
        role: "member",
      });
      const location = response.headers.get("location") ?? "";
      expect(decodeURIComponent(location)).toContain("Invitation sent by email.");
      expect(location).not.toContain("reveal=");
    });

    test("a role the actor cannot grant gets the 403 page", async () => {
      issueResult = { ok: false, reason: "role_not_allowed" };
      const admin = seedSession({ role: "admin" });
      const response = await postWithSession("/dashboard/invitations", admin, {
        email: "new@example.com",
        role: "owner",
      });
      expect(response.status).toBe(403);
      expect(await response.text()).toContain("cannot grant");
    });
  });

  describe("Users (#218)", () => {
    /** Same-origin form POST with a session cookie. */
    const postWithSession = (
      path: string,
      token: string,
      fields: Record<string, string> = {},
    ): Promise<Response> =>
      app.handle(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: {
            cookie: `bm_session=${token}`,
            origin: "http://localhost",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams(fields).toString(),
        }),
      );

    beforeEach(() => {
      accountResult = { ok: true };
      accountAction.mockClear();
    });

    test("the owner sees every account, escaped, with the actions it may take", async () => {
      const response = await getWithSession("/dashboard/users", seedSession());
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("&lt;b&gt;Ada&lt;/b&gt;");
      expect(html).toContain("&lt;i&gt;m&lt;/i&gt;@example.com");
      expect(html).not.toContain("<b>Ada</b>");
      expect(html).not.toContain("<i>m</i>");
      expect(html).toContain("(you)");
      /** The admin row: role change, deactivate, transfer, remove. */
      expect(html).toContain('action="/dashboard/users/usr_admin/role"');
      expect(html).toContain('action="/dashboard/users/usr_admin/deactivate"');
      expect(html).toContain('action="/dashboard/users/usr_admin/transfer"');
      expect(html).toContain('action="/dashboard/users/usr_admin/remove"');
      /** The disabled member: reactivate, not deactivate. */
      expect(html).toContain('action="/dashboard/users/usr_member/reactivate"');
      expect(html).not.toContain('action="/dashboard/users/usr_member/deactivate"');
      expect(html).not.toContain('action="/dashboard/users/usr_member/transfer"');
      /** Nothing on the owner's own row. */
      expect(html).not.toContain(`/dashboard/users/${OWNER.userId}/`);
      expect(html).toContain('href="/dashboard/invitations"');
    });

    test("an admin sees member actions only, and no role change", async () => {
      const admin = seedSession({ userId: "usr_admin", role: "admin" });
      const html = await (await getWithSession("/dashboard/users", admin)).text();
      expect(html).not.toContain("/role");
      expect(html).not.toContain("/transfer");
      expect(html).not.toContain('action="/dashboard/users/usr_admin/');
      expect(html).toContain('action="/dashboard/users/usr_member/reactivate"');
      expect(html).toContain('action="/dashboard/users/usr_member/remove"');
    });

    test("a member gets 403 on the page and on every action, and the service is never called", async () => {
      const member = seedSession({ userId: "usr_member", role: "member" });
      expect((await getWithSession("/dashboard/users", member)).status).toBe(403);
      for (const action of ["deactivate", "reactivate", "remove", "role", "transfer"]) {
        const response = await postWithSession(
          `/dashboard/users/usr_x/${action}`,
          member,
          {
            role: "admin",
            confirm: "x",
            password: "x",
          },
        );
        expect(response.status).toBe(403);
      }
      expect(accountAction).not.toHaveBeenCalled();
    });

    test("an applied action redirects with a success flash", async () => {
      const response = await postWithSession(
        "/dashboard/users/usr_admin/role",
        seedSession(),
        {
          role: "member",
        },
      );
      expect(response.status).toBe(302);
      const location = decodeURIComponent(response.headers.get("location") ?? "");
      expect(location).toContain("/dashboard/users?flash=Role changed to member.");
      expect(accountAction).toHaveBeenCalledWith(OWNER.userId, "usr_admin", "member");
    });

    test("a refusal no button leads to gets the 403 page", async () => {
      accountResult = { ok: false, reason: "role_not_allowed" };
      const admin = seedSession({ userId: "usr_admin", role: "admin" });
      const response = await postWithSession("/dashboard/users/usr_x/role", admin, {
        role: "admin",
      });
      expect(response.status).toBe(403);
      expect(await response.text()).toContain("Your role cannot do this");
    });

    test("a wrong transfer password is an error flash and never echoes the password", async () => {
      accountResult = { ok: false, reason: "wrong_password" };
      const response = await postWithSession(
        "/dashboard/users/usr_admin/transfer",
        seedSession(),
        { password: "hunter2-not-it" },
      );
      expect(response.status).toBe(302);
      const location = decodeURIComponent(response.headers.get("location") ?? "");
      expect(location).toContain("Wrong password");
      expect(location).toContain("flashType=error");
      expect(location).not.toContain("hunter2");
      const call = accountAction.mock.calls.at(-1);
      expect(call?.slice(0, 3)).toEqual([OWNER.userId, "usr_admin", "hunter2-not-it"]);
      /** The route hands the service the transfer budget (#218). */
      expect(typeof call?.[3]?.isLimited).toBe("function");
    });

    test("an exhausted transfer budget is an error flash", async () => {
      accountResult = { ok: false, reason: "rate_limited" };
      const response = await postWithSession(
        "/dashboard/users/usr_admin/transfer",
        seedSession(),
        { password: "x" },
      );
      expect(response.status).toBe(302);
      const location = decodeURIComponent(response.headers.get("location") ?? "");
      expect(location).toContain("Too many failed attempts, try again later.");
      expect(location).toContain("flashType=error");
    });

    test("a removal without the right confirmation is an error flash", async () => {
      accountResult = { ok: false, reason: "confirm_mismatch" };
      const response = await postWithSession(
        "/dashboard/users/usr_member/remove",
        seedSession(),
        { confirm: "nope" },
      );
      expect(response.status).toBe(302);
      expect(decodeURIComponent(response.headers.get("location") ?? "")).toContain(
        "Type the account's email address exactly",
      );
    });
  });

  describe("Password resets (#277)", () => {
    const NEW_PASSWORD = "a brand new passphrase, long";

    /** Form-POSTs to /dashboard/reset; same-origin unless overridden. */
    const postReset = (
      fields: Record<string, string>,
      headers: Record<string, string> = { origin: "http://localhost" },
    ): Promise<Response> =>
      app.handle(
        new Request("http://localhost/dashboard/reset", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
          body: new URLSearchParams(fields).toString(),
        }),
      );

    /** Same-origin form POST with a session cookie. */
    const postWithSession = (path: string, token: string): Promise<Response> =>
      app.handle(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: {
            cookie: `bm_session=${token}`,
            origin: "http://localhost",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "",
        }),
      );

    beforeEach(() => {
      fakeSessions.clear();
      issuePasswordReset.mockClear();
      completePasswordReset.mockClear();
      resetIssueResult = {
        ok: true,
        resetId: RESET_TARGET.resetId,
        url: RESET_URL,
        usedFallback: false,
        expiresAt: new Date(Date.now() + 3_600_000),
      };
    });

    test("GET with a live token renders the form with the auth-page headers (public)", async () => {
      const response = await app.handle(
        new Request(`http://localhost/dashboard/reset?token=${RESET_TOKEN}`),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("strict-origin");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      const html = await response.text();
      expect(html).toContain('action="/dashboard/reset"');
      expect(html).toContain(`name="token" value="${RESET_TOKEN}"`);
      expect(html).toContain("&lt;i&gt;a&lt;/i&gt;@example.com");
      expect(html).not.toContain("<i>a</i>");
    });

    test("GET without, with a malformed or with an unknown token: identical 400s", async () => {
      const calls = findLivePasswordReset.mock.calls.length;
      const missing = await app.handle(new Request("http://localhost/dashboard/reset"));
      const malformed = await app.handle(
        new Request("http://localhost/dashboard/reset?token=not-a-token"),
      );
      expect(findLivePasswordReset.mock.calls.length).toBe(calls);
      const unknown = await app.handle(
        new Request(`http://localhost/dashboard/reset?token=${UNKNOWN_TOKEN}`),
      );
      const bodies: string[] = [];
      for (const response of [missing, malformed, unknown]) {
        expect(response.status).toBe(400);
        bodies.push(await response.text());
      }
      expect(new Set(bodies).size).toBe(1);
      expect(bodies[0]).toContain("This password reset link is not valid");
    });

    test("POST cross-origin is refused before any lookup", async () => {
      const calls = findLivePasswordReset.mock.calls.length;
      const response = await postReset(
        { token: RESET_TOKEN, password: NEW_PASSWORD, confirm: NEW_PASSWORD },
        { origin: "https://evil.example.com" },
      );
      expect(response.status).toBe(403);
      expect(findLivePasswordReset.mock.calls.length).toBe(calls);
    });

    test("POST with a policy problem re-renders the form and never completes", async () => {
      const short = await postReset({
        token: RESET_TOKEN,
        password: "short",
        confirm: "short",
      });
      expect(short.status).toBe(200);
      expect(await short.text()).toContain("at least 15 characters");
      const mismatch = await postReset({
        token: RESET_TOKEN,
        password: NEW_PASSWORD,
        confirm: `${NEW_PASSWORD}!`,
      });
      expect(mismatch.status).toBe(200);
      expect(await mismatch.text()).toContain("do not match");
      expect(completePasswordReset).not.toHaveBeenCalled();
    });

    test("POST success: new session cookie, the presented session revoked, logged without secrets", async () => {
      const old = seedSession();
      warnLog.mockClear();
      const response = await postReset(
        { token: RESET_TOKEN, password: NEW_PASSWORD, confirm: NEW_PASSWORD },
        { origin: "http://localhost", cookie: `bm_session=${old}` },
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard");
      const token = cookieValue(response) ?? "";
      expect(fakeSessions.has(token)).toBe(true);
      expect(fakeSessions.has(old)).toBe(false);
      expect(completePasswordReset).toHaveBeenLastCalledWith(RESET_TOKEN, NEW_PASSWORD, {
        ip: "unknown",
        userAgent: null,
      });
      const done = warnLog.mock.calls.find(([m]) => m === "Password reset completed");
      expect(done?.[1]).toMatchObject({
        resetId: RESET_TARGET.resetId,
        userId: RESET_TARGET.userId,
        issuedBy: OWNER.userId,
        sessionsRevoked: 2,
      });
      expect(JSON.stringify(done)).not.toContain(RESET_TOKEN);
      expect(JSON.stringify(warnLog.mock.calls)).not.toContain(NEW_PASSWORD);
    });

    test("POST whose spend fails gets the same 400 page and no cookie", async () => {
      const response = await postReset({
        token: RACED_RESET_TOKEN,
        password: NEW_PASSWORD,
        confirm: NEW_PASSWORD,
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.text()).toContain("This password reset link is not valid");
    });

    test("the owner sees Reset password for an active admin, not for a disabled member", async () => {
      const html = await (await getWithSession("/dashboard/users", seedSession())).text();
      expect(html).toContain('action="/dashboard/users/usr_admin/reset-password"');
      expect(html).not.toContain("/dashboard/users/usr_member/reset-password");
      expect(html).not.toContain(`/dashboard/users/${OWNER.userId}/reset-password`);
    });

    test("issuing reveals the link once, to the issuing session only, never in the URL", async () => {
      const owner = seedSession();
      const response = await postWithSession(
        "/dashboard/users/usr_admin/reset-password",
        owner,
      );
      expect(response.status).toBe(302);
      const location = response.headers.get("location") ?? "";
      expect(location).toContain("reveal=");
      expect(location).not.toContain(RESET_TOKEN);
      expect(decodeURIComponent(location)).toContain("Password reset link created");
      expect(issuePasswordReset).toHaveBeenCalledWith(OWNER.userId, "usr_admin");

      /** Another session of the same user cannot redeem it, nor destroy it. */
      const other = await (await getWithSession(location, seedSession())).text();
      expect(other).not.toContain(RESET_TOKEN);

      const first = await getWithSession(location, owner);
      expect(first.headers.get("cache-control")).toBe("no-store");
      expect(await first.text()).toContain(RESET_URL);
      const second = await (await getWithSession(location, owner)).text();
      expect(second).not.toContain(RESET_TOKEN);
    });

    test("a localhost link says so in the flash", async () => {
      resetIssueResult = {
        ok: true,
        resetId: RESET_TARGET.resetId,
        url: `http://localhost:3000/dashboard/reset?token=${RESET_TOKEN}`,
        usedFallback: true,
        expiresAt: new Date(),
      };
      const response = await postWithSession(
        "/dashboard/users/usr_admin/reset-password",
        seedSession(),
      );
      expect(decodeURIComponent(response.headers.get("location") ?? "")).toContain(
        "APP_BASE_URL is not set",
      );
    });

    test("a member gets 403 and the service is never called", async () => {
      const member = seedSession({ userId: "usr_member", role: "member" });
      const response = await postWithSession(
        "/dashboard/users/usr_x/reset-password",
        member,
      );
      expect(response.status).toBe(403);
      expect(issuePasswordReset).not.toHaveBeenCalled();
    });

    test("refusals: a crafted target gets the 403 page, a disabled account an error flash", async () => {
      resetIssueResult = { ok: false, reason: "target_is_owner" };
      const admin = seedSession({ userId: "usr_admin", role: "admin" });
      const forbidden = await postWithSession(
        `/dashboard/users/${OWNER.userId}/reset-password`,
        admin,
      );
      expect(forbidden.status).toBe(403);

      resetIssueResult = { ok: false, reason: "account_disabled" };
      const disabled = await postWithSession(
        "/dashboard/users/usr_member/reset-password",
        seedSession(),
      );
      expect(disabled.status).toBe(302);
      const location = decodeURIComponent(disabled.headers.get("location") ?? "");
      expect(location).toContain("Reactivate the account before resetting its password.");
      expect(location).toContain("flashType=error");
      expect(location).not.toContain("reveal=");
    });

    test("an issue failure is logged and answered with an error flash", async () => {
      issuePasswordReset.mockImplementationOnce(() =>
        Promise.reject(new Error("User store query failed")),
      );
      errorLog.mockClear();
      const response = await postWithSession(
        "/dashboard/users/usr_admin/reset-password",
        seedSession(),
      );
      expect(response.status).toBe(302);
      expect(decodeURIComponent(response.headers.get("location") ?? "")).toContain(
        "Failed to create the password reset link.",
      );
      expect(
        errorLog.mock.calls.some(
          ([m]) => m === "Failed to issue a password reset link via dashboard",
        ),
      ).toBe(true);
    });
  });

  describe("Key and template ownership in the routes (#219)", () => {
    /** Form-POSTs `fields` to `path` with the session behind `token`. */
    const post = (
      path: string,
      token: string,
      fields: Record<string, string>,
    ): Promise<Response> =>
      app.handle(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: "http://localhost",
            cookie: `bm_session=${token}`,
          },
          body: new URLSearchParams(fields).toString(),
        }),
      );

    test("a member's key list is asked for its own keys, without admin controls", async () => {
      listApiKeys.mockClear();
      const member = seedSession({ userId: "usr_member", role: "member" });
      const response = await getWithSession("/dashboard/api-keys", member);
      expect(response.status).toBe(200);
      expect(listApiKeys.mock.calls[0]?.[0]).toEqual({
        id: "usr_member",
        role: "member",
      });
      const html = await response.text();
      expect(html).toContain("The keys you created");
      expect(html).not.toContain('name="isAdmin"');
    });

    test("the send page and a send ask for the member's own keys only", async () => {
      listApiKeys.mockClear();
      const member = seedSession({ userId: "usr_member", role: "member" });
      expect((await getWithSession("/dashboard/send", member)).status).toBe(200);
      const response = await post("/dashboard/send", member, {
        apiKeyId: "key_someone_else",
        from: "hello@example.com",
        to: "user@example.org",
        subject: "hi",
      });
      expect(decodeURIComponent(response.headers.get("location") ?? "")).toContain(
        "Selected API key is not available",
      );
      const actors = listApiKeys.mock.calls.map((call) => call[0]);
      expect(actors).toEqual([
        { id: "usr_member", role: "member" },
        { id: "usr_member", role: "member" },
      ]);
    });

    test("an admin's key list shows the admin checkbox", async () => {
      const admin = seedSession({ userId: "usr_admin", role: "admin" });
      const html = await (await getWithSession("/dashboard/api-keys", admin)).text();
      expect(html).toContain('name="isAdmin"');
      expect(html).toContain("Every key on this server");
    });

    test("a member's create passes the member as actor; the service drops isAdmin", async () => {
      createApiKey.mockClear();
      const member = seedSession({ userId: "usr_member", role: "member" });
      const response = await post("/dashboard/api-keys", member, {
        name: "Mine",
        isAdmin: "on",
      });
      expect(response.status).toBe(302);
      expect(createApiKey.mock.calls[0]?.[1]).toEqual({
        id: "usr_member",
        role: "member",
      });
    });

    test("a member's crafted admin toggle is refused by the guard", async () => {
      const member = seedSession({ userId: "usr_member", role: "member" });
      const response = await post("/dashboard/api-keys/key_test123/admin", member, {
        isAdmin: "true",
      });
      expect(response.status).toBe(403);
    });

    test("a refused template edit or delete is the 403 page", async () => {
      const forbidden: FakeTemplateChange = { ok: false, reason: "forbidden" };
      const member = seedSession({ userId: "usr_member", role: "member" });

      updateTemplateAs.mockResolvedValueOnce(forbidden);
      const edit = await post("/dashboard/templates/tpl_x/edit", member, { name: "x" });
      expect(edit.status).toBe(403);
      expect(await edit.text()).toContain("admins and the owner can edit or delete it");

      deleteTemplateAs.mockResolvedValueOnce(forbidden);
      const del = await post("/dashboard/templates/tpl_x/delete", member, {});
      expect(del.status).toBe(403);
    });

    test("a template that is gone redirects with a not-found flash", async () => {
      const member = seedSession({ userId: "usr_member", role: "member" });
      const response = await post("/dashboard/templates/tpl_gone/delete", member, {});
      expect(response.status).toBe(302);
      expect(decodeURIComponent(response.headers.get("location") ?? "")).toContain(
        "Template not found",
      );
    });
  });

  describe("Sidebar by role (#218)", () => {
    /** The app as `src/index.ts` mounts it: with the per-request context. */
    const wrapped = new Elysia().wrap(withRequestContext).use(pagesPlugin);

    const home = async (token: string): Promise<string> =>
      (
        await wrapped.handle(
          new Request("http://localhost/dashboard", {
            headers: { cookie: `bm_session=${token}` },
          }),
        )
      ).text();

    test("a member's page has no link to an admin-only page", async () => {
      const html = await home(seedSession({ userId: "usr_member", role: "member" }));
      expect(html).toContain('href="/dashboard/emails"');
      /** A member's own keys (#219). */
      expect(html).toContain('href="/dashboard/api-keys"');
      expect(html).not.toContain('href="/dashboard/users"');
      expect(html).not.toContain('href="/dashboard/invitations"');
    });

    test("an admin's and the owner's pages link to them", async () => {
      for (const role of ["admin", "owner"] as const) {
        const html = await home(seedSession({ userId: `usr_${role}`, role }));
        expect(html).toContain('href="/dashboard/api-keys"');
        expect(html).toContain('href="/dashboard/users"');
        expect(html).toContain('href="/dashboard/invitations"');
      }
    });

    test("without the per-request context the admin links are hidden (fail closed)", async () => {
      const html = await (await getWithSession("/dashboard", seedSession())).text();
      expect(html).not.toContain('href="/dashboard/users"');
    });
  });

  describe("POST /dashboard/logout", () => {
    /** Form-POSTs to /dashboard/logout; same-origin unless overridden. */
    const postLogout = (headers: Record<string, string>): Promise<Response> =>
      app.handle(
        new Request("http://localhost/dashboard/logout", {
          method: "POST",
          headers: { origin: "http://localhost", ...headers },
        }),
      );

    test("revokes the session, clears the cookie, and the replayed cookie is dead", async () => {
      const token = seedSession();
      expect((await getWithSession("/dashboard", token)).status).toBe(200);

      const response = await postLogout({ cookie: `bm_session=${token}` });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard/login");
      const setCookie = response.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("Max-Age=0");
      expect(setCookie).toContain("Path=/dashboard");
      expect(revokeSessionByToken).toHaveBeenLastCalledWith(token);

      const replay = await getWithSession("/dashboard", token);
      expect(replay.status).toBe(302);
      expect(replay.headers.get("location")).toBe("/dashboard/login");
    });

    test("without a cookie, or with a legacy one, it still clears and redirects", async () => {
      const calls = revokeSessionByToken.mock.calls.length;
      const cases: Record<string, string>[] = [
        {},
        { cookie: `bm_session=1700000000.${"a".repeat(64)}` },
      ];
      for (const headers of cases) {
        const response = await postLogout(headers);
        expect(response.status).toBe(302);
        expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
      }
      expect(revokeSessionByToken.mock.calls.length).toBe(calls);
    });

    test("a revoke error is logged and the cookie still cleared", async () => {
      revokeSessionByToken.mockImplementationOnce(() =>
        Promise.reject(new Error("down")),
      );
      const response = await postLogout({ cookie: `bm_session=${seedSession()}` });
      expect(response.status).toBe(302);
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
      expect(errorLog).toHaveBeenCalledWith(
        "Dashboard logout: session revoke failed",
        expect.objectContaining({ error: "down" }),
      );
    });

    test("a cross-origin logout is 403 and the session survives", async () => {
      const token = seedSession();
      const evil = await postLogout({
        cookie: `bm_session=${token}`,
        origin: "http://evil.example",
      });
      expect(evil.status).toBe(403);
      expect(evil.headers.get("set-cookie")).toBeNull();
      expect((await getWithSession("/dashboard", token)).status).toBe(200);
    });
  });
});
