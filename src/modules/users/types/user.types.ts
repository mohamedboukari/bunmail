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
 * Login methods. `password` and `totp` (the second factor, #220) are
 * implemented; the others are reserved so passkeys (#223) and OAuth/SSO
 * (#224) can add rows without a schema change.
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

/** An account as the Users page lists it (#218). */
export interface AccountSummary {
  /** `users.id`. */
  id: string;
  /** Stored (lower-cased) email. PII: log it redacted. */
  email: string;
  /** Display name, or `null` when none was set (the owner). */
  name: string | null;
  role: UserRole;
  /** True when the account is deactivated (`disabled_at` set). */
  disabled: boolean;
  createdAt: Date;
}

/**
 * What one account can do to another on the Users page (#218):
 *
 * - `change_role`: member to admin or back (owner only; never to or from owner).
 * - `deactivate` / `reactivate`: set or clear `disabled_at`.
 * - `remove`: delete the account for good.
 * - `transfer_ownership`: make an active admin the owner (owner only).
 * - `reset_password`: issue a one-time password reset link (#277), shown
 *   once to the issuer; same "who may manage whom" as deactivation, and
 *   never for a disabled account.
 */
export type AccountAction =
  | "change_role"
  | "deactivate"
  | "reactivate"
  | "remove"
  | "transfer_ownership"
  | "reset_password";

/**
 * Why an account action was refused (#218):
 *
 * - `actor_inactive`: the acting account is gone, deactivated or has an
 *   unknown role (a request that raced its own deactivation).
 * - `not_found`: no account has the target id.
 * - `self`: nobody changes the role or status of their own account.
 * - `target_is_owner`: the owner is never demoted, deactivated or removed.
 * - `role_not_allowed`: the actor's role may not do this to the target's role.
 * - `invalid_role`: the requested role is not `admin` or `member`.
 * - `unchanged`: the target already has that role or status.
 * - `confirm_mismatch`: the removal confirmation is not the target's email.
 * - `wrong_password`: the ownership transfer password is wrong.
 * - `not_eligible`: the transfer target is not an active admin.
 * - `rate_limited`: too many failed ownership transfer password checks.
 * - `account_disabled`: a password reset for a deactivated account (#277):
 *   reactivate it first.
 */
export type AccountRefusal =
  | "actor_inactive"
  | "not_found"
  | "self"
  | "target_is_owner"
  | "role_not_allowed"
  | "invalid_role"
  | "unchanged"
  | "confirm_mismatch"
  | "wrong_password"
  | "not_eligible"
  | "rate_limited"
  | "account_disabled";

/**
 * Failed-attempt budget for the ownership transfer password check (#218).
 * The route builds it from the login limiter (`login-rate-limit.ts`) with
 * its own keys (per actor and per client IP); the service calls it in
 * order: `isLimited` before any argon2id work, `record` right after (no
 * await in between, so a parallel burst cannot outrun it), `clear` after
 * a completed transfer.
 */
export interface AttemptLimiter {
  /** True when any key is over its budget. */
  isLimited(): boolean;
  /** Counts one attempt against every key. */
  record(): void;
  /** Forgets every key's attempts. */
  clear(): void;
}

/** Outcome of an account action (#218); the service has already logged it. */
export type AccountActionResult = { ok: true } | { ok: false; reason: AccountRefusal };

/**
 * A freshly minted password reset token (#277). `token` is the raw value
 * for the link: it goes into the one-time reveal for the issuer, never
 * into storage, a URL of ours, a flash message, an email or a log.
 */
export interface IssuedPasswordReset {
  /** `user_tokens.id` (`utk_...`); safe to log. */
  resetId: string;
  /** Raw token for `/dashboard/reset?token=`; only its hash is stored. */
  token: string;
  /** When the link stops working (one hour after issue, database clock). */
  expiresAt: Date;
  /** How many earlier open reset links of the account this one replaced. */
  replaced: number;
}

/**
 * Result of issuing a password reset link (#277): the absolute link for
 * the one-time reveal, or why nothing was issued (the service has already
 * logged it).
 */
export type IssuePasswordResetResult =
  | {
      ok: true;
      /** `user_tokens.id`; safe to log. */
      resetId: string;
      /** Absolute reset link; shown to the issuer once, never stored or logged. */
      url: string;
      /** True when `APP_BASE_URL` was unusable and the link points at localhost. */
      usedFallback: boolean;
      expiresAt: Date;
    }
  | { ok: false; reason: AccountRefusal };

/** What a live password reset token opens (#277): the reset form's subject. */
export interface PasswordResetTarget {
  /** `user_tokens.id`; safe to log. */
  resetId: string;
  /** `users.id` of the account whose password is reset. */
  userId: string;
  /** The account's stored (lower-cased) email, shown on the form. PII. */
  email: string;
}

/**
 * Result of completing a password reset (#277). `invalid` covers every
 * dead link (unknown, expired, used, revoked, account disabled or gone,
 * issuer gone, disabled or no longer allowed to manage the account).
 */
export type CompletePasswordResetResult =
  | {
      ok: true;
      /** `user_tokens.id` of the spent link. */
      resetId: string;
      /** `users.id` of the account. */
      userId: string;
      /** The account's stored email. PII: log it redacted. */
      email: string;
      /** `users.id` of whoever issued the link. */
      issuedBy: string;
      /** How many sessions of the account were revoked. */
      sessionsRevoked: number;
      /** How many other open tokens of the account were revoked. */
      tokensRevoked: number;
      /** How many open invitations and reset links the account had issued were revoked. */
      issuedTokensRevoked: number;
      /** The account's TOTP second factor and recovery codes were removed (#220). */
      twoFactorRemoved: boolean;
      /** `sessions.id` of the session opened for the account. */
      sessionId: string;
      /** Raw cookie value of that session. */
      sessionToken: string;
    }
  | { ok: false; reason: "invalid" };

/**
 * Why a password change (#279) changed nothing:
 *
 * - `rate_limited`: the failed-attempt budget is spent; no argon2id ran.
 * - `invalid_input`: the form failed the policy (`passwordChangeProblem`);
 *   no argon2id ran and no attempt was counted.
 * - `wrong_password`: the current password did not verify (or the
 *   account has no password); counted against the budget.
 * - `account_inactive`: the account was deactivated or removed meanwhile.
 * - `credential_changed`: the password verified a moment ago was replaced
 *   meanwhile (an admin-issued reset completed, or a parallel change won).
 */
export type PasswordChangeRefusal =
  | "rate_limited"
  | "invalid_input"
  | "wrong_password"
  | "account_inactive"
  | "credential_changed";

/** What a signed-in user submitted to change their own password (#279). */
export interface PasswordChangeInput {
  /** `users.id` of the signed-in account (from the guard's `auth`). */
  userId: string;
  /**
   * Assurance of the session the change is made from (#220): the session
   * opened for this browser keeps it, so an `mfa` session stays `mfa`.
   */
  assurance: SessionAssurance;
  /** The current password, as typed. */
  current: string;
  /** The new password. */
  password: string;
  /** The new password again. */
  confirm: string;
}

/**
 * Result of a password change (#279): the fresh session for this browser,
 * or why nothing changed (`problem` carries the policy message for
 * `invalid_input`). Never carries a password or a hash.
 */
export type ChangePasswordResult =
  | {
      ok: true;
      /** How many sessions of the account were revoked (this browser's included). */
      sessionsRevoked: number;
      /** How many open password reset links for the account were revoked. */
      resetLinksRevoked: number;
      /** `sessions.id` of the session opened for this browser. */
      sessionId: string;
      /** Raw cookie value of that session. */
      sessionToken: string;
    }
  | { ok: false; reason: Exclude<PasswordChangeRefusal, "invalid_input"> }
  | { ok: false; reason: "invalid_input"; problem: string };

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

/**
 * Templates, domains and webhooks whose creator an ownership transfer
 * changed (#219). API keys never move. Logged as counts, never IDs.
 */
export interface ContentRecordCounts {
  templates: number;
  domains: number;
  webhooks: number;
}

/**
 * Rows per table the boot backfill assigned to the owner (#219), API
 * keys included. Logged as counts, never IDs.
 */
export interface RecordCounts extends ContentRecordCounts {
  /** `api_keys` rows. */
  keys: number;
}

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
   * The account has a confirmed `totp` credential (#220), from the same
   * query. The guard reads it for the `REQUIRE_2FA` policy.
   */
  hasTotp: boolean;
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
  | { ok: false; reason: LoginFailureReason };

/* ─── Two-factor authentication (#220) ─── */

/**
 * Who must have a second factor before using the dashboard
 * (`REQUIRE_2FA`): nobody (`none`, the default), the owner (`owner`), or
 * admins and the owner (`admin`).
 */
export const TWO_FACTOR_POLICIES = ["none", "owner", "admin"] as const;
/** A `REQUIRE_2FA` value. */
export type TwoFactorPolicy = (typeof TWO_FACTOR_POLICIES)[number];

/** Narrows a configured `REQUIRE_2FA` value to a known policy. */
export function isTwoFactorPolicy(value: string): value is TwoFactorPolicy {
  return TWO_FACTOR_POLICIES.some((policy) => policy === value);
}

/** The two-factor state of one account, for the Two-factor page. */
export interface TwoFactorStatus {
  /** The account has a confirmed `totp` credential. */
  enabled: boolean;
  /** When it was confirmed, or null when disabled. */
  enabledAt: Date | null;
  /** Unused recovery codes left (0 when disabled). */
  recoveryCodesLeft: number;
}

/**
 * An enrolment started in this session and not confirmed yet: the secret
 * the authenticator app must be given. Never logged, never in a URL.
 */
export interface PendingEnrolment {
  /** The base32 secret (RFC 4648, no padding), shown for manual entry. */
  secret: string;
  /** The `otpauth://` URI the QR code encodes. Never rendered as text or in an attribute. */
  uri: string;
}

/**
 * Why a two-factor action changed nothing:
 *
 * - `rate_limited`: the failed-attempt budget is spent; nothing was verified.
 * - `no_pending`: no enrolment was started in this session (or it was confirmed meanwhile).
 * - `already_enabled`: the account already has a `totp` credential.
 * - `not_enabled`: the account has no `totp` credential.
 * - `wrong_code`: the code did not verify, or was already used (replay).
 * - `wrong_password`: the current password did not verify (disable only).
 */
export type TwoFactorRefusal =
  | "rate_limited"
  | "no_pending"
  | "already_enabled"
  | "not_enabled"
  | "wrong_code"
  | "wrong_password";

/** Result of confirming an enrolment: the recovery codes, shown once. */
export type ConfirmEnrolmentResult =
  | {
      ok: true;
      /** The raw recovery codes (`xxxx-xxxx-xxxx-xxxx`); only their hashes are stored. */
      recoveryCodes: string[];
      /** How many other sessions of the account were signed out. */
      sessionsRevoked: number;
    }
  | { ok: false; reason: TwoFactorRefusal };

/** Result of regenerating the recovery codes. */
export type RegenerateRecoveryCodesResult =
  { ok: true; recoveryCodes: string[] } | { ok: false; reason: TwoFactorRefusal };

/** How a second factor was proved: a code from the app, or a recovery code. */
export type SecondFactorMethod = "totp" | "recovery_code";

/** Result of disabling two-factor authentication. */
export type DisableTwoFactorResult =
  | {
      ok: true;
      /** Which second factor the user proved with. */
      method: SecondFactorMethod;
    }
  | { ok: false; reason: TwoFactorRefusal };

/**
 * A live session that passed the password step and waits for the second
 * one (#220): what the two-factor login page needs.
 */
export interface PendingSession {
  /** `sessions.id`; safe to log. */
  sessionId: string;
  /** The account signing in. */
  userId: string;
  /** The account's stored email (for the new-device alert). PII. */
  email: string;
}

/**
 * Result of the second login step (#220). `session_gone` covers a pending
 * session that expired, was revoked or was completed by another request.
 */
export type TwoFactorLoginResult =
  | {
      ok: true;
      method: SecondFactorMethod;
      /** Unused recovery codes left, when one was used; null for a TOTP code. */
      recoveryCodesLeft: number | null;
      /** The rotated session token (the pending one is dead). */
      token: string;
      /** Seconds left until the session's absolute cap: the cookie `Max-Age`. */
      maxAgeSec: number;
    }
  | { ok: false; reason: "rate_limited" | "wrong_code" | "session_gone" };

/** What a completed owner setup returns (#215, #216). */
export interface CompletedOwnerSetup {
  /** `users.id` of the owner. */
  userId: string;
  /** The owner's stored (lower-cased) email. */
  email: string;
  /** Raw cookie value of the session opened for the owner. */
  sessionToken: string;
  /** The owner's TOTP second factor and recovery codes were removed (#220, reset-owner recovery). */
  twoFactorRemoved: boolean;
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
