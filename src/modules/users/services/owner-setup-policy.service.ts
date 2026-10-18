/**
 * Rules for the owner setup link (#215): how long it lives, what a
 * well-formed token looks like, the password policy, and how the link is
 * built. The database side lives in `owner.service.ts`.
 *
 * Pure: no I/O, no config, so it unit-tests without mocks.
 */

/**
 * Lifetime of an owner setup link: 24 hours. A code constant, not an env
 * var: long enough for an operator who does not watch the logs right after
 * a deploy, and a restart (or `reset-owner`) mints a fresh link anyway.
 */
export const OWNER_SETUP_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Shortest owner password accepted. 15 characters is the NIST SP 800-63B-4
 * minimum for a password used as the only factor, which is the owner's
 * situation until 2FA ships (#220).
 */
export const SETUP_PASSWORD_MIN_LENGTH = 15;

/** Longest owner password accepted: caps the input fed to argon2id. */
export const SETUP_PASSWORD_MAX_LENGTH = 256;

/**
 * A setup token is what `mintToken()` produces: 32 random bytes as
 * base64url without padding, which is always exactly 43 characters.
 */
const SETUP_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Expiry of a setup token minted at `now`. */
export function setupTokenExpiry(now: Date): Date {
  return new Date(now.getTime() + OWNER_SETUP_TTL_MS);
}

/**
 * True when `token` has the shape of a minted setup token. Checked before
 * any database call, so a malformed value from the URL or the form never
 * costs a query.
 */
export function isWellFormedSetupToken(token: string): boolean {
  return SETUP_TOKEN_RE.test(token);
}

/**
 * Why the submitted owner password is not acceptable, or `null` if it is.
 * Lengths count characters (code points), not UTF-16 units, so a password
 * of 15 non-ASCII characters is not rejected as short. The message is
 * shown on the setup form, so it never echoes the input.
 */
export function setupPasswordProblem(password: string, confirm: string): string | null {
  const length = Array.from(password).length;
  if (length < SETUP_PASSWORD_MIN_LENGTH) {
    return `The password must be at least ${SETUP_PASSWORD_MIN_LENGTH} characters long.`;
  }
  if (length > SETUP_PASSWORD_MAX_LENGTH) {
    return `The password must be at most ${SETUP_PASSWORD_MAX_LENGTH} characters long.`;
  }
  if (password !== confirm) {
    return "The two passwords do not match.";
  }
  return null;
}

/**
 * Builds the absolute setup link for `token`.
 *
 * Uses `appBaseUrl` (`APP_BASE_URL`) when it is an `http://` or `https://`
 * URL. Anything else, including an empty value or a `javascript:` URL,
 * falls back to `http://localhost:PORT`, which the operator can still open
 * through an SSH tunnel; `usedFallback` lets the caller add a hint to set
 * `APP_BASE_URL`.
 */
export function buildSetupUrl(
  appBaseUrl: string,
  port: number,
  token: string,
): { url: string; usedFallback: boolean } {
  const path = `/dashboard/setup?token=${encodeURIComponent(token)}`;
  const base = appBaseUrl.trim().replace(/\/+$/, "");
  if (/^https?:\/\/[^/]/i.test(base)) {
    return { url: `${base}${path}`, usedFallback: false };
  }
  return { url: `http://localhost:${port}${path}`, usedFallback: true };
}
