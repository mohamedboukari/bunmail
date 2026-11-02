import { rateLimitBucket } from "../../../middleware/login-rate-limit.ts";
import { sharedWindowCounter, type WindowTicket } from "../../../utils/shared-store.ts";

/**
 * Per-IP limits of the SMTP submission server (#120), keyed by the peer
 * address (`session.remoteAddress`, the socket's: a load balancer in
 * front must keep the client's source address) in the login limiter's
 * buckets (#256): an IPv6 client per /64, which it can rotate through, an
 * IPv4-mapped address as its IPv4. Fixed windows that start with a
 * bucket's first counted event:
 *
 * - **Connections** (`SMTP_SUBMISSION_RATE_LIMIT_*`, default 30 per 60 s):
 *   every connection counts; one over the limit gets `421`.
 * - **AUTH attempts** (`SMTP_SUBMISSION_AUTH_RATE_LIMIT_*`, default 10 per
 *   900 s): the password is an API key, so this is the brute-force
 *   throttle. An attempt is counted before the key is checked, in the same
 *   atomic step as the check, and a success or a failed lookup gives its
 *   own count back, into the window it was counted in only: what stays
 *   counted is the failures. Failures expire
 *   only with their window; a success never clears them (#190), or anyone
 *   holding one valid key could reset the count between guesses at others.
 *
 * In the shared store (#185): Redis when `REDIS_URL` is set, so every
 * replica counts against one budget per IP (N replicas do not give N
 * times the guesses); else process memory, one replica. During a Redis
 * outage both fall back to each replica's memory, like every rate limit
 * (see `src/utils/shared-store.ts`).
 *
 * Config-free: the limits are passed in by the caller on every call, so
 * a change to `config` at run time (the tests make some) applies to the
 * next event, and the unit test needs no `config` mock. The AUTH flow
 * itself ({@link throttledAuth}) takes the key lookup as a function, so
 * it runs in the unit test without a database.
 */

/** Connections per IP. */
const connectionCounter = sharedWindowCounter("rl:smtp-submission");

/** AUTH attempts per IP. */
const authCounter = sharedWindowCounter("rl:smtp-auth");

/**
 * The in-memory counters, keyed by bucket: the whole state without Redis.
 * Exported for tests; the server goes through the functions below.
 */
export const submissionConnectionMap = connectionCounter.local.entries;
export const submissionAuthMap = authCounter.local.entries;

/**
 * Counts one connection from `ip`; true when it is over `max` in its
 * window of `windowSec`, and the connection must be refused.
 */
export async function takeSubmissionConnection(
  ip: string,
  max: number,
  windowSec: number,
): Promise<boolean> {
  const decision = await connectionCounter.take([rateLimitBucket(ip)], {
    max,
    windowMs: windowSec * 1000,
  });
  return decision.limited;
}

/** A counted AUTH attempt: its bucket and the window it was counted in. */
interface AuthAttempt {
  bucket: string;
  windows: WindowTicket;
}

/**
 * Counts one AUTH attempt from `ip` before its key is checked, or refuses
 * it (null, nothing counted) when the bucket already holds `maxAttempts`
 * in its window of `windowSec`. Check and count are one step, so a burst
 * of parallel AUTHs, on one replica or several, cannot all pass a check
 * made before any of them failed.
 */
async function takeAuthAttempt(
  ip: string,
  maxAttempts: number,
  windowSec: number,
): Promise<AuthAttempt | null> {
  const bucket = rateLimitBucket(ip);
  const decision = await authCounter.take([bucket], {
    max: maxAttempts,
    windowMs: windowSec * 1000,
  });
  return decision.limited ? null : { bucket, windows: decision.windows };
}

/**
 * Gives back the attempt {@link takeAuthAttempt} counted, for an AUTH
 * that was not a wrong guess: a valid key, or a lookup that failed on our
 * side. Only into the window it was counted in: a slow lookup that ends
 * after that window never gives back a failure of the next one. The
 * bucket's earlier failures stay (#190).
 */
async function refundAuthAttempt(attempt: AuthAttempt | undefined): Promise<void> {
  const windowId = attempt?.windows.get(attempt.bucket);
  if (attempt && windowId !== undefined)
    await authCounter.refund(attempt.bucket, windowId);
}

/** The failed-AUTH throttle settings (`config.smtpSubmission.authRateLimit`). */
export interface AuthRateLimit {
  enabled: boolean;
  maxAttempts: number;
  windowSec: number;
}

/** What one AUTH came to, for the server to answer and log. */
export type AuthOutcome<K> =
  | { status: "rate_limited" }
  | { status: "no_credentials" }
  | { status: "invalid" }
  | { status: "lookup_failed"; error: unknown }
  | { status: "authenticated"; key: K };

/**
 * One AUTH through the failed-AUTH throttle: counts the attempt (or
 * refuses it, `rate_limited`, before any lookup), then checks `candidate`
 * with `lookup`. Missing credentials and an unknown or inactive key are
 * failures and stay counted; a valid key and a lookup that throws (our
 * failure, not a guess) give their count back. With the throttle off,
 * nothing is counted. The lookup is injected so the unit test runs the
 * real flow without a database.
 */
export async function throttledAuth<K extends { isActive: boolean }>(
  ip: string,
  candidate: string,
  limit: AuthRateLimit,
  lookup: (candidate: string) => Promise<K | undefined>,
): Promise<AuthOutcome<K>> {
  let attempt: AuthAttempt | undefined;
  if (limit.enabled) {
    const counted = await takeAuthAttempt(ip, limit.maxAttempts, limit.windowSec);
    if (!counted) return { status: "rate_limited" };
    attempt = counted;
  }
  if (!candidate) return { status: "no_credentials" };

  let key: K | undefined;
  try {
    key = await lookup(candidate);
  } catch (error: unknown) {
    await refundAuthAttempt(attempt);
    return { status: "lookup_failed", error };
  }
  if (!key || !key.isActive) return { status: "invalid" };
  await refundAuthAttempt(attempt);
  return { status: "authenticated", key };
}

/**
 * Forgets this process's in-memory counts. A server started again (the
 * tests start and stop it per file) begins with none, as a restarted
 * process does. Counts in Redis are shared by every replica and stay.
 */
export function resetSubmissionLimits(): void {
  connectionCounter.local.entries.clear();
  authCounter.local.entries.clear();
}
