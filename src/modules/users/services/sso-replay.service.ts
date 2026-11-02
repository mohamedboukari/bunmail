import { createHash } from "crypto";
import { sharedOneTimeStore, type OneTimeStore } from "../../../utils/shared-store.ts";

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
 * It lives in the shared one-time store (#185, `claim`): in this process's
 * memory by default, so any replica can still finish any flow (the cookie
 * carries everything else) and a replay is caught on the replica that saw
 * the first callback; with `REDIS_URL` set, in Redis, so a replay is
 * caught on every replica. A Redis failure, or an in-memory store full of
 * live states, fails closed: the claim rejects and the callback is
 * answered with an error, never let through unchecked.
 */

/** Where consumed flow states are remembered. */
export interface SsoReplayStore {
  /**
   * Records `key` until `expiresAtSec` (Unix seconds). Resolves `true`
   * the first time, `false` when `key` is already recorded and not yet
   * expired. Must be atomic: two concurrent calls for one key never both
   * resolve `true`. Rejects when the store cannot be reached.
   */
  consume(key: string, expiresAtSec: number, nowSec: number): Promise<boolean>;
}

/**
 * Most states the in-memory side holds. Expired ones are swept to make
 * room; when every one is still live, a new claim is refused (fail
 * closed) rather than evicting a live one, which would re-open its replay.
 */
const SSO_REPLAY_STORE_MAX_ENTRIES = 10_000;

/**
 * How long a claim outlives the flow's own expiry, in seconds: a margin for
 * clock skew between replicas, which compare `exp` with their own clocks.
 */
const SSO_REPLAY_SKEW_SECONDS = 60;

/** The shared-store namespace of consumed states. */
const SSO_REPLAY_NAMESPACE = "sso-replay";

/**
 * The {@link SsoReplayStore} over a one-time store's `claim`. The key is
 * held for what is left of the flow's life, which is as long as its cookie
 * could be presented again, plus {@link SSO_REPLAY_SKEW_SECONDS} for a
 * replica whose clock runs behind.
 */
export class SharedSsoReplayStore implements SsoReplayStore {
  constructor(
    private readonly store: OneTimeStore = sharedOneTimeStore(
      SSO_REPLAY_NAMESPACE,
      SSO_REPLAY_STORE_MAX_ENTRIES,
    ),
  ) {}

  consume(key: string, expiresAtSec: number, nowSec: number): Promise<boolean> {
    const ttlSec = Math.max(0, expiresAtSec - nowSec) + SSO_REPLAY_SKEW_SECONDS;
    return this.store.claim(key, ttlSec * 1000);
  }
}

/** The store of this deployment: process memory, or Redis when `REDIS_URL` is set. */
export const defaultSsoReplayStore: SsoReplayStore = new SharedSsoReplayStore();

/** The store key of a flow's `state`: its SHA-256, so the store never holds the value. */
export function ssoReplayKey(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}
