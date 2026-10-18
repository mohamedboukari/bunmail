import { buildDashboardUrl } from "./owner-setup-policy.service.ts";

/**
 * Rules for password reset links (#277): how long a link lives and how it
 * is built. Who may issue one for whom is `accountActionRefusal`
 * (`reset_password`, `user-admin-policy.service.ts`); the database side
 * lives in `password-reset.service.ts`; the new password follows the
 * owner setup policy (`setupPasswordProblem`).
 *
 * Pure: no I/O, no config, so it unit-tests without mocks.
 */

/**
 * Lifetime of a password reset link, in minutes: one hour. A code
 * constant, not an env var: the issuing admin hands the link over right
 * away, and a short window limits what a leaked link is worth. Inlined
 * into the expiry SQL as an interval literal (database clock).
 */
export const PASSWORD_RESET_TTL_MINUTES = 60;

/**
 * Builds the absolute reset link for a token, from `APP_BASE_URL` or the
 * `http://localhost:PORT` fallback (see `buildDashboardUrl`).
 */
export function buildPasswordResetUrl(
  appBaseUrl: string,
  port: number,
  token: string,
): { url: string; usedFallback: boolean } {
  return buildDashboardUrl(
    appBaseUrl,
    port,
    `/dashboard/reset?token=${encodeURIComponent(token)}`,
  );
}
