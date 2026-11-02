import { createHash } from "crypto";

/**
 * One callback per SSO flow (#224).
 *
 * The flow cookie cannot enforce single use by itself: the browser clears
 * it after the callback, but whoever holds a copy can send it again with
 * its `state` and any `code` for its 10 minutes, and each such request
 * would make BunMail call the provider's token endpoint with the client
 * secret. So the callback consumes the flow's `state` once its cookie and
 * `state` checks pass and before any network call: a second callback with
 * the same `state` is refused (`flow_replayed`) without touching the
 * provider.
 *
 * Only the SHA-256 of the `state` is kept, until the cookie's own expiry.
 * The store is behind {@link SsoReplayStore}, whose method is async, so it
 * can move to the shared store of the multi-replica work (#185). Until
 * then it is in memory and per replica: a replayed callback that lands on
 * another replica is not caught there (it still needs the cookie, and
 * the provider's one-time code refuses the exchange).
 */

/** Where consumed flow states are remembered. */
export interface SsoReplayStore {
  /**
   * Records `key` until `expiresAtSec` (Unix seconds). Resolves `true`
   * the first time, `false` when `key` is already recorded and not yet
   * expired. Must be atomic: two concurrent calls for one key never both
   * resolve `true`.
   */
  consume(key: string, expiresAtSec: number, nowSec: number): Promise<boolean>;
}

/** Most states the in-memory store holds; expired ones, then the oldest, make room. */
export const SSO_REPLAY_STORE_MAX_ENTRIES = 10_000;

/**
 * The in-memory {@link SsoReplayStore}. Atomic because `consume` checks
 * and writes without awaiting in between. Bounded: when full, expired
 * entries are swept, then the oldest are dropped (an entry is only made
 * once a flow's cookie and `state` are valid, so filling it takes that
 * many started flows, which the sign-in routes rate-limit).
 */
export class MemorySsoReplayStore implements SsoReplayStore {
  /** Expiry (Unix seconds) by key, in insertion order. */
  private readonly entries = new Map<string, number>();

  constructor(private readonly maxEntries: number = SSO_REPLAY_STORE_MAX_ENTRIES) {}

  consume(key: string, expiresAtSec: number, nowSec: number): Promise<boolean> {
    const until = this.entries.get(key);
    if (until !== undefined && until > nowSec) return Promise.resolve(false);
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      for (const [entry, expiry] of this.entries) {
        if (expiry <= nowSec) this.entries.delete(entry);
      }
    }
    for (const oldest of this.entries.keys()) {
      if (this.entries.size < this.maxEntries) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, expiresAtSec);
    return Promise.resolve(true);
  }

  /** How many states are held (tests). */
  get size(): number {
    return this.entries.size;
  }
}

/** The store of this process. */
export const defaultSsoReplayStore: SsoReplayStore = new MemorySsoReplayStore();

/** The store key of a flow's `state`: its SHA-256, so the store never holds the value. */
export function ssoReplayKey(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}
