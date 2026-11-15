import { describe, test, expect, afterEach } from "bun:test";
import { loginAttemptMap } from "../../src/middleware/login-rate-limit.ts";
import { TWO_FACTOR_MAX_FAILURES } from "../../src/modules/users/services/two-factor-policy.service.ts";
import {
  twoFactorLoginLimiter,
  twoFactorSessionLimiter,
  type TwoFactorLimiter,
} from "../../src/pages/lib/two-factor-limiter.ts";

/**
 * The second-factor budgets (#220), in process memory: an own key (the
 * account at login, the session in-session) plus the client address key,
 * so a stolen session can spend only its own budget, never the
 * account's login budget.
 */

afterEach(() => {
  loginAttemptMap.clear();
});

/** Spends `count` failures; returns whether the last take was refused. */
async function fail(limiter: TwoFactorLimiter, count: number): Promise<boolean> {
  let limited = false;
  for (let i = 0; i < count; i += 1) limited = await limiter.take();
  return limited;
}

describe("twoFactorSessionLimiter", () => {
  test("TWO_FACTOR_MAX_FAILURES failures are allowed, the next is refused", async () => {
    const limiter = twoFactorSessionLimiter("ses_one", "203.0.113.7");
    expect(await fail(limiter, TWO_FACTOR_MAX_FAILURES)).toBe(false);
    expect(await limiter.take()).toBe(true);
    expect(await limiter.isLimited()).toBe(true);
    expect(await limiter.ownKeyLimited()).toBe(true);
  });

  test("a spent session never spends the account's login budget", async () => {
    const session = twoFactorSessionLimiter("ses_stolen", "203.0.113.7");
    await fail(session, TWO_FACTOR_MAX_FAILURES + 1);
    /** Another address: the login step for the same account is untouched. */
    const login = twoFactorLoginLimiter("usr_owner", "198.51.100.9");
    expect(await login.isLimited()).toBe(false);
    expect(await login.ownKeyLimited()).toBe(false);
  });

  test("the address key is shared: another session from the spent address is limited, its own key is not", async () => {
    await fail(
      twoFactorSessionLimiter("ses_a", "203.0.113.7"),
      TWO_FACTOR_MAX_FAILURES + 1,
    );
    const other = twoFactorSessionLimiter("ses_b", "203.0.113.7");
    expect(await other.ownKeyLimited()).toBe(false);
    expect(await other.isLimited()).toBe(true);
  });

  test("clear forgets the own key's failures and refunds this request's count on the address", async () => {
    const earlier = twoFactorSessionLimiter("ses_x", "203.0.113.7");
    await fail(earlier, TWO_FACTOR_MAX_FAILURES - 1);
    const limiter = twoFactorSessionLimiter("ses_x", "203.0.113.7");
    await limiter.take();
    await limiter.clear();
    expect(await limiter.ownKeyLimited()).toBe(false);
    /** The address keeps the earlier failures: one more fills it, a second is refused. */
    const next = twoFactorSessionLimiter("ses_y", "203.0.113.7");
    expect(await next.take()).toBe(false);
    expect(await next.take()).toBe(true);
  });
});
