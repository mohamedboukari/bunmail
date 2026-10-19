import {
  checkRateLimit,
  pruneExpiredEntries,
  type RateLimitEntry,
} from "../../../middleware/rate-limit-core.ts";

/**
 * Per-recipient throttle for inbound notifications (#250).
 *
 * A flood of inbound mail to one address must not become a flood of
 * notifications signed by the operator's domain. At most
 * {@link NOTIFY_THROTTLE_MAX} notifications go out per recipient address
 * per {@link NOTIFY_THROTTLE_WINDOW_MS}; later mail in that window is
 * counted instead, and the first notification of a later window reports
 * the count ("and N more since <time>").
 *
 * In memory, so the budget is per replica, like the other limiters; the
 * window logic is the HTTP limiter's ({@link checkRateLimit}).
 */

/** Notifications per recipient address per window. */
export const NOTIFY_THROTTLE_MAX = 5;

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
      /** Messages skipped in an earlier window, to mention; `null` when none. */
      skipped: SkippedNotifications | null;
    }
  | {
      notify: false;
      /** True for the first skipped message of the window (log once). */
      firstInWindow: boolean;
    };

/** The per-recipient notification budget, one instance per process. */
export class NotifyThrottle {
  /** Fixed window per recipient: count and start. */
  private readonly windows = new Map<string, RateLimitEntry>();
  /** Skipped messages per recipient, until a notification reports them. */
  private readonly skipped = new Map<string, SkippedNotifications>();

  /**
   * Records one message for `recipient` and decides whether it is
   * notified. Addresses compare case-insensitively.
   */
  check(recipient: string, now: number): NotifyThrottleDecision {
    const key = recipient.toLowerCase();
    const decision = checkRateLimit(this.windows, key, now, {
      max: NOTIFY_THROTTLE_MAX,
      windowMs: NOTIFY_THROTTLE_WINDOW_MS,
    });
    if (decision.limited) {
      const pending = this.skipped.get(key);
      if (pending) pending.count += 1;
      else this.skipped.set(key, { count: 1, since: now });
      return { notify: false, firstInWindow: decision.count === NOTIFY_THROTTLE_MAX + 1 };
    }
    /** A fixed window only lets mail through again once a new one starts. */
    const pending = this.skipped.get(key) ?? null;
    this.skipped.delete(key);
    return { notify: true, skipped: pending };
  }

  /** Drops expired windows and counts too old to report. */
  prune(now: number): void {
    pruneExpiredEntries(this.windows, now, NOTIFY_THROTTLE_WINDOW_MS);
    for (const [key, pending] of this.skipped) {
      if (now - pending.since >= SKIPPED_RETENTION_MS) this.skipped.delete(key);
    }
  }
}
