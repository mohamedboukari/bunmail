import type { AccountRefusal } from "./account.types.ts";
import type { RemovedSsoLink } from "./sso.types.ts";
import type { RemovedSecondFactors } from "./two-factor.types.ts";
import type { SessionAssurance } from "./user-value-sets.types.ts";

/**
 * Password reset (#277) and password change (#279) types. Re-exported by
 * `user.types.ts`.
 */

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
      /** A second factor was removed (#220, #223): TOTP with its recovery codes, or passkeys. */
      twoFactorRemoved: boolean;
      /** What exactly was removed, for the security email and the audit log (#223). */
      secondFactorsRemoved: RemovedSecondFactors;
      /** The SSO links removed with them (#224), with the sessions they opened. */
      ssoLinksRemoved: RemovedSsoLink[];
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
