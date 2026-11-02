import { config } from "../../config.ts";
import type { AttemptLimiter } from "../../modules/users/types/user.types.ts";
import {
  clearLoginAttempts,
  isLoginRateLimited,
  rateLimitBucket,
  takeLoginAttempt,
} from "../../middleware/login-rate-limit.ts";

/**
 * Failed-attempt budget for the current password check (#279): the login
 * limiter's primitives and settings (`DASHBOARD_LOGIN_RATE_LIMIT_*`), like
 * the ownership transfer's `transferLimiter`, with keys of its own, one
 * per account and one per client IP, so neither a stolen session nor one
 * address can guess faster than a login could. The `password:` prefix
 * keeps them apart from the login and transfer keys. No-op when the
 * limiter is off. Also the re-authentication of the passkey actions
 * (#223: adding and removing a passkey), which share these keys.
 */
export function passwordChangeLimiter(userId: string, ip: string): AttemptLimiter {
  /** IPv6 clients by /64, like the login (#256). */
  return loginBudgetLimiter([
    `password:user:${userId}`,
    `password:ip:${rateLimitBucket(ip)}`,
  ]);
}

/**
 * An `AttemptLimiter` over `keys` with the login limiter's settings
 * (`DASHBOARD_LOGIN_RATE_LIMIT_*`): never limited when the limiter is off.
 * Shared by the password change and the ownership transfer (#218).
 */
export function loginBudgetLimiter(keys: readonly string[]): AttemptLimiter {
  const { enabled, maxAttempts, windowSec } = config.dashboard.loginRateLimit;
  const windowMs = windowSec * 1000;
  return {
    take: async () =>
      enabled && (await takeLoginAttempt(keys, maxAttempts, windowMs)).limited,
    isLimited: async () => {
      if (!enabled) return false;
      for (const key of keys) {
        if ((await isLoginRateLimited(key, maxAttempts)).limited) return true;
      }
      return false;
    },
    clear: () => clearLoginAttempts(keys),
  };
}
