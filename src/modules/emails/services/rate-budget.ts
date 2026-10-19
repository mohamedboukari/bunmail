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
 * In memory and per replica, like the MX lock: N replicas send at most N
 * times the rate in total. A restart starts every bucket full.
 *
 * The clock is injectable, so the refill and the wait unit-test with no
 * timers; the mailer's budget can be replaced in tests ({@link setMxRateBudget}).
 */

/** What {@link RateBudget.take} grants. */
export interface RateGrant {
  /** Tokens taken, from 0 to the number asked for. */
  granted: number;
  /** When fewer were granted than asked: ms until the next token is due, else 0. */
  waitMs: number;
}

/** A token bucket per key. */
export interface RateBudget {
  /** The per-minute rate (and each bucket's capacity). */
  readonly ratePerMin: number;
  /** Takes up to `count` whole tokens from `bucket`'s budget. */
  take(bucket: string, count: number): RateGrant;
  /**
   * Whether a "rate budget reached" line should be logged for `bucket`
   * now: true at most once a minute per bucket, so a backlog held back by
   * the budget does not log a line per message.
   */
  shouldLog(bucket: string): boolean;
}

/** Most buckets kept before full (idle) ones are dropped. */
const MAX_IDLE_BUCKETS = 1_000;

/** How often a limited bucket logs, see {@link RateBudget.shouldLog}. */
const LOG_EVERY_MS = 60_000;

/** One bucket's state: its tokens at `at` (ms, from the clock). */
interface BucketState {
  tokens: number;
  at: number;
}

/**
 * Creates a {@link RateBudget} of `ratePerMin` tokens a minute per bucket.
 *
 * @param ratePerMin - Capacity and refill per minute (a whole number, 1 or more)
 * @param now - The clock, in ms; `Date.now` by default
 */
export function createRateBudget(
  ratePerMin: number,
  now: () => number = Date.now,
): RateBudget {
  const capacity = ratePerMin;
  const perMs = ratePerMin / 60_000;
  const buckets = new Map<string, BucketState>();
  const loggedAt = new Map<string, number>();

  /** `bucket`'s tokens now, refilled since its last use and capped. */
  const refill = (bucket: string, at: number): BucketState => {
    const state = buckets.get(bucket);
    if (!state) return { tokens: capacity, at };
    const elapsed = Math.max(0, at - state.at);
    return { tokens: Math.min(capacity, state.tokens + elapsed * perMs), at };
  };

  /** Drops buckets that refilled to capacity: they are the same as a new one. */
  const sweep = (at: number): void => {
    if (buckets.size <= MAX_IDLE_BUCKETS) return;
    for (const bucket of buckets.keys()) {
      if (refill(bucket, at).tokens >= capacity) {
        buckets.delete(bucket);
        loggedAt.delete(bucket);
      }
    }
  };

  return {
    ratePerMin,
    take: (bucket, count) => {
      const at = now();
      sweep(at);
      const state = refill(bucket, at);
      const granted = Math.max(0, Math.min(count, Math.floor(state.tokens)));
      const tokens = state.tokens - granted;
      buckets.set(bucket, { tokens, at });
      if (granted === count) return { granted, waitMs: 0 };
      return { granted, waitMs: Math.ceil((1 - tokens) / perMs) };
    },
    shouldLog: (bucket) => {
      const at = now();
      const last = loggedAt.get(bucket);
      if (last !== undefined && at - last < LOG_EVERY_MS) return false;
      loggedAt.set(bucket, at);
      return true;
    },
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
    mxBudget = { rate: ratePerMin, budget: createRateBudget(ratePerMin) };
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
