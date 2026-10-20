/**
 * Dashboard session cookie helpers (#216).
 *
 * The cookie only carries the opaque session token; the session itself
 * lives in the `sessions` table (`src/modules/users/services/session.service.ts`).
 * These helpers read the cookie from a request and build the `Set-Cookie`
 * values, nothing more. The device cookie of the new-device alert (#282)
 * lives here too.
 *
 * Pure: `secure` and the lifetime are passed in, so this unit-tests
 * without config or mocks (#174).
 */

/** Name of the dashboard session cookie. */
export const SESSION_COOKIE = "bm_session";

/**
 * Name of the device cookie (#282): a long-lived random value that lets
 * the login recognize a browser that signed in before. Not a credential.
 */
export const DEVICE_COOKIE = "bm_device";

/**
 * Name of the passwordless passkey cookie (#223): a short random value
 * binding a sign-in challenge to this browser. Not a credential: it opens
 * nothing by itself, and its challenge is single-use.
 */
export const WEBAUTHN_COOKIE = "bm_wa";

/**
 * Cookie attributes shared by every `Set-Cookie` of the session (#133):
 * `HttpOnly` (no JS access), `SameSite=Lax` (baseline CSRF defense),
 * `Secure` when requested (production: never over plaintext HTTP), and
 * `Path=/dashboard`. The path must stay the same as the pre-#216 cookie, so
 * setting or clearing the cookie overwrites a legacy value in the browser.
 */
function attributes(secure: boolean): string {
  return `HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}; Path=/dashboard`;
}

/**
 * Reads the cookie `name` from a `Cookie` header. The name must match
 * exactly (`xbm_session=` is a different cookie), and an empty value
 * counts as missing. With several entries of the name the first wins,
 * which is the one with the most specific path.
 */
function readCookie(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return value === "" ? undefined : value;
  }
  return undefined;
}

/**
 * Reads the session cookie from a `Cookie` header (see `readCookie`).
 *
 * @returns the raw cookie value, or `undefined` when there is none.
 */
export function readSessionCookie(cookieHeader: string | null): string | undefined {
  return readCookie(cookieHeader, SESSION_COOKIE);
}

/**
 * Reads the device cookie (#282) from a `Cookie` header. The value is
 * returned as sent; the caller checks its shape and treats a malformed
 * one as absent.
 */
export function readDeviceCookie(cookieHeader: string | null): string | undefined {
  return readCookie(cookieHeader, DEVICE_COOKIE);
}

/**
 * `Set-Cookie` value that stores a session token.
 *
 * @param token     - The raw session token (43 base64url characters).
 * @param secure    - Add `Secure` (production).
 * @param maxAgeSec - Cookie lifetime in seconds.
 */
export function sessionSetCookie(
  token: string,
  secure: boolean,
  maxAgeSec: number,
): string {
  return `${SESSION_COOKIE}=${token}; ${attributes(secure)}; Max-Age=${Math.max(0, Math.trunc(maxAgeSec))}`;
}

/** `Set-Cookie` value that removes the session cookie from the browser. */
export function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; ${attributes(secure)}; Max-Age=0`;
}

/**
 * `Set-Cookie` value that stores the device cookie (#282): the session
 * cookie's attributes (`HttpOnly`, `SameSite=Lax`, `Secure` when asked,
 * `Path=/dashboard`) and a long `Max-Age`, refreshed at every sign-in.
 *
 * @param value     - The device id (43 base64url characters).
 * @param secure    - Add `Secure` (production).
 * @param maxAgeSec - Cookie lifetime in seconds.
 */
export function deviceSetCookie(
  value: string,
  secure: boolean,
  maxAgeSec: number,
): string {
  return `${DEVICE_COOKIE}=${value}; ${attributes(secure)}; Max-Age=${Math.max(0, Math.trunc(maxAgeSec))}`;
}

/**
 * Reads the passkey challenge cookie (#223) from a `Cookie` header. The
 * value is returned as sent; the caller checks its shape.
 */
export function readWebAuthnCookie(cookieHeader: string | null): string | undefined {
  return readCookie(cookieHeader, WEBAUTHN_COOKIE);
}

/**
 * `Set-Cookie` value of the passkey challenge cookie (#223): `HttpOnly`,
 * `SameSite=Strict` (only this site's own form post carries it back),
 * `Secure` when asked, `Path=/dashboard`, and as long as the challenge
 * lives.
 *
 * @param value     - The binding (43 base64url characters).
 * @param secure    - Add `Secure` (production).
 * @param maxAgeSec - Cookie lifetime in seconds.
 */
export function webAuthnSetCookie(
  value: string,
  secure: boolean,
  maxAgeSec: number,
): string {
  return `${WEBAUTHN_COOKIE}=${value}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}; Path=/dashboard; Max-Age=${Math.max(0, Math.trunc(maxAgeSec))}`;
}
