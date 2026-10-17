import crypto from "crypto";

/**
 * Dashboard session cookie signing and validation.
 *
 * Pure: the secret and the clock are passed in, so this unit-tests
 * without config or mocks (#174). `pages.plugin.tsx` passes
 * `config.dashboard.sessionSecret`.
 *
 * `crypto.timingSafeEqual` is called through the default import on
 * purpose: tests spy on it to prove the HMAC comparison is constant-time.
 * A named import would bypass the spy.
 */

/** Max session age in seconds (24 hours) */
export const SESSION_MAX_AGE = 86400;

/** HMAC-SHA256 of the timestamp, hex-encoded. */
function sign(timestamp: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(timestamp).digest("hex");
}

/**
 * Creates a signed session cookie value.
 * Format: `<timestamp>.<hmac_hex>` where timestamp is Unix epoch (seconds).
 *
 * @param secret - The session signing secret
 * @param nowMs  - Current time in milliseconds (defaults to Date.now())
 */
export function createSessionCookie(secret: string, nowMs: number = Date.now()): string {
  const timestamp = String(Math.floor(nowMs / 1000));
  return `${timestamp}.${sign(timestamp, secret)}`;
}

/**
 * Validates a session cookie value.
 * Recomputes the HMAC and checks the timestamp is within SESSION_MAX_AGE.
 *
 * @param cookie - The `bm_session` cookie value
 * @param secret - The session signing secret
 * @param nowMs  - Current time in milliseconds (defaults to Date.now())
 * @returns true if the session is valid
 */
export function validateSessionCookie(
  cookie: string,
  secret: string,
  nowMs: number = Date.now(),
): boolean {
  const dotIndex = cookie.indexOf(".");
  if (dotIndex === -1) return false;

  const timestamp = cookie.substring(0, dotIndex);
  const providedHmac = cookie.substring(dotIndex + 1);

  /** Check timestamp is a valid number and within the max age */
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) return false;

  const now = Math.floor(nowMs / 1000);
  if (now - ts > SESSION_MAX_AGE) return false;

  /** Recompute HMAC and compare with timing-safe comparison */
  const expectedHmac = sign(timestamp, secret);

  /** Both must be the same length for timingSafeEqual */
  if (providedHmac.length !== expectedHmac.length) return false;

  return crypto.timingSafeEqual(Buffer.from(providedHmac), Buffer.from(expectedHmac));
}
