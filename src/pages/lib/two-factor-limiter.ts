import { config } from "../../config.ts";
import type { AttemptLimiter } from "../../modules/users/types/user.types.ts";
import {
  clearLoginAttempts,
  isLoginRateLimited,
  rateLimitBucket,
  recordFailedLogin,
  refundLoginAttempt,
} from "../../middleware/login-rate-limit.ts";

/**
 * Failed-attempt budget for every check of a second factor (#220): the
 * login step, disabling 2FA and regenerating recovery codes. Built from
 * the login limiter's primitives and settings (`DASHBOARD_LOGIN_RATE_LIMIT_MAX`
 * attempts per `DASHBOARD_LOGIN_RATE_LIMIT_WINDOW` seconds), with keys of
 * its own: `totp:user:<userId>` and `totp:ip:<client IP bucket>` (IPv6 by
 * /64). One budget for all three routes, so a code cannot be guessed
 * faster by spreading the guesses over them.
 *
 * Always on, even when `DASHBOARD_LOGIN_RATE_LIMIT_ENABLED=false`: a
 * six-digit code is guessable without a budget (three codes are valid at
 * any moment), and the per-account key is what bounds it. That key is
 * reachable only after the password (or with a signed-in session), so
 * locking it costs an attacker the password first.
 *
 * `clear` (a success) forgets the account's failures and gives back this
 * request's own count on the address key; earlier failures from the
 * address stay until their window ends, as for the password login (#256).
 */
export function twoFactorLimiter(userId: string, ip: string): AttemptLimiter {
  const { maxAttempts, windowSec } = config.dashboard.loginRateLimit;
  const windowMs = windowSec * 1000;
  const userKey = `totp:user:${userId}`;
  const ipKey = `totp:ip:${rateLimitBucket(ip)}`;
  const keys = [userKey, ipKey];
  return {
    isLimited: () =>
      keys.some((key) => isLoginRateLimited(key, maxAttempts, windowMs).limited),
    record: () => {
      for (const key of keys) recordFailedLogin(key, windowMs);
    },
    clear: () => {
      clearLoginAttempts(userKey);
      refundLoginAttempt(ipKey, windowMs);
    },
  };
}
