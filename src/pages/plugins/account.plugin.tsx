import type { GuardedDashboard } from "../lib/session-guard.ts";
import { accountSessionPages } from "./account-sessions.plugin.tsx";
import { accountTwoFactorPages } from "./account-two-factor.plugin.tsx";
import { accountTwoFactorManagePages } from "./account-two-factor-manage.plugin.tsx";
import { accountPasswordPages } from "./account-password.plugin.tsx";

/**
 * The signed-in user's own account: the Change password page (#279), the
 * Active sessions page (#281) and the Two-factor page (#220). Every role,
 * the owner included.
 */
export function accountPages(app: GuardedDashboard) {
  /**
   * One group per concern (#387), each registering its routes on this same
   * instance, in this order: Active sessions, the Two-factor page and its
   * enrolment, two-factor while on, Change password. Each group takes the
   * previous one's instance, so the route types are those of one chain.
   */
  return accountPasswordPages(
    accountTwoFactorManagePages(accountTwoFactorPages(accountSessionPages(app))),
  );
}
