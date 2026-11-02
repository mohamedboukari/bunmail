import { logger } from "../utils/logger.ts";
import { sharedWindowCounter, type WindowTicket } from "../utils/shared-store.ts";
import { embeddedIpv4, parseIpv6 } from "../utils/ssrf-guard.ts";

/**
 * Per-IP brute-force protection for the dashboard login form (#109).
 *
 * The dashboard signs in with an account email and password (#216), and a
 * successful login grants read/write across every tenant's mail. Without
 * a throttle, an attacker can guess passwords at full request speed. This
 * module counts *failed* logins per client IP in a fixed window (every
 * kind of failure: unknown email, no password, disabled account, wrong
 * password, over-long input: the login counts each attempt before the
 * password check, and a success gives back only its own, #256) and lets the login handler reject further
 * attempts with HTTP 429 once the limit is hit. The limit runs before any
 * database or argon2id work. Throttling is per IP only; there is no
 * per-account lockout, which would let anyone lock the owner out.
 *
 * Config-free by design: thresholds are passed in by the caller (the
 * pages plugin reads them from `config`). Keeping `config` out of this
 * module lets the unit test import it with no environment and no
 * `mock.module`: `config.ts` throws at import time and Bun's
 * `mock.module` leaks across test files.
 *
 * Fixed windows like the HTTP per-API-key limiter
 * (`src/middleware/rate-limit.ts`), in the shared store (#185): Redis
 * when `REDIS_URL` is set, so every replica counts against one budget;
 * else process memory, reset by a restart (one replica).
 */

/* ─── Client IP resolution ─── */

/**
 * Resolves the real client IP, honouring a configured number of trusted
 * reverse-proxy hops.
 *
 * Security: the leftmost `X-Forwarded-For` entry is attacker-controlled
 * and must never be used for rate limiting: a direct request can carry a
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
 * requests with no underlying socket): such requests share one bucket,
 * which is acceptable.
 *
 * @param opts.socketIp          The raw transport peer address, if known.
 * @param opts.forwardedFor      The raw `X-Forwarded-For` header, or null.
 * @param opts.trustedProxyHops  Number of trusted proxy hops in front.
 * @param opts.now               Current time (ms), for the bypass warning.
 */
export function resolveClientIp(opts: {
  socketIp?: string;
  forwardedFor: string | null;
  trustedProxyHops: number;
  now?: number;
}): string {
  const { socketIp, forwardedFor, trustedProxyHops, now = Date.now() } = opts;

  /** No trusted proxy: the socket address is the only trustworthy source. */
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
   * proxies: don't trust it; fall back to the socket address.
   */
  if (chain.length >= trustedProxyHops) {
    return chain[chain.length - trustedProxyHops] ?? socketIp ?? "unknown";
  }

  warnUnproxiedRequest(socketIp, chain.length, trustedProxyHops, now);
  return socketIp ?? "unknown";
}

/** How often the unproxied-request warning may repeat. */
const PROXY_WARNING_INTERVAL_MS = 60 * 60 * 1000;

/** When the unproxied-request warning was last logged (ms), 0 for never. */
let lastProxyWarningAt = 0;

/**
 * Warns, at most once an hour, that a request reached BunMail with fewer
 * `X-Forwarded-For` entries than `DASHBOARD_TRUSTED_PROXY_HOPS` (#256): it
 * did not come through the expected proxies, so BunMail is reachable
 * directly, and a direct client can then forge the header to get a fresh
 * throttle bucket per request. Bind the app port to loopback or firewall
 * it so only the proxy reaches it.
 */
function warnUnproxiedRequest(
  socketIp: string | undefined,
  forwardedEntries: number,
  trustedProxyHops: number,
  now: number,
): void {
  if (now - lastProxyWarningAt < PROXY_WARNING_INTERVAL_MS) return;
  lastProxyWarningAt = now;
  logger.warn(
    "Request bypassed the trusted proxy: BunMail is reachable directly, so X-Forwarded-For can be forged",
    { socketIp: socketIp ?? null, forwardedEntries, trustedProxyHops },
  );
}

/* ─── Throttle buckets ─── */

/**
 * The bucket a client address is counted in (#256). An IPv6 client
 * usually controls a whole /64 and can rotate through its addresses, so
 * IPv6 clients are counted per /64; an IPv6 form that carries an IPv4
 * address (`::ffff:192.0.2.1`) counts as that IPv4. Anything else (IPv4,
 * `unknown`, a prefixed key such as `transfer:user:...`) is its own bucket.
 */
export function rateLimitBucket(ip: string): string {
  if (!ip.includes(":")) return ip;
  const groups = parseIpv6(ip);
  if (groups === null) return ip;
  const ipv4 = embeddedIpv4(groups);
  if (ipv4 !== null) return ipv4;
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}

/* ─── Per-IP failed-attempt tracking ─── */

/**
 * Failed-attempt counters per key (client IP bucket, or a prefixed key
 * such as `transfer:user:<id>`), in fixed windows (#185): in Redis when
 * `REDIS_URL` is set, so N replicas allow one budget, not N; else (and
 * while Redis is down) in this process's memory.
 */
const loginCounter = sharedWindowCounter("rl:login");

/**
 * The in-memory counters, keyed by bucket: the whole state without Redis.
 * Exported for tests (assert/reset between cases); the running server
 * goes through the helpers below.
 */
export const loginAttemptMap = loginCounter.local.entries;

/** Outcome of a lockout check: `retryAfterSec` is 0 when not limited. */
export interface LoginLimitDecision {
  limited: boolean;
  retryAfterSec: number;
}

/**
 * Outcome of {@link takeLoginAttempt}: the decision, and the windows the
 * attempt was counted in, for {@link refundLoginAttempt}.
 */
export interface LoginAttemptDecision extends LoginLimitDecision {
  ticket: WindowTicket;
}

/** Whole seconds until a window ends, rounded up. */
function toSeconds(ms: number): number {
  return Math.ceil(ms / 1000);
}

/**
 * Checks whether a key is currently locked out, without counting
 * anything: `maxAttempts` attempts in its window. For the checks made
 * after an attempt was counted (is this budget spent now?); to check
 * before an attempt, use {@link takeLoginAttempt}, which also counts it.
 */
export async function isLoginRateLimited(
  ip: string,
  maxAttempts: number,
): Promise<LoginLimitDecision> {
  const window = await loginCounter.peek(rateLimitBucket(ip));
  if (!window || window.count < maxAttempts) return { limited: false, retryAfterSec: 0 };
  return { limited: true, retryAfterSec: toSeconds(window.resetInMs) };
}

/**
 * Counts one attempt against every key, or refuses it when any key
 * already holds `maxAttempts` in its window (then nothing is counted).
 * One atomic step, before any password work: a parallel burst, on one
 * replica or several, cannot pass the limit between a check and a count.
 * A key without a live window starts one of `windowMs`.
 */
export async function takeLoginAttempt(
  ips: readonly string[],
  maxAttempts: number,
  windowMs: number,
): Promise<LoginAttemptDecision> {
  const decision = await loginCounter.take(ips.map(rateLimitBucket), {
    max: maxAttempts,
    windowMs,
  });
  return decision.limited
    ? {
        limited: true,
        retryAfterSec: toSeconds(decision.retryAfterMs),
        ticket: decision.windows,
      }
    : { limited: false, retryAfterSec: 0, ticket: decision.windows };
}

/**
 * True the first time it is asked during a key's current window, false
 * afterwards (#221): the login records a rate-limited attempt in the
 * audit log once per key and window, so a flood cannot fill the table.
 * False when the key has no live window.
 */
export function shouldAuditLockout(ip: string): Promise<boolean> {
  return loginCounter.markOnce(rateLimitBucket(ip));
}

/**
 * Counts one failed attempt for a key, whatever its count: starts a
 * window of `windowMs` on the first one. For tests and for counting
 * without a check; the routes use {@link takeLoginAttempt}.
 */
export async function recordFailedLogin(ip: string, windowMs: number): Promise<void> {
  await loginCounter.take([rateLimitBucket(ip)], {
    max: Number.MAX_SAFE_INTEGER,
    windowMs,
  });
}

/**
 * Gives back the one attempt a successful login counted for itself (the
 * login counts every attempt before the password check). Earlier failures
 * stay until their window expires (#256): clearing them on success let
 * anyone with an account of their own sign in between guesses at another
 * account's password and keep guessing from the same address forever.
 * `ticket` is the take's: the refund goes only into the window that take
 * counted in, never into a later one (a login that straddles the end of
 * a window must not give back a failure of the next).
 */
export function refundLoginAttempt(ip: string, ticket: WindowTicket): Promise<void> {
  const bucket = rateLimitBucket(ip);
  const windowId = ticket.get(bucket);
  return windowId === undefined
    ? Promise.resolve()
    : loginCounter.refund(bucket, windowId);
}

/**
 * Clears keys' failed-attempt records. Used by the ownership transfer
 * check (#218) and the other budgets whose success cannot be repeated;
 * the login refunds its own attempt instead (see {@link refundLoginAttempt}).
 */
export function clearLoginAttempts(ips: readonly string[]): Promise<void> {
  return loginCounter.delete(ips.map(rateLimitBucket));
}

/* ─── Periodic cleanup ─── */

/** How often the cleanup loop sweeps expired entries from the map. */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** Reference to the periodic cleanup timer; null when not running. */
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Removes in-memory entries whose window has ended. Without this, distinct
 * attacker IPs arriving over a long lifetime would grow the map unbounded
 * (Redis expires its keys on its own). Exported for unit testing: the
 * running server uses the interval below.
 */
export function pruneExpiredLoginAttempts(): number {
  return loginCounter.local.prune();
}

/**
 * Starts a periodic sweep that drops expired entries from the in-memory
 * login-attempt map (the default store, and the fallback while Redis is
 * down). Idempotent: calling twice is a no-op while the interval is
 * running. Mirrors `startRateLimitCleanup` in `rate-limit.ts`.
 */
export function startLoginRateLimitCleanup(): void {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => pruneExpiredLoginAttempts(), CLEANUP_INTERVAL_MS);
  logger.debug("Dashboard login rate-limit cleanup started", {
    intervalMs: CLEANUP_INTERVAL_MS,
  });
}

/** Stops the periodic sweep: called from the graceful shutdown handler. */
export function stopLoginRateLimitCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    logger.debug("Dashboard login rate-limit cleanup stopped");
  }
}
