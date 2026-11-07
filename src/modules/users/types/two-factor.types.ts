/** Two-factor types (#220, #223). Re-exported by `user.types.ts`. */

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
  | "wrong_password"
  /** Turning TOTP off would leave the owner with an SSO link and no second factor (#224). */
  | "sso_link_requires_second_factor";

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
  /**
   * The stored `oidc:<issuer>` of the SSO link the session was opened
   * with (#224), for the new-device alert; `null` (or absent) for any
   * other first factor.
   */
  ssoProvider?: string | null;
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

/**
 * The second factors a recovery link removed (#220, #223): a completed
 * admin-issued reset link or `reset-owner` link takes every one away.
 */
export interface RemovedSecondFactors {
  /** The TOTP credential (and its recovery codes) was removed. */
  totp: boolean;
  /** How many passkeys were removed. */
  passkeys: number;
}
