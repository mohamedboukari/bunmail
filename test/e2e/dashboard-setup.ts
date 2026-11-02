import { mock, beforeAll } from "bun:test";
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
  FinishPasskeyRegistrationResult,
  PasskeySignInResult,
  PasskeySummary,
  PasskeyTwoFactorResult,
  PendingSession,
  RelyingParty,
  RotatedSession,
  SessionAssurance,
  SessionClient,
  UserRole,
} from "../../src/modules/users/types/user.types.ts";
import type { SignInDeviceEvent } from "../../src/modules/users/services/sign-in-device.service.ts";
import type {
  SendTwoFactorAlertInput,
  TwoFactorAlertOutcome,
} from "../../src/modules/users/services/two-factor-alert.service.ts";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";

/**
 * Shared setup for the dashboard e2e tests (`dashboard-*.test.ts`, #291).
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
export const dashboardConfig = {
  /** Unset in this stub; the owner bootstrap runs in index.ts, not here. */
  ownerEmail: null,
  /** Read only by index.ts; present so a leak of this stub has no holes. */
  legacyAuthEnv: [],
  /** Trust one proxy hop so tests can drive distinct client IPs via
   *  the X-Forwarded-For header (app.handle has no real socket). */
  trustedProxyHops: 1,
  loginRateLimit: { enabled: true, maxAttempts: 5, windowSec: 900 },
};

/** The real module, spread under the stub so every export exists (#293). */
export const realConfig = await import("../../src/config.ts");

/* ─── Mock logger ─── */

/** Kept so tests can assert audit lines (#215, #216). */
export const warnLog = mock((_message: string, _data?: Record<string, unknown>) => {});
export const errorLog = mock((_message: string, _data?: Record<string, unknown>) => {});
export const infoLog = mock((_message: string, _data?: Record<string, unknown>) => {});

/** The real module, spread under the stub so every export exists (#293). */
export const realLogger = await import("../../src/utils/logger.ts");

/* ─── Mock services ─── */

/** A key row as the fake api-key service returns it. */
export function fakeKey(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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
export const listApiKeys = mock((_actor?: unknown) => Promise.resolve([]));
export const createApiKey = mock((_input: unknown, _actor?: unknown) =>
  Promise.resolve({
    apiKey: fakeKey(),
    rawKey: "bm_live_test1234567890abcdef12345678",
  }),
);

/** What the fake ownership-checked template changes answer (#219); tests swap it. */
export type FakeTemplateChange = { ok: false; reason: "not_found" | "forbidden" };
export const updateTemplateAs = mock(
  (_id: string, _actor: unknown, _input: unknown): Promise<FakeTemplateChange> =>
    Promise.resolve({ ok: false, reason: "not_found" }),
);
export const deleteTemplateAs = mock(
  (_id: string, _actor: unknown): Promise<FakeTemplateChange> =>
    Promise.resolve({ ok: false, reason: "not_found" }),
);

/**
 * Every export of template.service.ts: mock.module leaks across files. The
 * factory is registered at load and again in beforeAll: when another e2e
 * file (templates-api) registered its own template mock first, the routes
 * could stay bound to that one, so this file re-applies its own before its
 * tests run (CI file order, reproduced with `bun test --randomize`).
 */
export const templateServiceMock = (): Record<string, unknown> => ({
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
});

/**
 * Owner setup (#215). `db` is mocked as `{}` below, so the real service
 * cannot run here; its database behaviour is covered by
 * owner-setup.integration.test.ts. Well-formed tokens (43 base64url
 * characters): LIVE_TOKEN is live, anything else is not.
 */
export const LIVE_TOKEN = "L".repeat(40) + "i_v";
export const UNKNOWN_TOKEN = "U".repeat(40) + "n-k";
export const OWNER = { userId: "usr_owner", email: "owner@example.com" };

/* ─── In-memory sessions (#216) ─── */

/** One fake session, keyed in `fakeSessions` by its current token. */
export interface FakeSession {
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

export const fakeSessions = new Map<string, FakeSession>();
export let fakeCounter = 0;

/** A well-formed (43 base64url characters), unique fake token. */
export function fakeToken(): string {
  fakeCounter += 1;
  return `T${String(fakeCounter).padStart(42, "0")}`;
}

/** Stores a fake session and returns its token. */
export function seedSession(overrides: Partial<FakeSession> = {}): string {
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

export const createSession = mock(
  (input: NewSessionInput, _executor?: unknown): Promise<CreatedSession> => {
    const token = seedSession({ userId: input.userId, assurance: input.assurance });
    return Promise.resolve({ sessionId: `ses_${fakeCounter}`, token });
  },
);

/** Mirrors the real query: current or previous token, admitted assurance only. */
export const findActiveSession = mock((token: string): Promise<ActiveSession | null> => {
  for (const [current, s] of fakeSessions) {
    if (current !== token && s.previous !== token) continue;
    if (s.assurance !== "password" && s.assurance !== "mfa") return Promise.resolve(null);
    return Promise.resolve({
      sessionId: s.sessionId,
      userId: s.userId,
      email: s.email,
      role: s.role,
      assurance: s.assurance,
      /** No second factor (#220, #223): its SQL and the 2FA flows are integration-tested. */
      hasSecondFactor: false,
      /** No SSO link (#224): integration-tested. */
      hasSsoLink: false,
      matched: current === token ? "current" : "previous",
      rotationDue: s.rotationDue,
      graceOver: s.graceOver,
    });
  }
  return Promise.resolve(null);
});

export const rotateSession = mock(
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

export const revokeSessionByToken = mock(
  (token: string): Promise<{ sessionId: string; userId: string } | null> => {
    for (const [current, s] of fakeSessions) {
      if (current === token || s.previous === token) {
        fakeSessions.delete(current);
        return Promise.resolve({ sessionId: s.sessionId, userId: s.userId });
      }
    }
    return Promise.resolve(null);
  },
);

export const revokeAllUserSessions = mock(
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
export const findSessionBySupersededToken = mock(
  (token: string): Promise<{ sessionId: string; userId: string } | null> => {
    for (const s of fakeSessions.values()) {
      if (s.history.includes(token)) {
        return Promise.resolve({ sessionId: s.sessionId, userId: s.userId });
      }
    }
    return Promise.resolve(null);
  },
);

/** The second login step's lookup (#220); the passkey tests (#223) hand back a pending session. */
export const findPendingSession = mock((_token: string): Promise<PendingSession | null> =>
  Promise.resolve(null),
);

/** Every export of session.service.ts: mock.module leaks across files. */

/** The one account the fake login service knows. */
export const ACCOUNT = {
  email: "owner@example.com",
  password: "the owner password, long",
};

export const verifyPasswordLogin = mock(
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

/**
 * The new-device check (#282): its SQL and the alert are covered by the
 * integration test; here only the login's call is checked.
 */
export const recognizeSignInDevice = mock((_event: SignInDeviceEvent) =>
  Promise.resolve(),
);

/**
 * The 2FA security emails (#220): their contents and sending are covered
 * by the unit and integration tests. Mocked here so the dashboard does not
 * load the system mail path (and the domain service) in this file.
 */
/** Kept so the passkey tests (#223) can assert the security emails. */
export const sendTwoFactorAlert = mock(
  (_input: SendTwoFactorAlertInput): Promise<TwoFactorAlertOutcome> =>
    Promise.resolve({ sent: true }),
);

/** Every export of sign-in-device.service.ts. */

export const findLiveOwnerSetup = mock((token: string) =>
  Promise.resolve(token === LIVE_TOKEN ? OWNER : null),
);
/** The session token the last successful fake setup opened. */
export let lastSetupSessionToken = "";

export const completeOwnerSetup = mock(
  (
    token: string,
    _password: string,
    _client?: SessionClient,
  ): Promise<CompletedOwnerSetup | null> => {
    if (token !== LIVE_TOKEN) return Promise.resolve(null);
    lastSetupSessionToken = seedSession();
    return Promise.resolve({
      ...OWNER,
      sessionToken: lastSetupSessionToken,
      twoFactorRemoved: false,
      secondFactorsRemoved: { totp: false, passkeys: 0 },
      ssoLinksRemoved: [],
    });
  },
);

/* ─── Invitations (#217) ─── */

/**
 * Fake invitation service: the real one needs Postgres and is covered by
 * invitations.integration.test.ts. INVITE_TOKEN is live, anything else is
 * not; TAKEN_INVITE_TOKEN is live but its address got an account.
 */
export const INVITE_TOKEN = "I".repeat(40) + "n_v";
export const TAKEN_INVITE_TOKEN = "K".repeat(40) + "t-k";
export const INVITE_TARGET: InviteTarget = {
  invitationId: "utk_invite",
  email: "new@example.com",
  role: "admin",
};
/** The raw accept link the fake create returns; must never reach a URL. */
export const INVITE_URL = `http://localhost:3000/dashboard/invite?token=${INVITE_TOKEN}`;

export const findLiveInvitation = mock((token: string): Promise<InviteTarget | null> =>
  Promise.resolve(
    token === INVITE_TOKEN || token === TAKEN_INVITE_TOKEN ? INVITE_TARGET : null,
  ),
);

export const acceptInvitation = mock(
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
export let issueResult: IssueInvitationResult = { ok: false, reason: "invalid_email" };

export const createInvitation = mock(
  (_actor: InviteActor, _email: string, _role: string): Promise<IssueInvitationResult> =>
    Promise.resolve(issueResult),
);

export const pendingInvitations: PendingInvitation[] = [
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

/* ─── Users (#218) ─── */

/**
 * Fake account management service: the real one needs Postgres and is
 * covered by users-admin.integration.test.ts. The list carries markup in
 * stored values to prove the page escapes them.
 */
export const ACCOUNTS: AccountSummary[] = [
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
export let accountResult: AccountActionResult = { ok: true };

/** One fake for every action: records the call, answers `accountResult`. */
export const accountAction = mock(
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
export const RESET_TOKEN = "P".repeat(40) + "r_s";
export const RACED_RESET_TOKEN = "Q".repeat(40) + "r-c";
export const RESET_TARGET: PasswordResetTarget = {
  resetId: "utk_reset",
  userId: "usr_admin",
  email: "<i>a</i>@example.com",
};
/** The raw reset link the fake issue returns; must never reach a URL or a log. */
export const RESET_URL = `https://mail.example.com/dashboard/reset?token=${RESET_TOKEN}`;

export const findLivePasswordReset = mock(
  (token: string): Promise<PasswordResetTarget | null> =>
    Promise.resolve(
      token === RESET_TOKEN || token === RACED_RESET_TOKEN ? RESET_TARGET : null,
    ),
);

export const completePasswordReset = mock(
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
      twoFactorRemoved: false,
      secondFactorsRemoved: { totp: false, passkeys: 0 },
      ssoLinksRemoved: [],
      sessionId: `ses_${fakeCounter}`,
      sessionToken,
    });
  },
);

/** Every export of password-reset.service.ts: mock.module leaks across files. */

/** What the fake reset-link issue answers; tests swap it. */
export let resetIssueResult: IssuePasswordResetResult = {
  ok: true,
  resetId: RESET_TARGET.resetId,
  url: RESET_URL,
  usedFallback: false,
  expiresAt: new Date(Date.now() + 3_600_000),
};

export const issuePasswordReset = mock(
  (_actorId: string, _targetId: string): Promise<IssuePasswordResetResult> =>
    Promise.resolve(resetIssueResult),
);

/** Every export of user-admin.service.ts: mock.module leaks across files. */

/* ─── Passkeys (#223): the services are fakes; their SQL and crypto are integration-tested ─── */

/** One passkey of the owner, as the Passkeys page lists it. */
export const OWNER_PASSKEY: PasskeySummary = {
  id: "crd_passkey",
  name: "Laptop",
  createdAt: new Date(Date.UTC(2026, 9, 1)),
  lastUsedAt: null,
};

/** Request options as the library would answer them. */
export const REQUEST_OPTIONS: PublicKeyCredentialRequestOptionsJSON = {
  challenge: "Y2hhbGxlbmdl",
  rpId: "localhost",
  userVerification: "required",
};

/** Creation options as the library would answer them. */
export const CREATION_OPTIONS: PublicKeyCredentialCreationOptionsJSON = {
  challenge: "Y2hhbGxlbmdl",
  rp: { name: "BunMail", id: "localhost" },
  user: { id: "dXNyXzE", name: "owner@example.com", displayName: "owner@example.com" },
  pubKeyCredParams: [{ alg: -7, type: "public-key" }],
};

export const listPasskeys = mock((_userId: string): Promise<PasskeySummary[]> =>
  Promise.resolve([OWNER_PASSKEY]),
);
export const startRegistration = mock(
  (
    _input: {
      userId: string;
      email: string;
      sessionId: string;
      password: string;
      name: string;
    },
    _limiter: AttemptLimiter,
    _rp: RelyingParty,
  ): Promise<
    | { ok: true; options: PublicKeyCredentialCreationOptionsJSON }
    | { ok: false; reason: "invalid_name"; problem: string }
    | { ok: false; reason: "rate_limited" | "wrong_password" }
  > => Promise.resolve({ ok: true, options: CREATION_OPTIONS }),
);
export const finishRegistration = mock(
  (
    _input: { userId: string; sessionId: string; response: unknown },
    _rp: RelyingParty,
    _client?: SessionClient,
  ): Promise<FinishPasskeyRegistrationResult> =>
    Promise.resolve({
      ok: true,
      credentialId: "crd_new",
      name: "New key",
      sessionsRevoked: 0,
    }),
);
export const startPasskeyTwoFactor = mock(
  (
    _pending: PendingSession,
    _rp: RelyingParty,
  ): Promise<PublicKeyCredentialRequestOptionsJSON | null> =>
    Promise.resolve(REQUEST_OPTIONS),
);
export const completePasskeyTwoFactor = mock(
  (
    _pending: PendingSession,
    _token: string,
    _response: unknown,
    _limiter: AttemptLimiter,
    _rp: RelyingParty,
    _client?: SessionClient,
  ): Promise<PasskeyTwoFactorResult> =>
    Promise.resolve({
      ok: true,
      credentialId: "crd_passkey",
      token: fakeToken(),
      maxAgeSec: 600,
    }),
);
export const startPasskeySignIn = mock(
  (
    _rp: RelyingParty,
  ): Promise<{ binding: string; options: PublicKeyCredentialRequestOptionsJSON }> =>
    Promise.resolve({ binding: "b".repeat(43), options: REQUEST_OPTIONS }),
);
export const completePasskeySignIn = mock(
  (
    _binding: string,
    _response: unknown,
    _rp: RelyingParty,
    _client?: SessionClient,
  ): Promise<PasskeySignInResult> =>
    Promise.resolve({
      ok: true,
      userId: OWNER.userId,
      email: OWNER.email,
      credentialId: "crd_passkey",
    }),
);
export const openPasskeySession = mock(
  (
    userId: string,
    _passkeyId: string,
    _client: SessionClient,
  ): Promise<{ sessionId: string; token: string }> => {
    const token = seedSession({ userId, assurance: "mfa" });
    return Promise.resolve({ sessionId: `ses_${fakeCounter}`, token });
  },
);
export const renamePasskey = mock(
  (
    _userId: string,
    _passkeyId: string,
    _name: string,
  ): Promise<
    | { ok: true }
    | { ok: false; reason: "invalid_name"; problem: string }
    | { ok: false; reason: "not_found" }
  > => Promise.resolve({ ok: true }),
);
export const deletePasskey = mock(
  (
    _userId: string,
    _passkeyId: string,
    _password: string,
    _limiter: AttemptLimiter,
    _client?: SessionClient,
  ): Promise<
    | { ok: true; name: string }
    | { ok: false; reason: "not_found" | "rate_limited" | "wrong_password" }
  > => Promise.resolve({ ok: true, name: "Laptop" }),
);

/** Every export of passkey.service.ts. */

/** The factors the second step offers (#223). */
export const secondFactorsOf = mock(
  (_userId: string): Promise<{ totp: boolean; passkeys: number }> =>
    Promise.resolve({ totp: false, passkeys: 1 }),
);

/** Every export of two-factor.service.ts; only `secondFactorsOf` is used here. */

/**
 * Registers every dashboard mock. `mock.module` is process-wide and this
 * module loads once per run, so a dashboard file that runs after another
 * e2e file mocking the same services (templates-api, domains-api, ...)
 * would see that file's mocks: each dashboard test file registers these
 * again before its tests (`useDashboardMocks`). File order is random on
 * CI (#360).
 */
export function registerDashboardMocks(): void {
  void mock.module("../../src/config.ts", () => ({
    ...realConfig,
    config: {
      ...realConfig.config,
      env: "development",
      appBaseUrl: "",
      database: {
        ...realConfig.config.database,
        url: "postgres://test:test@localhost/test",
      },
      server: { ...realConfig.config.server, port: 3000, host: "0.0.0.0" },
      mail: { ...realConfig.config.mail, hostname: "localhost", publicIps: [] },
      smtp: { ...realConfig.config.smtp, enabled: false },
      dashboard: dashboardConfig,
      /** Read by the invitation services (#217), which are mocked below. */
      systemMailFrom: null,
      invites: { ...realConfig.config.invites, expiryDays: 7 },
      /** Session locations off (#281): login looks nothing up. */
      geoip: { ...realConfig.config.geoip, source: "off" },
      /** Read by the home page's Blocklists card (#250): off, nothing is looked up. */
      sendingIpDnsbl: { ...realConfig.config.sendingIpDnsbl, enabled: false },
      logLevel: "error",
      logRedactPii: false,
    },
  }));
  void mock.module("../../src/utils/logger.ts", () => ({
    ...realLogger,
    logger: {
      debug: mock(() => {}),
      info: infoLog,
      warn: warnLog,
      error: errorLog,
    },
  }));
  void mock.module("../../src/modules/emails/services/stats.service.ts", () => ({
    getDashboardStats: mock(() =>
      Promise.resolve({
        totalEmails: 42,
        sentCount: 35,
        failedCount: 3,
        queuedCount: 4,
        bouncedCount: 0,
        sentLast24h: 7,
        failedLast24h: 0,
        bouncedLast24h: 0,
        successRate: 35 / 38,
        bounceRate: 0,
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
    /** Mocks leak across e2e files: the emails API routes call it too (#189). */
    checkTagFilters: mock(() => []),
    getEmailByIdUnscoped: mock(() => Promise.resolve(undefined)),
    getEmailById: mock(() => Promise.resolve(undefined)),
    createEmail: mock(() =>
      Promise.resolve({ email: {}, warnings: [], attachments: [] }),
    ),
    /** Attachment metadata (#181), and the download lookup: none here. */
    attachmentsFor: mock(() => Promise.resolve(new Map())),
    findAttachmentForDownload: mock(() => Promise.resolve(undefined)),
    /** Not used by the dashboard; listed so the module keeps the export when
     *  `emails-api.test.ts` re-mocks it in the same process (#188). */
    createEmailIdempotent: mock(() =>
      Promise.resolve({ status: 200, body: {}, replayed: false }),
    ),
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
    suggestedSpfRecord: mock(() => "v=spf1 a:mail.example.com -all"),
    spfAuthorizationTerm: mock(() => "a:mail.example.com"),
    createDomain: mock(() =>
      Promise.resolve({
        id: "dom_test123",
        name: "example.com",
        dkimPrivateKey: null,
        dkimPublicKey: null,
        dkimSelector: "bunmail",
        dkimPendingSelector: null,
        dkimPendingPrivateKey: null,
        dkimPendingPublicKey: null,
        dkimPendingCreatedAt: null,
        dkimPreviousSelector: null,
        dkimPreviousPublicKey: null,
        dkimRotatedAt: null,
        spfVerified: false,
        dkimVerified: false,
        dmarcVerified: false,
        verifiedAt: null,
        lastCheckedAt: null,
        nextCheckAt: null,
        consecutiveFailures: 0,
        lastCheckResult: null,
        unsubscribeEmail: null,
        unsubscribeUrl: null,
        notifyEmail: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ),
    getDomainById: mock(() => Promise.resolve(undefined)),
    getDomainByName: mock(() => Promise.resolve(undefined)),
    domainExistsByName: mock(() => Promise.resolve(false)),
    updateDomainNotifyEmail: mock(() => Promise.resolve(undefined)),
    updateDomainUnsubscribe: mock(() => Promise.resolve(undefined)),
    domainNameIs: mock(() => undefined),
    deleteDomain: mock(() => Promise.resolve(undefined)),
    getDkimDnsRecord: mock(() => null),
  }));
  void mock.module(
    "../../src/modules/domains/services/dns-verification.service.ts",
    () => ({
      verifyDomain: mock(() => Promise.resolve()),
      /** Not on the dashboard routes; present so a leak of this mock has no holes (#293). */
      runDnsChecks: mock(() =>
        Promise.reject(new Error("runDnsChecks is not stubbed in this test")),
      ),
    }),
  );
  void mock.module(
    "../../src/modules/templates/services/template.service.ts",
    templateServiceMock,
  );
  void mock.module("../../src/modules/webhooks/services/webhook.service.ts", () => ({
    createWebhook: mock(() => Promise.resolve({})),
    listWebhooks: mock(() => Promise.resolve([])),
    listAllWebhooks: mock(() => Promise.resolve([])),
    deleteWebhook: mock(() => Promise.resolve(undefined)),
    findWebhookById: mock(() => Promise.resolve(undefined)),
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
  void mock.module("../../src/modules/users/services/session.service.ts", () => ({
    createSession,
    findActiveSession,
    findSessionBySupersededToken,
    rotateSession,
    revokeSessionByToken,
    revokeAllUserSessions,
    purgeExpiredSessions: mock(() => Promise.resolve(0)),
    /** The Active sessions page (#281); its SQL is covered by the integration test. */
    listUserSessions: mock(() => Promise.resolve([])),
    revokeUserSession: mock(() => Promise.resolve(false)),
    revokeOtherUserSessions: mock(() => Promise.resolve(0)),
    setSessionLocation: mock(() => Promise.resolve()),
    /** Two-factor (#220); covered by the integration test. */
    findPendingSession,
    lockPendingSession: mock(() => Promise.resolve(false)),
    elevatePendingSession: mock(() => Promise.reject(new Error("not in e2e"))),
    setTotpPendingSecret: mock(() => Promise.resolve(false)),
    totpPendingSecretOf: mock(() => Promise.resolve(null)),
    markSessionMfa: mock(() => Promise.resolve()),
    /** Passkeys (#223); covered by the integration test. */
    raiseSessionToMfa: mock(() => Promise.resolve()),
    /** SSO links (#224); covered by the integration test. */
    lockLiveSession: mock(() => Promise.resolve(false)),
  }));
  void mock.module("../../src/modules/users/services/login.service.ts", () => ({
    verifyPasswordLogin,
    /** SSO sign-in (#224) reads it; the same rule as the real one. */
    firstFactorAssurance: (secondFactor: boolean): "pending" | "password" =>
      secondFactor ? "pending" : "password",
  }));
  void mock.module(
    "../../src/modules/users/services/two-factor-alert.service.ts",
    () => ({
      sendTwoFactorAlert,
      buildTwoFactorAlertEmail: mock(() => ({ subject: "", text: "", html: "" })),
    }),
  );
  void mock.module("../../src/modules/users/services/sign-in-device.service.ts", () => ({
    recognizeSignInDevice,
    LOCATION_WAIT_MS: 2000,
  }));
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
  void mock.module("../../src/modules/users/services/password-reset.service.ts", () => ({
    findLivePasswordReset,
    completePasswordReset,
    replaceResetToken: mock(() => Promise.reject(new Error("no database in e2e"))),
    revokeResetLinks: mock(() => Promise.resolve(0)),
  }));
  void mock.module("../../src/modules/users/services/user-admin.service.ts", () => ({
    listAccounts: mock(() => Promise.resolve(ACCOUNTS)),
    changeAccountRole: accountAction,
    deactivateAccount: accountAction,
    reactivateAccount: accountAction,
    removeAccount: accountAction,
    transferOwnership: accountAction,
    issuePasswordReset,
  }));
  void mock.module("../../src/modules/users/services/passkey.service.ts", () => ({
    listPasskeys,
    startRegistration,
    finishRegistration,
    startPasskeyTwoFactor,
    completePasskeyTwoFactor,
    startPasskeySignIn,
    completePasskeySignIn,
    openPasskeySession,
    renamePasskey,
    deletePasskey,
  }));
  void mock.module("../../src/modules/users/services/two-factor.service.ts", () => ({
    twoFactorStatus: mock(() => Promise.reject(new Error("not in e2e"))),
    passwordHashOf: mock(() => Promise.resolve(null)),
    startEnrolment: mock(() => Promise.reject(new Error("not in e2e"))),
    pendingEnrolment: mock(() => Promise.resolve(null)),
    confirmEnrolment: mock(() => Promise.reject(new Error("not in e2e"))),
    completeTwoFactorLogin: mock(() => Promise.reject(new Error("not in e2e"))),
    disableTwoFactor: mock(() => Promise.reject(new Error("not in e2e"))),
    regenerateRecoveryCodes: mock(() => Promise.reject(new Error("not in e2e"))),
    removeSecondFactors: mock(() => Promise.resolve({ totp: false, passkeys: 0 })),
    removedAny: (removed: { totp: boolean; passkeys: number }) =>
      removed.totp || removed.passkeys > 0,
    secondFactorsOf,
  }));
  void mock.module("../../src/db/index.ts", () => ({
    db: {},
  }));
}
registerDashboardMocks();

/** Re-applies the dashboard mocks before the calling file's tests (see above). */
export function useDashboardMocks(): void {
  beforeAll(() => {
    registerDashboardMocks();
  });
}

/** Sets what the fake answers next (an imported `let` is read-only). */
export function setIssueResult(next: IssueInvitationResult): void {
  issueResult = next;
}

/** Sets what the fake answers next (an imported `let` is read-only). */
export function setAccountResult(next: AccountActionResult): void {
  accountResult = next;
}

/** Sets what the fake answers next (an imported `let` is read-only). */
export function setResetIssueResult(next: IssuePasswordResetResult): void {
  resetIssueResult = next;
}

/* ─── Import plugin after mocking ─── */
export const { pagesPlugin } = await import("../../src/pages/pages.plugin.tsx");
export const { withRequestContext } =
  await import("../../src/middleware/request-context.ts");
export const { securityHeadersPlugin } =
  await import("../../src/middleware/security-headers.ts");
export const { UserStoreError } = await import("../../src/modules/users/errors.ts");

/** Test app instance with the pages plugin */
export const app = new Elysia().use(pagesPlugin);

/* ─── Helpers ─── */

/** Form-POSTs to /dashboard/login; same-origin unless overridden. */
export function postLogin(
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
export function getWithSession(path: string, token: string): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      headers: { cookie: `bm_session=${token}` },
    }),
  );
}

/** The `bm_session` value a response sets, or null. */
export function cookieValue(response: Response): string | null {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) return null;
  return setCookie.match(/bm_session=([^;]*)/)?.[1] ?? null;
}
