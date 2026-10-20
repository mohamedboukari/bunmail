import type { TwoFactorPolicy, UserRole } from "../types/user.types.ts";

/**
 * The `REQUIRE_2FA` policy (#220). Pure: no I/O, no config (the guard
 * passes `config.dashboard.require2fa` in).
 */

/** The account's Two-factor page; also where the policy sends an account without a second factor. */
export const TWO_FACTOR_PAGE = "/dashboard/account/two-factor";

/** The account's Passkeys page (#223): a passkey is a second factor too, so the policy lets it through. */
export const PASSKEYS_PAGE = "/dashboard/account/passkeys";

/** The second login step, for a session that passed the password. */
export const TWO_FACTOR_LOGIN_PAGE = "/dashboard/login/two-factor";

/**
 * Whether an account of `role` must have a second factor under `policy`:
 * `none` nobody, `owner` the owner, `admin` admins and the owner.
 */
export function twoFactorRequired(policy: TwoFactorPolicy, role: UserRole): boolean {
  if (policy === "owner") return role === "owner";
  if (policy === "admin") return role === "owner" || role === "admin";
  return false;
}

/**
 * Routes an account the policy holds back may still open: the Two-factor
 * page, the Passkeys page (#223) and their actions (to enrol either
 * factor). Logout and the assets are public routes, before the session
 * guard, so they never reach this check.
 */
export function isTwoFactorEnrolmentPath(path: string): boolean {
  return [TWO_FACTOR_PAGE, PASSKEYS_PAGE].some(
    (page) => path === page || path.startsWith(`${page}/`),
  );
}

/**
 * Failed two-factor code checks allowed per key and window (#220): a code
 * constant, not `DASHBOARD_LOGIN_RATE_LIMIT_MAX`, so a loose (or broken)
 * login setting can never leave the 6-digit code without a budget.
 */
export const TWO_FACTOR_MAX_FAILURES = 5;

/** Length of the two-factor failure window, in seconds (15 minutes). */
export const TWO_FACTOR_WINDOW_SECONDS = 15 * 60;
