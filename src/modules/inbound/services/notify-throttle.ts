import {
  checkRateLimit,
  pruneExpiredEntries,
  type RateLimitEntry,
} from "../../../middleware/rate-limit-core.ts";

/**
 * Throttle for inbound notifications (#250).
 *
 * A flood of inbound mail must not become a flood of notifications
 * signed by the operator's domain. Two fixed-window budgets apply, and a
 * notification needs both:
 * - per recipient address: {@link NOTIFY_THROTTLE_MAX} per window;
 * - per recipient domain: {@link NOTIFY_DOMAIN_THROTTLE_MAX} per window,
 *   so a domain that accepts any local part cannot be flooded through
 *   many addresses, each with a budget of its own.
 * A message over either budget is counted against its address instead,
 * and the next notification for that address reports the count ("and N
 * more since <time>").
 *
 * In memory, so the budgets are per replica, like the other limiters; the
 * window logic is the HTTP limiter's ({@link checkRateLimit}).
 */

/** Notifications per recipient address per window. */
export const NOTIFY_THROTTLE_MAX = 5;

/** Notifications per recipient domain per window. */
export const NOTIFY_DOMAIN_THROTTLE_MAX = 30;

/** Length of a throttle window: 10 minutes. */
export const NOTIFY_THROTTLE_WINDOW_MS = 10 * 60 * 1000;

/**
 * How long an unreported count is kept when no later mail arrives to
 * report it: a day, so the map cannot grow without bound.
 */
const SKIPPED_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Notifications not sent for one recipient, waiting to be reported. */
export interface SkippedNotifications {
  /** How many messages were not notified individually. */
  count: number;
  /** When the first of them arrived (ms). */
  since: number;
}

/** The throttle's answer for one inbound message. */
export type NotifyThrottleDecision =
  | {
      notify: true;
      /** Messages skipped earlier for this address, to mention; `null` when none. */
      skipped: SkippedNotifications | null;
    }
  | {
      notify: false;
      /** Which budget is spent. */
      limitedBy: "address" | "domain";
      /** True for the first message that budget skipped in its window (log once). */
      firstInWindow: boolean;
    };

/** Whether `key`'s current window has already used all `max` slots. */
function isSpent(
  map: Map<string, RateLimitEntry>,
  key: string,
  now: number,
  max: number,
): boolean {
  const entry = map.get(key);
  return (
    entry !== undefined &&
    now - entry.windowStart < NOTIFY_THROTTLE_WINDOW_MS &&
    entry.count >= max
  );
}

/** The notification budgets, one instance per process. */
export class NotifyThrottle {
  /** Fixed window per recipient address: count and start. */
  private readonly addresses = new Map<string, RateLimitEntry>();
  /** Fixed window per recipient domain: count and start. */
  private readonly domains = new Map<string, RateLimitEntry>();
  /** Skipped messages per recipient address, until a notification reports them. */
  private readonly skipped = new Map<string, SkippedNotifications>();

  /**
   * Records one message for `recipient` and decides whether it is
   * notified. Addresses and domains compare case-insensitively. A message
   * skipped by one budget does not use up the other: the address budget
   * is checked first without touching the domain's, and a message the
   * domain budget skips is not counted against the address's.
   */
  check(recipient: string, now: number): NotifyThrottleDecision {
    const key = recipient.toLowerCase();
    const domain = key.slice(key.lastIndexOf("@") + 1);
    const addressOptions = {
      max: NOTIFY_THROTTLE_MAX,
      windowMs: NOTIFY_THROTTLE_WINDOW_MS,
    };

    if (isSpent(this.addresses, key, now, NOTIFY_THROTTLE_MAX)) {
      const decision = checkRateLimit(this.addresses, key, now, addressOptions);
      this.recordSkipped(key, now);
      return {
        notify: false,
        limitedBy: "address",
        firstInWindow: decision.limited && decision.count === NOTIFY_THROTTLE_MAX + 1,
      };
    }

    const domainDecision = checkRateLimit(this.domains, domain, now, {
      max: NOTIFY_DOMAIN_THROTTLE_MAX,
      windowMs: NOTIFY_THROTTLE_WINDOW_MS,
    });
    if (domainDecision.limited) {
      this.recordSkipped(key, now);
      return {
        notify: false,
        limitedBy: "domain",
        firstInWindow: domainDecision.count === NOTIFY_DOMAIN_THROTTLE_MAX + 1,
      };
    }

    /** Not spent (checked above), so this only takes a slot. */
    checkRateLimit(this.addresses, key, now, addressOptions);
    const pending = this.skipped.get(key) ?? null;
    this.skipped.delete(key);
    return { notify: true, skipped: pending };
  }

  /** Drops expired windows and counts too old to report. */
  prune(now: number): void {
    pruneExpiredEntries(this.addresses, now, NOTIFY_THROTTLE_WINDOW_MS);
    pruneExpiredEntries(this.domains, now, NOTIFY_THROTTLE_WINDOW_MS);
    for (const [key, pending] of this.skipped) {
      if (now - pending.since >= SKIPPED_RETENTION_MS) this.skipped.delete(key);
    }
  }

  /** Counts one skipped message against `key`. */
  private recordSkipped(key: string, now: number): void {
    const pending = this.skipped.get(key);
    if (pending) pending.count += 1;
    else this.skipped.set(key, { count: 1, since: now });
  }
}
