import type { WindowTicket } from "../../../utils/shared-store.ts";

/** Passkey types (#223). Re-exported by `user.types.ts`. */

/* ─── Passkeys (#223) ─── */

/** A passkey as the Passkeys page lists it. Never carries the key or the counter. */
export interface PasskeySummary {
  /** `user_credentials.id` (`crd_...`); safe to log. */
  id: string;
  /** The user's label for it (escape before rendering). */
  name: string;
  createdAt: Date;
  /** Last successful sign-in with it, or null. */
  lastUsedAt: Date | null;
}

/**
 * The relying party passkeys are bound to (#223), derived from
 * `APP_BASE_URL`: its hostname is the RP ID, its origin the only origin
 * a ceremony may come from.
 */
export interface RelyingParty {
  /** Hostname of `APP_BASE_URL`, e.g. `mail.example.com`. */
  rpID: string;
  /** Origin of `APP_BASE_URL`, e.g. `https://mail.example.com`. */
  origin: string;
}

/**
 * Why a passkey ceremony was refused (#223). Logged server-side; the
 * browser gets one generic message per flow.
 *
 * - `rate_limited`: the failed-attempt budget is spent; nothing verified.
 * - `wrong_password`: the current password did not verify (add, delete).
 * - `invalid_name`: the name failed the policy (add, rename).
 * - `no_challenge`: no live challenge for this binding (never issued,
 *   already used, or older than 5 minutes).
 * - `rejected`: the response did not verify (origin, RP ID, challenge,
 *   signature, user verification, malformed input).
 * - `unknown_credential`: no passkey (of this account) has that id.
 * - `counter_regressed`: the signature counter did not grow, a possible
 *   cloned authenticator; the assertion is refused.
 * - `already_registered`: the authenticator is already registered.
 * - `account_disabled`: the account is deactivated (passwordless sign-in).
 * - `not_found`: no passkey of this account has that id (rename, delete).
 * - `session_gone`: the pending session expired, was revoked or completed.
 */
export type PasskeyRefusal =
  | "rate_limited"
  | "wrong_password"
  | "invalid_name"
  | "no_challenge"
  | "rejected"
  | "unknown_credential"
  | "counter_regressed"
  | "already_registered"
  | "account_disabled"
  | "not_found"
  | "session_gone"
  /** Removing this passkey would leave the owner with an SSO link and no second factor (#224). */
  | "sso_link_requires_second_factor";

/** A refused passkey action, with the passkey involved when one was found. */
export interface PasskeyFailure<R extends PasskeyRefusal = PasskeyRefusal> {
  ok: false;
  reason: R;
  /** The matched passkey (`counter_regressed`), for the alert and the log. */
  passkey?: { id: string; name: string; userId: string; email: string };
}

/** Result of a verified registration: the new passkey. */
export type FinishPasskeyRegistrationResult =
  | {
      ok: true;
      /** `user_credentials.id` of the new passkey. */
      credentialId: string;
      name: string;
      /** Other sessions signed out (only when this is the account's first second factor). */
      sessionsRevoked: number;
    }
  | PasskeyFailure<"no_challenge" | "rejected" | "already_registered">;

/** Result of the second login step with a passkey (#223). */
export type PasskeyTwoFactorResult =
  | {
      ok: true;
      /** `user_credentials.id` of the passkey used. */
      credentialId: string;
      /** The rotated session token (the pending one is dead). */
      token: string;
      /** Seconds left until the session's absolute cap: the cookie `Max-Age`. */
      maxAgeSec: number;
    }
  | PasskeyFailure<
      | "rate_limited"
      | "no_challenge"
      | "rejected"
      | "unknown_credential"
      | "counter_regressed"
      | "session_gone"
    >;

/** Result of a passwordless sign-in with a passkey (#223). */
export type PasskeySignInResult =
  | {
      ok: true;
      userId: string;
      /** The account's stored email (for the new-device alert). PII. */
      email: string;
      /** `user_credentials.id` of the passkey used; the caller binds the new session to it. */
      credentialId: string;
      /** The login-budget windows the options request counted in; the refund goes there (#185). */
      loginTicket?: WindowTicket;
    }
  | (PasskeyFailure<
      | "no_challenge"
      | "rejected"
      | "unknown_credential"
      | "counter_regressed"
      | "account_disabled"
    > & {
      /** The account the credential belongs to, when it was found (audit log). Never shown. */
      userId?: string;
    });
