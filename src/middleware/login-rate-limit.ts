import { logger } from "../utils/logger.ts";

/**
 * Per-IP brute-force protection for the dashboard login form (#109).
 *
 * The dashboard authenticates with a single shared `DASHBOARD_PASSWORD`
 * (no username) and a successful login grants unscoped read/write across
 * every tenant's mail. Without a throttle, an attacker can guess the
 * password at full request speed. This module counts *failed* login
 * attempts per client IP in a sliding window and lets the login handler
 * reject further attempts with HTTP 429 once the limit is hit.
 *
 * Config-free by design: thresholds are passed in by the caller (the
 * pages plugin reads them from `config`). Keeping `config` out of this
 * module lets the unit test import it with no environment and no
 * `mock.module` — `config.ts` throws at import time and Bun's
 * `mock.module` leaks across test files.
 *
 * Mirrors the in-memory sliding-window pattern used by the SMTP receiver
 * (`src/modules/inbound/services/smtp-receiver.service.ts`) and the HTTP
 * per-API-key limiter (`src/middleware/rate-limit.ts`). State is
 * in-memory and resets on restart — acceptable for the single-instance
 * default; multi-replica deployments would each keep their own counters.
 */

/* ─── Client IP resolution ─── */

/**
 * Resolves the real client IP, honouring a configured number of trusted
 * reverse-proxy hops.
 *
 * Security: the leftmost `X-Forwarded-For` entry is attacker-controlled
 * and must never be used for rate limiting — a direct request can carry a
 * forged `X-Forwarded-For: 1.2.3.4`. The robust approach (MDN / OWASP) is
 * to count from the right: with `N` trusted proxy hops in front of
 * BunMail, the real client is the `N`-th entry from the right of the
 * header (the rightmost for a single proxy), because each trusted proxy
 * appends the address it received the connection from.
 *
 * - `trustedProxyHops <= 0` → don't trust the header at all; use the raw
 *   socket address. Correct (and spoof-proof) when BunMail is directly
 *   reachable or you don't run a proxy.
 * - `trustedProxyHops >= 1` → take the `N`-th `X-Forwarded-For` entry from
 *   the right. If the header is missing or has fewer than `N` entries
 *   (a direct hit or a misconfigured hop count), fall back to the socket
 *   address rather than trusting a partial/forged header.
 *
 * Returns `"unknown"` when no address is available at all (e.g. unit/e2e
 * requests with no underlying socket) — such requests share one bucket,
 * which is acceptable.
 *
 * @param opts.socketIp          The raw transport peer address, if known.
 * @param opts.forwardedFor      The raw `X-Forwarded-For` header, or null.
 * @param opts.trustedProxyHops  Number of trusted proxy hops in front.
 */
export function resolveClientIp(opts: {
  socketIp?: string;
  forwardedFor: string | null;
  trustedProxyHops: number;
}): string {
  const { socketIp, forwardedFor, trustedProxyHops } = opts;

  /** No trusted proxy — the socket address is the only trustworthy source. */
  if (trustedProxyHops <= 0) {
    return socketIp ?? "unknown";
  }

  /** Parse the header into a clean list of addresses (left → right). */
  const chain = (forwardedFor ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  /**
   * Take the `N`-th entry from the right. If the chain is shorter than the
   * configured hop count, the header didn't pass through the expected
   * proxies — don't trust it; fall back to the socket address.
   */
  if (chain.length >= trustedProxyHops) {
    return chain[chain.length - trustedProxyHops] ?? socketIp ?? "unknown";
  }

  return socketIp ?? "unknown";
}

/* ─── Per-IP failed-attempt tracking ─── */

/** Tracks failed-login count and window start per client IP. */
interface LoginAttemptEntry {
  /** Number of failed attempts in the current window */
  count: number;
  /** Timestamp (ms) when the current window started */
  windowStart: number;
}

/**
 * In-memory map of client IP → failed-attempt state. Exported for unit
 * testing (assert/reset between cases) — the running server mutates it via
 * the helpers below.
 */
export const loginAttemptMap = new Map<string, LoginAttemptEntry>();

/**
 * Checks whether an IP is currently locked out. Pure read — does NOT
 * mutate the map, so the caller can decide to reject before validating the
 * password. The lockout clears automatically once the window expires.
 *
 * @returns `limited` true once `maxAttempts` failures have accumulated in
 *   the window, with `retryAfterSec` = whole seconds until the window ends.
 */
export function isLoginRateLimited(
  ip: string,
  maxAttempts: number,
  windowMs: number,
  now: number = Date.now(),
): { limited: boolean; retryAfterSec: number } {
  const entry = loginAttemptMap.get(ip);

  /** No record, or the window has fully expired — not limited. */
  if (!entry || now - entry.windowStart >= windowMs) {
    return { limited: false, retryAfterSec: 0 };
  }

  if (entry.count >= maxAttempts) {
    const retryAfterSec = Math.ceil((entry.windowStart + windowMs - now) / 1000);
    return { limited: true, retryAfterSec };
  }

  return { limited: false, retryAfterSec: 0 };
}

/**
 * Records one failed login attempt for an IP. Starts a fresh window on the
 * first failure (or after the previous window expired); otherwise
 * increments the counter within the current window.
 */
export function recordFailedLogin(
  ip: string,
  windowMs: number,
  now: number = Date.now(),
): void {
  const entry = loginAttemptMap.get(ip);

  if (!entry || now - entry.windowStart >= windowMs) {
    loginAttemptMap.set(ip, { count: 1, windowStart: now });
    return;
  }

  entry.count += 1;
}

/**
 * Clears an IP's failed-attempt record. Called on a successful login so a
 * legitimate operator who eventually types the right password isn't held
 * under the previous failures.
 */
export function clearLoginAttempts(ip: string): void {
  loginAttemptMap.delete(ip);
}

/* ─── Periodic cleanup ─── */

/** How often the cleanup loop sweeps expired entries from the map. */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** Reference to the periodic cleanup timer; null when not running. */
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Removes entries whose window has fully expired. Without this, distinct
 * attacker IPs arriving over a long lifetime would grow the map unbounded.
 * Exported for unit testing — the running server uses the interval below.
 */
export function pruneExpiredLoginAttempts(
  windowMs: number,
  now: number = Date.now(),
): number {
  let removed = 0;
  for (const [ip, entry] of loginAttemptMap) {
    if (now - entry.windowStart >= windowMs) {
      loginAttemptMap.delete(ip);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Starts a periodic sweep that drops expired entries from the in-memory
 * login-attempt map. Idempotent — calling twice is a no-op while the
 * interval is running. Mirrors `startRateLimitCleanup` in `rate-limit.ts`.
 *
 * @param windowMs The configured failure window, in milliseconds.
 */
export function startLoginRateLimitCleanup(windowMs: number): void {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(
    () => pruneExpiredLoginAttempts(windowMs),
    CLEANUP_INTERVAL_MS,
  );
  logger.debug("Dashboard login rate-limit cleanup started", {
    intervalMs: CLEANUP_INTERVAL_MS,
  });
}

/** Stops the periodic sweep — called from the graceful shutdown handler. */
export function stopLoginRateLimitCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    logger.debug("Dashboard login rate-limit cleanup stopped");
  }
}
