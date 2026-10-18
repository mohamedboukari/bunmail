/**
 * Dashboard session cookie helpers (#216).
 *
 * The cookie only carries the opaque session token; the session itself
 * lives in the `sessions` table (`src/modules/users/services/session.service.ts`).
 * These helpers read the cookie from a request and build the `Set-Cookie`
 * values, nothing more.
 *
 * Pure: `secure` and the lifetime are passed in, so this unit-tests
 * without config or mocks (#174).
 */

/** Name of the dashboard session cookie. */
export const SESSION_COOKIE = "bm_session";

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
 * Reads the session cookie from a `Cookie` header. The name must match
 * exactly (`xbm_session=` is a different cookie), and an empty value counts
 * as missing. With several `bm_session` entries the first wins, which is
 * the one with the most specific path.
 *
 * @returns the raw cookie value, or `undefined` when there is none.
 */
export function readSessionCookie(cookieHeader: string | null): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return value === "" ? undefined : value;
  }
  return undefined;
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
