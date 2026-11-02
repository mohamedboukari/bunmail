import {
  MemoryTokenBuckets,
  sharedTokenBuckets,
  type TokenGrant,
} from "../../../utils/shared-tokens.ts";

/**
 * Per-provider rate budget for outbound mail (#250, `MAIL_MX_RATE_PER_MIN`).
 *
 * A token bucket per provider bucket (`provider-bucket.ts`): it holds at
 * most `ratePerMin` tokens, starts full, and refills continuously at
 * `ratePerMin` tokens a minute. Every message (one SMTP transaction) to a
 * bucket takes one token. A message with no token left is not sent on this
 * attempt: the queue defers its email until a token is due
 * ({@link RateBudget.take} says when), without counting a failure.
 *
 * The buckets are the shared token buckets (#391, `src/utils/shared-tokens.ts`):
 * in process memory by default, so one replica paces exactly as before
 * (a restart starts every bucket full); with `REDIS_URL`, in Redis, so the
 * rate holds across every replica. During a Redis outage each replica
 * falls back to its own memory bucket (logged at `error` once a minute):
 * N replicas may then send up to N times the rate, as without Redis.
 *
 * {@link createRateBudget} is the memory budget with an injectable clock,
 * so the refill and the wait unit-test with no timers; the mailer's budget
 * can be replaced in tests ({@link setMxRateBudget}).
 */

/** What {@link RateBudget.take} grants. */
export type RateGrant = TokenGrant;

/** A token bucket per key. */
export interface RateBudget {
  /** The per-minute rate (and each bucket's capacity). */
  readonly ratePerMin: number;
  /** Takes up to `count` whole tokens from `bucket`'s budget. */
  take(bucket: string, count: number): RateGrant | Promise<RateGrant>;
  /**
   * Whether a "rate budget reached" line should be logged for `bucket`
   * now: true at most once a minute per bucket, so a backlog held back by
   * the budget does not log a line per message. Per replica.
   */
  shouldLog(bucket: string): boolean;
}

/** A {@link RateBudget} in this process's memory, whose take answers at once. */
export interface LocalRateBudget extends RateBudget {
  take(bucket: string, count: number): RateGrant;
}

/** How often a limited bucket logs, see {@link RateBudget.shouldLog}. */
const LOG_EVERY_MS = 60_000;

/** {@link RateBudget.shouldLog} on the clock `now`. */
function logGate(now: () => number): (bucket: string) => boolean {
  const loggedAt = new Map<string, number>();
  return (bucket) => {
    const at = now();
    const last = loggedAt.get(bucket);
    if (last !== undefined && at - last < LOG_EVERY_MS) return false;
    /** Bounded like the buckets: a long tail of buckets cannot grow it for good. */
    if (loggedAt.size >= 1_000) {
      for (const [key, time] of loggedAt) {
        if (at - time >= LOG_EVERY_MS) loggedAt.delete(key);
      }
    }
    loggedAt.set(bucket, at);
    return true;
  };
}

/**
 * Creates a {@link LocalRateBudget} of `ratePerMin` tokens a minute per
 * bucket, in this process's memory.
 *
 * @param ratePerMin - Capacity and refill per minute (a whole number, 1 or more)
 * @param now - The clock, in ms; `Date.now` by default
 */
export function createRateBudget(
  ratePerMin: number,
  now: () => number = Date.now,
): LocalRateBudget {
  const buckets = new MemoryTokenBuckets(now);
  const rate = { capacity: ratePerMin, perMinute: ratePerMin };
  return {
    ratePerMin,
    take: (bucket, count) => buckets.takeNow(bucket, count, rate),
    shouldLog: logGate(now),
  };
}

/**
 * The mailer's {@link RateBudget}: the shared token buckets of namespace
 * `rate:mx`, with the same arithmetic as {@link createRateBudget}.
 */
function createSharedRateBudget(ratePerMin: number): RateBudget {
  const buckets = sharedTokenBuckets("rate:mx");
  const rate = { capacity: ratePerMin, perMinute: ratePerMin };
  return {
    ratePerMin,
    take: (bucket, count) => buckets.take(bucket, count, rate),
    shouldLog: logGate(Date.now),
  };
}

/**
 * The delay a deferred email waits before it is claimed again (#250): the
 * wait until its bucket's next token, plus a small jitter (up to 10% of
 * the wait, at least up to 250 ms), so emails deferred together do not all
 * come back at the same instant.
 */
export function deferralDelayMs(
  waitMs: number,
  random: () => number = Math.random,
): number {
  const spread = Math.max(250, waitMs * 0.1);
  return Math.max(1, Math.ceil(waitMs + random() * spread));
}

/** The mailer's budget: built from `MAIL_MX_RATE_PER_MIN` on first use, or a test's. */
let mxBudget: { rate: number; budget: RateBudget } | null = null;

/** A budget installed by a test, see {@link setMxRateBudget}. */
let override: RateBudget | null = null;

/**
 * The rate budget for `ratePerMin` (`config.mail.mxRatePerMin`), or `null`
 * when there is none. Created once and kept, so the token counts survive
 * across attempts; a changed rate (tests) starts a new one.
 */
export function mxRateBudget(ratePerMin: number | null): RateBudget | null {
  if (override !== null) return override;
  if (ratePerMin === null) return null;
  if (mxBudget?.rate !== ratePerMin) {
    mxBudget = { rate: ratePerMin, budget: createSharedRateBudget(ratePerMin) };
  }
  return mxBudget.budget;
}

/**
 * Replaces the mailer's rate budget (tests: one with an injected clock),
 * or with `null` goes back to the configured one, starting full.
 */
export function setMxRateBudget(budget: RateBudget | null): void {
  override = budget;
  mxBudget = null;
}
