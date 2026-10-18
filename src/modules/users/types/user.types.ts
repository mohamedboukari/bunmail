import { sql, type SQL } from "drizzle-orm";
import type { db } from "../../../db/index.ts";

/**
 * Value sets for the dashboard accounts schema (#214). Each is enforced by
 * a `CHECK` constraint in the database as well as by these types, so a
 * typo can never become a privilege: an unknown role is rejected on write.
 */

/** Exactly one `owner` (database-enforced), any number of admins and members. */
export const USER_ROLES = ["owner", "admin", "member"] as const;
/** @public Consumed by the login, invite and guard flows (#215 to #218); exported ahead of them. */
export type UserRole = (typeof USER_ROLES)[number];

/**
 * Login methods. `password` is the only one implemented; the others are
 * reserved so 2FA (#220), passkeys (#223) and OAuth/SSO (#224) can add rows
 * without a schema change.
 */
export const CREDENTIAL_TYPES = ["password", "totp", "passkey", "oauth"] as const;
export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

/**
 * How far a session has got through login. `pending` means the first
 * factor passed and a second one is still required; `password` is a
 * normal session; `mfa` passed a second factor. The auth guard (#222) can
 * require a minimum level per route.
 */
export const SESSION_ASSURANCES = ["pending", "password", "mfa"] as const;
export type SessionAssurance = (typeof SESSION_ASSURANCES)[number];

/** What a one-time token is for. */
export const TOKEN_PURPOSES = ["owner_setup", "invite", "password_reset"] as const;
export type TokenPurpose = (typeof TOKEN_PURPOSES)[number];

/**
 * A freshly minted owner setup link (#215). `token` is the raw value for
 * the URL: it is shown once (log line or terminal) and never stored.
 */
export interface OwnerSetupLink {
  /** Raw token to put in `/dashboard/setup?token=`; only its hash is stored. */
  token: string;
  /** The owner's stored (lower-cased) email. */
  email: string;
  /** When the link stops working. */
  expiresAt: Date;
}

/**
 * What the boot-time owner bootstrap did (#215), so `src/index.ts` can log
 * the right line:
 *
 * - `created`: no owner existed; one was created with a setup link.
 * - `reissued`: the owner exists but has not set a password yet; the old
 *   link was revoked and a new one minted.
 * - `complete`: the owner has a password and the configured email matches.
 * - `mismatch`: the owner has a password and the configured email differs;
 *   nothing changed (ownership moves only by transfer).
 * - `email-taken`: a non-owner account already holds the configured email;
 *   nothing changed (an env value never promotes an existing account).
 */
export type OwnerBootstrapResult =
  | ({ kind: "created" | "reissued" } & OwnerSetupLink)
  | { kind: "complete" }
  | { kind: "mismatch"; storedEmail: string }
  | { kind: "email-taken" };

/** The transaction handle `db.transaction` passes to its callback. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Where a users-module write runs: the shared pool, or a transaction the
 * caller opened (owner setup creates the owner's session inside its own
 * advisory-lock transaction, #216).
 */
export type DbExecutor = typeof db | Tx;

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
 * replaced; the flags are computed on the database clock.
 */
export interface ActiveSession {
  /** `sessions.id`; safe to log. */
  sessionId: string;
  /** Owner of the session. */
  userId: string;
  /** Which of the session's two hashes the presented token matched. */
  matched: "current" | "previous";
  /** The current token is older than `SESSION_ROTATE_SECONDS`. */
  rotationDue: boolean;
  /** The last rotation is older than `SESSION_ROTATION_GRACE_SECONDS`. */
  graceOver: boolean;
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
  | { ok: true; userId: string; assurance: SessionAssurance }
  | { ok: false; reason: LoginFailureReason };

/** What a completed owner setup returns (#215, #216). */
export interface CompletedOwnerSetup {
  /** `users.id` of the owner. */
  userId: string;
  /** The owner's stored (lower-cased) email. */
  email: string;
  /** Raw cookie value of the session opened for the owner. */
  sessionToken: string;
}

/**
 * Renders a value set as a quoted SQL list for a `CHECK (... IN (...))`
 * constraint: `'owner', 'admin', 'member'`. These are code constants, never
 * user input, so inlining them is safe; bound parameters are not valid in
 * DDL and drizzle-kit would emit `$1, $2` placeholders into the migration.
 */
export function literals(values: readonly string[]): SQL {
  return sql.raw(values.map((v) => `'${v.replaceAll("'", "''")}'`).join(", "));
}
