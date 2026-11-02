import type { Context } from "elysia";
import type {
  DashboardAuth,
  TwoFactorRefusal,
} from "../../modules/users/types/user.types.ts";
import { stashRevealSecret } from "../reveal-store.ts";
import { TWO_FACTOR_PAGE } from "../../modules/users/services/two-factor-policy.service.ts";
import { redirect } from "./responses.ts";
import { revealOwnerOf } from "./reveal-owner.ts";
import { sendTwoFactorAlert } from "../../modules/users/services/two-factor-alert.service.ts";
import { sessionIp } from "../../modules/users/services/session-policy.service.ts";

/* ─── Two-factor helpers (#220) ─── */

/**
 * What the Two-factor page says for a refused action. A wrong code and a
 * wrong password get one message where both are asked for, so the page
 * never says which of the two was wrong.
 */
export const TWO_FACTOR_REFUSAL: Record<TwoFactorRefusal, string> = {
  rate_limited: "Too many attempts. Try again later.",
  no_pending: "Start the setup again: no setup was in progress in this browser.",
  already_enabled: "Two-factor authentication is already on.",
  not_enabled: "Two-factor authentication is off.",
  wrong_code: "Invalid code. Try again.",
  wrong_password: "The password or the code is incorrect.",
  sso_link_requires_second_factor:
    "You are the owner and have a single sign-on account linked: unlink it on the Sign-in methods page before turning two-factor authentication off.",
};

/** Redirects to the Two-factor page with a flash banner (and a reveal token). */
export function toTwoFactorPage(
  set: Context["set"],
  message: string,
  type: "success" | "error",
  reveal?: string,
): string {
  const query = `flash=${encodeURIComponent(message)}&flashType=${type}`;
  return redirect(
    set,
    `${TWO_FACTOR_PAGE}?${query}${reveal === undefined ? "" : `&reveal=${reveal}`}`,
  );
}

/**
 * Emails the account about a change to its two-factor authentication
 * (#220), in the background: never awaited, never fails the action.
 */
export function alertTwoFactorChange(
  event: "enabled" | "disabled" | "recovery_codes_regenerated",
  auth: DashboardAuth,
  ip: string,
): void {
  void sendTwoFactorAlert({
    event,
    userId: auth.user.id,
    email: auth.user.email,
    ip: sessionIp(ip),
  });
}

/**
 * Stashes fresh recovery codes in the one-time reveal store (#280), bound
 * to this user and session, and returns the reveal token for the
 * redirect: the codes never go into a URL, a flash or a log.
 */
export function stashRecoveryCodes(
  codes: string[],
  auth: DashboardAuth,
): Promise<string> {
  return stashRevealSecret(codes.join("\n"), "recovery_codes", revealOwnerOf(auth));
}
