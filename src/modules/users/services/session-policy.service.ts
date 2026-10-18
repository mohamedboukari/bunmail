import { isIP } from "net";
import { MAX_ADDRESS_LENGTH } from "../../../utils/recipients.ts";
import { SETUP_PASSWORD_MAX_LENGTH } from "./owner-setup-policy.service.ts";

/**
 * Rules for dashboard sessions and the login form (#216): lifetimes, the
 * rotation schedule, input bounds, and how request metadata is cleaned up
 * before it is stored. The database side lives in `session.service.ts`
 * and `login.service.ts`.
 *
 * Pure: no I/O, no config, so it unit-tests without mocks. Every lifetime
 * is a code constant, not an env var: fewer knobs to get wrong, and no new
 * field in the many config stubs the tests carry.
 */

/**
 * Idle timeout: a session unused for 24 hours expires. Each rotation
 * slides `expires_at` forward, so an active operator stays signed in.
 */
export const SESSION_IDLE_SECONDS = 24 * 60 * 60;

/**
 * Absolute cap: no session lives longer than 7 days from login, however
 * active it is. Bounds what a stolen cookie that keeps being used is
 * worth. Also the cookie `Max-Age` at login.
 */
export const SESSION_ABSOLUTE_SECONDS = 7 * 24 * 60 * 60;

/**
 * Token rotation: a request on a session whose token is older than this
 * gets a fresh token in its response. The rotation write is also the
 * sliding refresh of `last_seen_at` and `expires_at`, so a session costs
 * at most one UPDATE per minute.
 */
export const SESSION_ROTATE_SECONDS = 60;

/**
 * How long the token replaced by a rotation keeps working. Requests the
 * browser had already sent with the old cookie (parallel tabs, a page and
 * its form post) arrive after the rotation; they are accepted for this
 * long. After it, the previous token is treated as stolen and every
 * session of the user is revoked (reuse detection).
 */
export const SESSION_ROTATION_GRACE_SECONDS = 30;

/**
 * Lifetime of a `pending` session (#220): the password step passed and
 * the second factor is still to come. Short, and never extended: it can
 * open only the two-factor login page, and a sign-in left half done
 * expires on its own. The cookie `Max-Age` is the same.
 */
export const SESSION_PENDING_SECONDS = 10 * 60;

/** Longest email the login form accepts: the RFC 5321 path limit. */
export const LOGIN_EMAIL_MAX_LENGTH = MAX_ADDRESS_LENGTH;

/**
 * Longest password the login form accepts, in characters (code points).
 * The same cap as owner setup, so every stored password can be typed in,
 * and it bounds the input fed to argon2id.
 */
export const LOGIN_PASSWORD_MAX_LENGTH = SETUP_PASSWORD_MAX_LENGTH;

/** `sessions.user_agent` is `varchar(255)`. */
const USER_AGENT_MAX_LENGTH = 255;

/**
 * Normalizes an email the way `users.email` stores it: trimmed and
 * lower-cased (the column has a lower-case check).
 */
export function normalizeLoginEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * True when a login submission is over the input bounds. The handler
 * fails such a request without any database or argon2id work; that does
 * not depend on any account, so it reveals nothing. Password length counts
 * code points, like the setup policy.
 */
export function loginInputTooLong(email: string, password: string): boolean {
  return (
    email.length > LOGIN_EMAIL_MAX_LENGTH ||
    Array.from(password).length > LOGIN_PASSWORD_MAX_LENGTH
  );
}

/**
 * The client address to store with a session, or `null`. The resolved
 * client IP can be `"unknown"` (no socket) or an unchecked
 * `X-Forwarded-For` entry; only a real IPv4 or IPv6 literal is kept, which
 * also guarantees it fits `sessions.ip` (`varchar(45)`), so a forged header
 * can never turn a valid login into a database error.
 */
export function sessionIp(ip: string | null | undefined): string | null {
  if (!ip || ip.length > 45) return null;
  return isIP(ip) === 0 ? null : ip;
}

/**
 * The user agent to store with a session, cut to the column width
 * (Postgres counts characters, so this counts code points and never
 * splits a surrogate pair), or `null` when the request carried none.
 */
export function clampUserAgent(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  return Array.from(userAgent).slice(0, USER_AGENT_MAX_LENGTH).join("");
}
