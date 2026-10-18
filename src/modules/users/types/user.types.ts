import { sql, type SQL } from "drizzle-orm";
import type { db } from "../../../db/index.ts";

/**
 * Value sets for the dashboard accounts schema (#214). Each is enforced by
 * a `CHECK` constraint in the database as well as by these types, so a
 * typo can never become a privilege: an unknown role is rejected on write.
 */

/** Exactly one `owner` (database-enforced), any number of admins and members. */
export const USER_ROLES = ["owner", "admin", "member"] as const;
/** A dashboard account's role; the guard (#222) ranks them owner > admin > member. */
export type UserRole = (typeof USER_ROLES)[number];

/** Narrows a stored `users.role` value to a known role (#222). */
export function isUserRole(value: string): value is UserRole {
  return USER_ROLES.some((role) => role === value);
}

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

/** Narrows a stored `sessions.assurance` value to a known level (#222). */
export function isSessionAssurance(value: string): value is SessionAssurance {
  return SESSION_ASSURANCES.some((level) => level === value);
}

/** What a one-time token is for. */
export const TOKEN_PURPOSES = ["owner_setup", "invite", "password_reset"] as const;
export type TokenPurpose = (typeof TOKEN_PURPOSES)[number];

/**
 * Roles an invitation can grant (#217). Never `owner`: ownership moves
 * only by transfer. Enforced by `user_tokens_invite_check` in the
 * database as well as by the invite service.
 */
export const INVITE_ROLES = ["admin", "member"] as const;
/** A role an invitation can grant. */
export type InviteRole = (typeof INVITE_ROLES)[number];

/** Narrows a submitted or stored role to one an invitation can grant (#217). */
export function isInviteRole(value: string): value is InviteRole {
  return INVITE_ROLES.some((role) => role === value);
}

/** The signed-in account acting on invitations (from the guard's `auth`, #222). */
export interface InviteActor {
  /** `users.id` of the actor; stored as `invited_by` on a new invitation. */
  id: string;
  /** The actor's role, read with the session on every request. */
  role: UserRole;
}

/**
 * Why an invitation was not created, resent or revoked (#217):
 *
 * - `invalid_email`: the address is not one bare, well-formed address.
 * - `role_not_allowed`: the actor's role cannot grant (or manage) that role.
 * - `account_exists`: an account already holds the address.
 * - `pending_higher_role`: a live invitation for the address grants a role
 *   the actor cannot grant, so the actor may not replace (or downgrade) it.
 * - `not_found`: no pending invitation has that id.
 */
export type InviteRefusal =
  | "invalid_email"
  | "role_not_allowed"
  | "account_exists"
  | "pending_higher_role"
  | "not_found";

/**
 * Why the invitation email did not go out (#217), so the inviter can be
 * told to share the link by hand:
 *
 * - `not_configured`: `SYSTEM_MAIL_FROM` is not set.
 * - `sender_unavailable`: its domain is not registered in BunMail, not
 *   DKIM-verified, or its DKIM key cannot be used.
 * - `send_failed`: the send threw or no MX group accepted the message.
 * - `no_base_url`: `APP_BASE_URL` is unset or not an `http(s)://` URL, so
 *   the link would point at `localhost`; it is never emailed.
 */
export type InviteMailFailure =
  "not_configured" | "sender_unavailable" | "send_failed" | "no_base_url";

/** Outcome of sending an invitation email (#217). */
export type InviteMailOutcome =
  { sent: true } | { sent: false; reason: InviteMailFailure };

/**
 * A freshly minted invitation (#217). `token` is the raw value for the
 * accept link: it goes into the email or the one-time reveal, never into
 * storage, a URL of ours, a flash message or a log.
 */
export interface IssuedInvitation {
  /** `user_tokens.id` (`utk_...`); safe to log. */
  invitationId: string;
  /** Raw token for `/dashboard/invite?token=`; only its hash is stored. */
  token: string;
  /** The invited address, trimmed and lower-cased. PII: log it redacted. */
  email: string;
  /** Role the invitation grants. */
  role: InviteRole;
  /** When the link stops working. */
  expiresAt: Date;
  /** How many earlier open invitations for the address this one replaced. */
  replaced: number;
}

/**
 * Result of creating or resending an invitation (#217): the new
 * invitation, its absolute accept link and whether the email went out,
 * or why nothing was issued.
 */
export type IssueInvitationResult =
  | {
      ok: true;
      invitation: IssuedInvitation;
      /** Absolute accept link; shown to the inviter once when the email did not go out. */
      url: string;
      delivery: InviteMailOutcome;
    }
  | { ok: false; reason: InviteRefusal };

/** A pending invitation as the Invitations page lists it (#217). */
export interface PendingInvitation {
  /** `user_tokens.id`. */
  id: string;
  /** The invited address (lower-cased). */
  email: string;
  /** Role the invitation grants. */
  role: InviteRole;
  /** Name or email of the inviter, or `null` when that account is gone. */
  invitedBy: string | null;
  createdAt: Date;
  expiresAt: Date;
}

/** What a live invitation token opens (#217): the accept form's subject. */
export interface InviteTarget {
  /** `user_tokens.id`; safe to log. */
  invitationId: string;
  /** The invited address (lower-cased), shown on the form. */
  email: string;
  /** Role the new account will get. */
  role: InviteRole;
}

/** The new account's details from the accept form (#217). */
export interface InviteAcceptance {
  /** Display name, already trimmed and checked (`inviteNameProblem`). */
  name: string;
  /** Password, already checked against the setup policy. */
  password: string;
}

/**
 * Result of accepting an invitation (#217). `invalid` covers every dead
 * token (unknown, expired, used, revoked); `account_exists` means an
 * account took the address after the invitation was sent.
 */
export type AcceptInvitationResult =
  | {
      ok: true;
      /** `users.id` of the new account. */
      userId: string;
      /** The new account's email (lower-cased). PII: log it redacted. */
      email: string;
      role: InviteRole;
      /** Who sent the invitation, or `null` when that account is gone. */
      invitedBy: string | null;
      /** `sessions.id` of the session opened for the new account. */
      sessionId: string;
      /** Raw cookie value of that session. */
      sessionToken: string;
    }
  | { ok: false; reason: "invalid" | "account_exists" };

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
    /** `password` or `mfa`; `requireAssurance` compares against it. */
    assurance: SessionAssurance;
  };
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
