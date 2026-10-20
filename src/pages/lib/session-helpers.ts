import type { Context } from "elysia";
import { config } from "../../config.ts";
import { logger } from "../../utils/logger.ts";
import {
  clearSessionCookie,
  deviceSetCookie,
  sessionSetCookie,
  webAuthnSetCookie,
} from "../session.ts";
import * as sessionService from "../../modules/users/services/session.service.ts";
import { SESSION_ABSOLUTE_SECONDS } from "../../modules/users/services/session-policy.service.ts";
import { DEVICE_COOKIE_MAX_AGE_SECONDS } from "../../modules/users/services/device-policy.service.ts";
import { recordAuditEvent } from "../../modules/audit/services/audit.service.ts";

/* ─── Session Helpers ─── */

/**
 * `Secure` on the session cookie in production (#133), so it is never
 * sent over plaintext HTTP. Not in development, which runs over
 * `http://localhost` without TLS.
 */
function secureCookies(): boolean {
  return config.env === "production";
}

/**
 * Puts a session token in the `bm_session` cookie (#216): HttpOnly,
 * SameSite=Lax, Secure in production, Path=/dashboard. At login the
 * lifetime is the absolute cap; on rotation it is what is left of it. The
 * server enforces the idle timeout itself, so the cookie never needs
 * refreshing just to stay alive.
 */
export function issueSession(
  set: Context["set"],
  token: string,
  maxAgeSec: number = SESSION_ABSOLUTE_SECONDS,
): void {
  set.headers["set-cookie"] = sessionSetCookie(token, secureCookies(), maxAgeSec);
}

/**
 * Adds the `bm_device` cookie (#282) next to whatever `Set-Cookie` the
 * response already carries (the login sets `bm_session` first): same
 * attributes as the session cookie, `Max-Age` 400 days, refreshed at
 * every password sign-in.
 */
export function issueDeviceCookie(set: Context["set"], value: string): void {
  appendSetCookie(
    set,
    deviceSetCookie(value, secureCookies(), DEVICE_COOKIE_MAX_AGE_SECONDS),
  );
}

/** Adds one `Set-Cookie` next to whatever the response already carries. */
function appendSetCookie(set: Context["set"], cookie: string): void {
  const current = set.headers["set-cookie"];
  if (current === undefined) {
    set.headers["set-cookie"] = cookie;
  } else {
    set.headers["set-cookie"] = [
      ...(Array.isArray(current) ? current : [current]),
      cookie,
    ];
  }
}

/**
 * Sets the `bm_wa` cookie (#223) that binds a passwordless passkey
 * challenge to this browser, for `maxAgeSec` (the challenge's lifetime).
 * Appended, so a session cookie set on the same response stays.
 */
export function issueWebAuthnCookie(
  set: Context["set"],
  value: string,
  maxAgeSec: number,
): void {
  appendSetCookie(set, webAuthnSetCookie(value, secureCookies(), maxAgeSec));
}

/** Removes the `bm_wa` cookie (#223): its challenge is spent. Appended. */
export function clearWebAuthnCookie(set: Context["set"]): void {
  appendSetCookie(set, webAuthnSetCookie("", secureCookies(), 0));
}

/** Removes the `bm_session` cookie from the browser (same attributes, Max-Age=0). */
export function clearSession(set: Context["set"]): void {
  set.headers["set-cookie"] = clearSessionCookie(secureCookies());
}

/** The message a browser sees when the session store cannot be reached. */
export const SESSION_STORE_DOWN = "Dashboard temporarily unavailable";

/**
 * Token reuse (#216): a token the session already rotated away from was
 * presented, so two parties hold copies of the cookie. Every session of
 * the user is revoked (the thief's and the victim's), and the event is
 * logged and written to the audit log (#221, by BunMail itself, with the
 * address that presented the old token); the caller then clears the
 * cookie. Throws when the revoke fails, so callers can fail closed.
 */
export async function revokeOnTokenReuse(
  owner: { userId: string; sessionId: string },
  ip: string,
  userAgent: string | null,
): Promise<void> {
  await sessionService.revokeAllUserSessions(owner.userId);
  logger.warn("Session token reuse detected: all sessions of the user revoked", {
    userId: owner.userId,
    sessionId: owner.sessionId,
    ip,
  });
  await recordAuditEvent({
    action: "auth.session.token_reuse_detected",
    outcome: "failure",
    actor: { type: "system", label: "session guard" },
    ip,
    userAgent,
    target: { type: "user", id: owner.userId },
  });
}
