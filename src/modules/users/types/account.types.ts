import type { UserRole } from "./user-value-sets.types.ts";

/** Account management types (#218). Re-exported by `user.types.ts`. */

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
 * - `sso_link_without_second_factor`: the transfer target has an SSO link
 *   and no BunMail second factor, which the owner may not (#224).
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
  | "sso_link_without_second_factor"
  | "rate_limited"
  | "account_disabled";

/**
 * Failed-attempt budget for the ownership transfer password check (#218).
 * The route builds it from the login limiter (`login-rate-limit.ts`) with
 * its own keys (per actor and per client IP); the service calls `take`
 * before any argon2id work (the check and the count are one atomic step
 * in the shared store, #185, so a parallel burst cannot outrun it, even
 * across replicas) and `clear` after a completed transfer.
 */
export interface AttemptLimiter {
  /**
   * Refuses when any key is over its budget (true, nothing counted), else
   * counts one attempt against every key (false). Atomic.
   */
  take(): Promise<boolean>;
  /** True when any key is over its budget; counts nothing. */
  isLimited(): Promise<boolean>;
  /** Forgets every key's attempts. */
  clear(): Promise<void>;
}

/** Outcome of an account action (#218); the service has already logged it. */
export type AccountActionResult = { ok: true } | { ok: false; reason: AccountRefusal };
