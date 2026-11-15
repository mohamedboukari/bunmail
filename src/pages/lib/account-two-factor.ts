import type { Context } from "elysia";
import type {
  DashboardAuth,
  TwoFactorRefusal,
} from "../../modules/users/types/user.types.ts";
import { stashRevealSecret } from "../reveal-store.ts";
import { TWO_FACTOR_PAGE } from "../../modules/users/services/two-factor-policy.service.ts";
import { redirect } from "./responses.ts";
import { flashUrl } from "./flash.ts";
import type { FlashCode } from "./flash-codes.ts";
import { revealOwnerOf } from "./reveal-owner.ts";
import { sendTwoFactorAlert } from "../../modules/users/services/two-factor-alert.service.ts";
import { sessionIp } from "../../modules/users/services/session-policy.service.ts";

/* ─── Two-factor helpers (#220) ─── */

/**
 * The Two-factor page's flash code for a refused action (#421: a code,
 * never text). A wrong code and a wrong password get one message where
 * both are asked for, so the page never says which of the two was wrong.
 */
export const TWO_FACTOR_REFUSAL: Record<TwoFactorRefusal, FlashCode> = {
  rate_limited: "rate_limited",
  no_pending: "two_factor_no_pending",
  already_enabled: "two_factor_already_enabled",
  not_enabled: "two_factor_not_enabled",
  wrong_code: "two_factor_wrong_code",
  wrong_password: "two_factor_wrong_password",
  sso_link_requires_second_factor: "two_factor_sso_link",
};

/** Redirects to the Two-factor page with a flash banner (and a reveal token). */
export function toTwoFactorPage(
  set: Context["set"],
  code: FlashCode,
  reveal?: string,
): string {
  const location = flashUrl(TWO_FACTOR_PAGE, code);
  return redirect(set, `${location}${reveal === undefined ? "" : `&reveal=${reveal}`}`);
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
