import type { TrackingHit } from "../types/tracking.types.ts";

/**
 * The in-process gate in front of the recording transaction (#187). The
 * database dedupe and caps (under a lock on the email row) stay the truth
 * across replicas; this gate keeps one token, or a burst of them, from
 * using up the process's capacity:
 *
 * 1. **Dedupe:** the same email, type and link seen within the dedupe
 *    window is `deduped` without touching the database.
 * 2. **Per-email caps:** an email that already reached its cap in this
 *    process is `capped`.
 * 3. **Budget:** only requests that pass 1 and 2 are charged to the
 *    per-second budget, so one replayed token cannot exhaust it for every
 *    other email.
 * 4. **Concurrency:** at most `maxInFlight` recordings run at once (each
 *    holds a pooled connection and a row lock); anything over it is
 *    `capped`, never queued.
 *
 * The two maps are bounded LRUs: the least recently used entry is dropped
 * past `maxEntries`, which only ever lets a request through to the
 * database checks.
 */

/** What the gate decided: go ahead (a slot is taken), or not, and why. */
export type GuardDecision = "go" | "deduped" | "capped";

/** The gate's limits; see the file comment. */
export interface GuardLimits {
  dedupeWindowMs: number;
  /** Cap per email, by kind. */
  caps: { open: number; click: number };
  budgetPerSecond: number;
  maxInFlight: number;
  /** Entries kept in each LRU map. */
  maxEntries: number;
  now: () => number;
}

/** Sets `key` as the most recent entry of `map`, dropping the oldest past `max`. */
function touch(map: Map<string, number>, key: string, value: number, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
  }
}

/** The in-process gate; one per recorder. */
export class RecordingGuards {
  private readonly recent = new Map<string, number>();
  private readonly counts = new Map<string, number>();
  private windowStart = 0;
  private used = 0;
  private inFlight = 0;

  constructor(private readonly limits: GuardLimits) {}

  /**
   * Decides whether `hit` may be recorded. On `go`, the hit is counted
   * (dedupe entry, per-email count, budget) and a concurrency slot is
   * taken: the caller must {@link release} it once the transaction ends.
   */
  admit(hit: TrackingHit): GuardDecision {
    const at = this.limits.now();
    const linkKey = `${hit.emailId}|${hit.kind}|${hit.position ?? ""}`;
    const seen = this.recent.get(linkKey);
    if (seen !== undefined && at - seen < this.limits.dedupeWindowMs) return "deduped";

    const emailKey = `${hit.emailId}|${hit.kind}`;
    const count = this.counts.get(emailKey) ?? 0;
    if (count >= this.limits.caps[hit.kind]) return "capped";

    if (at - this.windowStart >= 1000) {
      this.windowStart = at;
      this.used = 0;
    }
    if (this.used >= this.limits.budgetPerSecond) return "capped";
    if (this.inFlight >= this.limits.maxInFlight) return "capped";

    this.used += 1;
    this.inFlight += 1;
    touch(this.recent, linkKey, at, this.limits.maxEntries);
    touch(this.counts, emailKey, count + 1, this.limits.maxEntries);
    return "go";
  }

  /** Frees the concurrency slot taken by an admitted hit. */
  release(): void {
    if (this.inFlight > 0) this.inFlight -= 1;
  }
}
