import type { Context } from "elysia";
import { config } from "../../config.ts";
import { logger } from "../../utils/logger.ts";
import { resolveClientIp } from "../../middleware/login-rate-limit.ts";
import { recordAuditEvent } from "../../modules/audit/services/audit.service.ts";
import type { AuditActor } from "../../modules/audit/types/audit.types.ts";
import type { PendingSession } from "../../modules/users/types/user.types.ts";
import * as sessionService from "../../modules/users/services/session.service.ts";
import * as sessionLocation from "../../modules/users/services/session-location.service.ts";
import * as signInDevice from "../../modules/users/services/sign-in-device.service.ts";
import { sendTwoFactorAlert } from "../../modules/users/services/two-factor-alert.service.ts";
import { sessionIp } from "../../modules/users/services/session-policy.service.ts";
import {
  isWellFormedToken,
  mintToken,
} from "../../modules/users/services/token.service.ts";
import * as twoFactorService from "../../modules/users/services/two-factor.service.ts";
import { relyingPartyFrom } from "../../modules/users/services/passkey-policy.service.ts";
import { LoginTwoFactorPage } from "../routes/login-two-factor.tsx";
import { readDeviceCookie } from "../session.ts";
import { clearSession, issueDeviceCookie } from "./session-helpers.ts";
import { redirect } from "./responses.ts";
import {
  shouldAlertCodesExhausted,
  type TwoFactorLimiter,
} from "./two-factor-limiter.ts";

/**
 * What the public sign-in routes share (#216, #220, #223): the password
 * login and its TOTP step (`auth.plugin.tsx`) and the passkey sign-ins
 * (`passkeys.plugin.tsx`).
 */

/**
 * The second login step's page for an account (#220, #223): the code form
 * when it has TOTP, the "Use a passkey" button when it has a passkey and
 * passkeys are on (`APP_BASE_URL` set). An account with a passkey but
 * passkeys switched off sees the code form only, or a note.
 */
export async function secondStepPage(
  userId: string,
  error?: string,
): Promise<JSX.Element> {
  const factors = await twoFactorService.secondFactorsOf(userId);
  const passkeysOn = relyingPartyFrom(config.appBaseUrl) !== null;
  return (
    <LoginTwoFactorPage
      error={error}
      totp={factors.totp}
      passkey={factors.passkeys > 0 && passkeysOn}
    />
  );
}

/**
 * Leak hardening for the sign-in and one-time-link pages (#215): never
 * cached (`no-store`), not MIME-sniffed, and not frameable (no
 * clickjacking of the form).
 *
 * `Referrer-Policy: strict-origin` keeps a token URL out of every
 * `Referer` (our own access logs record Referer too): requests carry the
 * origin only. It must NOT be `no-referrer`: under that policy browsers
 * send `Origin: null` on the form POST (Fetch spec, "append a request
 * Origin header"), so `isSameOrigin` would reject every real submission
 * with 403.
 */
export function setAuthPageHeaders(set: Context["set"]): void {
  set.headers["cache-control"] = "no-store";
  set.headers["referrer-policy"] = "strict-origin";
  set.headers["x-content-type-options"] = "nosniff";
  set.headers["x-frame-options"] = "DENY";
}

/** The client IP of a request (the login limiter's resolution). */
export function requestIp(request: Request, socketIp: string | undefined): string {
  return resolveClientIp({
    socketIp,
    forwardedFor: request.headers.get("x-forwarded-for"),
    trustedProxyHops: config.dashboard.trustedProxyHops,
  });
}

/**
 * The actor of a sign-in attempt that matched no account (#221): no id,
 * no label. The typed address (or the presented passkey id) is never
 * stored.
 */
export const UNKNOWN_ACCOUNT: AuditActor = { type: "user", id: null, label: null };

/** A dashboard user, by id: the audit log reads the email from the row. */
export function userActor(userId: string): AuditActor {
  return { type: "user", id: userId };
}

/**
 * What runs once a sign-in is complete (#281, #282): after the password
 * for an account without a second factor, after the second factor (#220:
 * a code; #223: a passkey) for one with it, and after a passwordless
 * passkey sign-in (#223). The approximate location is looked up and the
 * new-device check runs, both in the background (never awaited: they
 * never delay or fail a login); the browser keeps its `bm_device` cookie
 * when it presents a well-formed one, else it gets a new one (a malformed
 * or oversized value counts as absent), and the cookie is set again
 * either way, which refreshes its lifetime. Call after `issueSession`:
 * the device cookie is appended to the session cookie.
 */
export function completeSignIn(
  set: Context["set"],
  request: Request,
  signIn: { userId: string; email: string; sessionId: string; ip: string },
): void {
  /** The new-device check waits on it for at most 2 s. */
  const located = sessionLocation.locateSession(signIn.sessionId, sessionIp(signIn.ip));
  const presentedDevice = readDeviceCookie(request.headers.get("cookie"));
  const deviceToken =
    presentedDevice && isWellFormedToken(presentedDevice)
      ? presentedDevice
      : mintToken().token;
  void signInDevice.recognizeSignInDevice({
    userId: signIn.userId,
    email: signIn.email,
    deviceToken,
    ip: sessionIp(signIn.ip),
    userAgent: request.headers.get("user-agent"),
    location: located,
    at: new Date(),
  });
  issueDeviceCookie(set, deviceToken);
}

/**
 * Ends a second login step whose budget is spent (#220; a failed passkey
 * counts against the same budget, #223): the pending session is revoked,
 * so a retry needs the password again; the lock is logged and recorded
 * once per pending session; when the account's own budget ran out (the
 * password was right and the second factor kept failing, a likely
 * password compromise) the account is emailed, at most once per window.
 * Returns the redirect to the login page.
 */
export async function endLockedSecondStep(
  set: Context["set"],
  request: Request,
  input: {
    token: string;
    pending: PendingSession;
    ip: string;
    limiter: TwoFactorLimiter;
  },
): Promise<string> {
  const { token, pending, ip, limiter } = input;
  await sessionService.revokeSessionByToken(token);
  logger.warn("Two-factor sign-in blocked: too many attempts, pending session revoked", {
    userId: pending.userId,
    sessionId: pending.sessionId,
    ip,
  });
  await recordAuditEvent({
    action: "auth.login.two_factor_locked",
    outcome: "failure",
    actor: userActor(pending.userId),
    ip,
    userAgent: request.headers.get("user-agent"),
    target: { type: "session", id: pending.sessionId, label: null },
  });
  if (limiter.ownKeyLimited() && shouldAlertCodesExhausted(pending.userId)) {
    void sendTwoFactorAlert({
      event: "login_codes_exhausted",
      userId: pending.userId,
      email: pending.email,
      ip: sessionIp(ip),
    });
  }
  clearSession(set);
  return redirect(set, "/dashboard/login?error=two_factor_locked");
}
