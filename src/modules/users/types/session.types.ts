import type {
  CredentialType,
  SessionAssurance,
  UserRole,
} from "./user-value-sets.types.ts";

/**
 * Login and session types (#216, #222, #281). Re-exported by
 * `user.types.ts`.
 */

/** Request metadata stored with a new session (#216). */
export interface SessionClient {
  /** Resolved client IP; anything that is not an IP literal is stored as null. */
  ip: string | null;
  /** Raw `User-Agent` header; cut to the column width before it is stored. */
  userAgent: string | null;
}

/** What `createSession` needs to open a session (#216). */
export interface NewSessionInput extends SessionClient {
  /** `users.id` of the account signing in. */
  userId: string;
  /** How far login got; the guard only admits `password` and `mfa`. */
  assurance: SessionAssurance;
  /** Which credential type started the session. */
  authMethod: CredentialType;
  /**
   * `user_credentials.id` of the credential that was checked (#277). The
   * session dies with it: replacing the password deletes the row and
   * cascades, and a login racing a reset fails to insert (`23503`).
   */
  credentialId?: string | null;
}

/** A freshly opened session. `token` goes into the cookie, never into storage or logs. */
export interface CreatedSession {
  /** `sessions.id` (`ses_...`): safe to log, not a credential. */
  sessionId: string;
  /** Raw cookie value; only its SHA-256 is stored. */
  token: string;
}

/**
 * A live session found by the dashboard guard (#216). The presented token
 * matched either the session's current token or the one the last rotation
 * replaced; the flags are computed on the database clock. The account
 * fields come from the same query (#222), so the guard needs exactly one
 * lookup per request.
 */
export interface ActiveSession {
  /** `sessions.id`; safe to log. */
  sessionId: string;
  /** Owner of the session. */
  userId: string;
  /** The account's stored (lower-cased) email. PII: never log it raw. */
  email: string;
  /** The account's role, read on every request so a role change applies at once. */
  role: UserRole;
  /** How far the session got through login (`password` or `mfa` here). */
  assurance: SessionAssurance;
  /**
   * The account has a second factor (#220, #223): a confirmed `totp`
   * credential or a passkey, from the same query (`hasSecondFactor`). The
   * guard reads it for the `REQUIRE_2FA` policy.
   */
  hasSecondFactor: boolean;
  /**
   * The account has at least one SSO link (#224), from the same query
   * (`hasSsoLink`): the sidebar shows Sign-in methods for it even when no
   * provider is configured any more, so the link can still be removed.
   */
  hasSsoLink: boolean;
  /** Which of the session's two hashes the presented token matched. */
  matched: "current" | "previous";
  /** The current token is older than `SESSION_ROTATE_SECONDS`. */
  rotationDue: boolean;
  /** The last rotation is older than `SESSION_ROTATION_GRACE_SECONDS`. */
  graceOver: boolean;
}

/**
 * The signed-in account, as every protected dashboard handler sees it in
 * `auth` (#222). Built from the guard's single session lookup.
 */
export interface DashboardAuth {
  user: {
    /** `users.id`; safe to log. */
    id: string;
    /** Stored (lower-cased) email. PII: route it through `redactEmail` before logging. */
    email: string;
    /** Role the route guards rank: owner > admin > member. */
    role: UserRole;
  };
  session: {
    /** `sessions.id`; safe to log, not a credential. */
    id: string;
    /** `password` or `mfa` (a `pending` session never gets this far); `requireAssurance` compares against it. */
    assurance: SessionAssurance;
  };
}

/**
 * One live session of a user, as the Active sessions page lists it
 * (#281). Never carries a token or a hash.
 */
export interface UserSessionSummary {
  /** `sessions.id`; safe to log, not a credential. */
  id: string;
  /** Client address at login (a valid IP literal), or null. */
  ip: string | null;
  /** Raw stored `User-Agent` (escape before rendering), or null. */
  userAgent: string | null;
  /** Approximate location of `ip` ("City, Country"), or null. */
  location: string | null;
  /** When the session was opened (signed in at). */
  createdAt: Date;
  /** Last activity: moved forward by every token rotation. */
  lastSeenAt: Date;
}

/** A rotated session token and how long the cookie may live. */
export interface RotatedSession {
  /** The new raw cookie value. */
  token: string;
  /** Seconds left until the session's absolute cap: the cookie `Max-Age`. */
  maxAgeSec: number;
}

/**
 * Why a password login failed. Server logs only: every reason gets the
 * same response, so the form never reveals whether an account exists.
 */
export type LoginFailureReason = "unknown" | "no_password" | "disabled" | "bad_password";

/** Outcome of the first-factor (password) step of login (#216). */
export type LoginResult =
  | {
      ok: true;
      userId: string;
      assurance: SessionAssurance;
      /** The verified `password` credential; the session is bound to it (#277). */
      credentialId: string;
    }
  | {
      ok: false;
      reason: LoginFailureReason;
      /**
       * The account the email matched, for the audit log (#221); absent
       * for `unknown`. Never shown to the client.
       */
      userId?: string;
    };
