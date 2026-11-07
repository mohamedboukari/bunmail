import type { MtaStsFailureKind } from "./mta-sts-fetch.ts";
import type { MtaStsPolicy } from "./mta-sts-policy.ts";

/**
 * The MTA-STS policy cache class (#250). The process-wide instance and
 * the rules that use it live in `mta-sts.ts`.
 */

/** Most recipient domains whose policy is cached; the oldest entry is evicted past it. */
export const MTA_STS_CACHE_LIMIT = 10_000;

/**
 * How long a failed policy fetch is not retried for the same domain and
 * policy `id`. Without it, every attempt to a domain whose policy host is
 * down would wait out the fetch timeout again.
 */
const MTA_STS_FETCH_RETRY_AFTER_MS = 5 * 60_000;

/* ─── Cache ─── */

/** A cached policy of one recipient domain. */
interface CachedPolicy {
  id: string;
  policy: MtaStsPolicy;
  /** Epoch ms past which the policy is no longer used. */
  expiresAt: number;
  /** A testing-mode "would have failed" warning was logged for this `id`. */
  warned: boolean;
}

/**
 * Policies by recipient domain (#250), in memory, at most `limit` domains:
 * a new domain past the limit evicts the entry stored longest ago. Also
 * remembers failed fetches, by domain and `id`, for
 * {@link MTA_STS_FETCH_RETRY_AFTER_MS}, under the same bound.
 */
export class MtaStsPolicyCache {
  private readonly policies = new Map<string, CachedPolicy>();
  private readonly failures = new Map<
    string,
    { id: string; retryAt: number; kind: MtaStsFailureKind }
  >();

  constructor(private readonly limit = MTA_STS_CACHE_LIMIT) {}

  /** The unexpired policy of `domain`, if any; an expired one is dropped. */
  get(domain: string, now: number): CachedPolicy | undefined {
    const entry = this.policies.get(domain);
    if (entry === undefined) return undefined;
    if (now >= entry.expiresAt) {
      this.policies.delete(domain);
      return undefined;
    }
    return entry;
  }

  /** Stores `domain`'s freshly fetched policy, as the newest entry. */
  set(domain: string, id: string, policy: MtaStsPolicy, now: number): void {
    this.failures.delete(domain);
    bounded(this.policies, domain, this.limit, {
      id,
      policy,
      expiresAt: now + policy.maxAge * 1000,
      warned: false,
    });
  }

  /** Records a failed fetch of `domain`'s policy `id`, and why it failed (#345). */
  failed(
    domain: string,
    id: string,
    now: number,
    kind: MtaStsFailureKind = "fetch-error",
  ): void {
    bounded(this.failures, domain, this.limit, {
      id,
      retryAt: now + MTA_STS_FETCH_RETRY_AFTER_MS,
      kind,
    });
  }

  /**
   * Why a fetch of `domain`'s policy `id` failed, when it failed recently
   * and is not tried again yet; `null` otherwise.
   */
  recentFailure(domain: string, id: string, now: number): MtaStsFailureKind | null {
    const failure = this.failures.get(domain);
    return failure !== undefined && failure.id === id && now < failure.retryAt
      ? failure.kind
      : null;
  }

  /**
   * True the first time it is called for `domain`'s cached policy `id`,
   * false after: a testing-mode warning is logged once per policy.
   */
  firstWarning(domain: string, id: string): boolean {
    const entry = this.policies.get(domain);
    if (entry === undefined || entry.id !== id || entry.warned) return false;
    entry.warned = true;
    return true;
  }

  /** Number of cached policies. */
  get size(): number {
    return this.policies.size;
  }

  clear(): void {
    this.policies.clear();
    this.failures.clear();
  }
}

/** Sets `key` as the newest entry of `map`, evicting the oldest past `limit`. */
function bounded<T>(map: Map<string, T>, key: string, limit: number, value: T): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
  }
}
