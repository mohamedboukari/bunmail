import type { AttemptLimiter } from "../../modules/users/types/user.types.ts";
import {
  TWO_FACTOR_MAX_FAILURES,
  TWO_FACTOR_WINDOW_SECONDS,
} from "../../modules/users/services/two-factor-policy.service.ts";
import {
  clearLoginAttempts,
  isLoginRateLimited,
  rateLimitBucket,
  recordFailedLogin,
  refundLoginAttempt,
} from "../../middleware/login-rate-limit.ts";

/**
 * Failed-attempt budgets for checks of a second factor (#220), on the
 * login limiter's primitives with keys of their own and fixed numbers
 * (`TWO_FACTOR_MAX_FAILURES` per `TWO_FACTOR_WINDOW_SECONDS`: 5 per 15
 * minutes), always on, whatever `DASHBOARD_LOGIN_RATE_LIMIT_*` says: a
 * six-digit code (three valid at any moment) needs a budget.
 *
 * Two budgets, so neither can be spent to block the other:
 *
 * - The **login step** (`twoFactorLoginLimiter`): `totp:user:<userId>` and
 *   `totp:ip:<client IP bucket>`. The account key is reachable only with
 *   the password, and it is what bounds guessing spread over many
 *   addresses.
 * - **In-session checks** (`twoFactorSessionLimiter`: disabling 2FA,
 *   regenerating recovery codes): `totp:session:<sessionId>` and the same
 *   address key. A stolen session can spend only its own budget, never the
 *   account's login budget; once spent, the route revokes that session.
 *
 * `clear` (a success) forgets the own key's failures and gives back this
 * request's own count on the address key; earlier failures from the
 * address stay until their window ends, as for the password login (#256).
 */

/** An `AttemptLimiter` that also says whether its own key (account or session) is spent. */
export interface TwoFactorLimiter extends AttemptLimiter {
  /** True when the account key (login) or the session key (in-session) is over budget. */
  ownKeyLimited(): boolean;
}

/** The window in milliseconds. */
const WINDOW_MS = TWO_FACTOR_WINDOW_SECONDS * 1000;

/** A limiter over an own key and the client's address key. */
function limiterFor(ownKey: string, ip: string): TwoFactorLimiter {
  const ipKey = `totp:ip:${rateLimitBucket(ip)}`;
  const keys = [ownKey, ipKey];
  const limited = (key: string): boolean =>
    isLoginRateLimited(key, TWO_FACTOR_MAX_FAILURES, WINDOW_MS).limited;
  return {
    isLimited: () => keys.some(limited),
    ownKeyLimited: () => limited(ownKey),
    record: () => {
      for (const key of keys) recordFailedLogin(key, WINDOW_MS);
    },
    clear: () => {
      clearLoginAttempts(ownKey);
      refundLoginAttempt(ipKey, WINDOW_MS);
    },
  };
}

/** The budget of the second login step: per account and per client address. */
export function twoFactorLoginLimiter(userId: string, ip: string): TwoFactorLimiter {
  return limiterFor(`totp:user:${userId}`, ip);
}

/** The budget of in-session code checks: per session and per client address. */
export function twoFactorSessionLimiter(sessionId: string, ip: string): TwoFactorLimiter {
  return limiterFor(`totp:session:${sessionId}`, ip);
}

/** When each account was last alerted that its login code budget ran out. */
const exhaustedAlerts = new Map<string, number>();

/**
 * Whether to email the account that its second login step's budget ran
 * out (#220): at most once per account and window, so a burst of
 * refused requests sends one email. Drops entries older than the window
 * on the way. In memory and per replica, like the budget itself.
 */
export function shouldAlertCodesExhausted(
  userId: string,
  now: number = Date.now(),
): boolean {
  for (const [key, at] of exhaustedAlerts) {
    if (now - at >= WINDOW_MS) exhaustedAlerts.delete(key);
  }
  if (exhaustedAlerts.has(userId)) return false;
  exhaustedAlerts.set(userId, now);
  return true;
}

/** Forgets every "alerted" mark. For tests, which reset the limiter map too. */
export function resetCodesExhaustedAlerts(): void {
  exhaustedAlerts.clear();
}
