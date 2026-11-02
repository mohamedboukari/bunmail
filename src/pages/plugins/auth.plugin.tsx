import type { PublicDashboard } from "../lib/session-guard.ts";
import { authLoginPages } from "./auth-login.plugin.tsx";
import { authTwoFactorLoginPages } from "./auth-login-two-factor.plugin.tsx";
import { authLogoutPages } from "./auth-logout.plugin.tsx";
import { authSetupPages } from "./auth-setup.plugin.tsx";
import { authInvitePages } from "./auth-invite.plugin.tsx";
import { authResetPages } from "./auth-reset.plugin.tsx";

/**
 * Public dashboard pages (#291): login (both steps, #220), logout, owner
 * setup, invitation accept and password reset. Mounted before the session
 * guard, so none of these routes runs it; each checks same-origin and its
 * token itself.
 */
export function authPages(app: PublicDashboard) {
  /**
   * One group per concern (#387), each registering its routes on this same
   * instance, in this order: login, the second login step, logout, owner
   * setup, invitation accept, password reset. Each group takes the
   * previous one's instance, so the route types are those of one chain.
   */
  return authResetPages(
    authInvitePages(
      authSetupPages(authLogoutPages(authTwoFactorLoginPages(authLoginPages(app)))),
    ),
  );
}
