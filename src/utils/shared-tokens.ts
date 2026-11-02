import { installedSharedBackend, reportFallback } from "./shared-store.ts";

/**
 * Token buckets that several replicas share (#391): the per-provider rate
 * budget of outbound mail (`MAIL_MX_RATE_PER_MIN`) rests on it.
 *
 * A bucket holds at most `capacity` tokens, starts full, and refills
 * continuously at `perMinute` tokens a minute; a take gets whole tokens
 * only. Smooth pacing, no burst at a window's start: a fixed window would
 * let a full budget through at the end of one window and another at the
 * start of the next.
 *
 * The memory implementation is exact for one replica (and is the whole
 * budget without `REDIS_URL`); the Redis one lives in `redis-tokens.ts`.
 * {@link sharedTokenBuckets} picks between them and falls back to memory
 * during an outage, like the counters. Nothing is ever given back, so a
 * take needs no tag of the store that answered it.
 */

/* ─── Contract ─── */

/** A bucket's size and refill. */
export interface TokenRate {
  /** Most tokens a bucket holds (it starts full). */
  capacity: number;
  /** Tokens added a minute, continuously. */
  perMinute: number;
}

/** What a take grants. */
export interface TokenGrant {
  /** Tokens taken, from 0 to the number asked for. */
  granted: number;
  /** When fewer were granted than asked: ms until the next token is due, else 0. */
  waitMs: number;
}

/** Token buckets by key; every take is atomic. */
export interface TokenBucketStore {
  /** Takes up to `count` whole tokens from `key`'s bucket. */
  take(key: string, count: number, rate: TokenRate): Promise<TokenGrant>;
}

/* ─── In memory (one replica) ─── */

/** Most buckets kept before full (idle) ones are dropped. */
const MAX_IDLE_BUCKETS = 1_000;

/** One bucket in memory: its tokens at `at` (ms, from the clock), and its rate. */
interface MemoryBucket {
  tokens: number;
  at: number;
  rate: TokenRate;
}

/**
 * {@link TokenBucketStore} in process memory: exact for one replica. The
 * clock is injectable, so the refill and the wait unit-test with no timers.
 * Past {@link MAX_IDLE_BUCKETS} buckets, the full ones are dropped (a full
 * bucket is the same as a new one), so the map cannot grow without bound.
 */
export class MemoryTokenBuckets implements TokenBucketStore {
  /** Buckets by key. Tests may read it. */
  readonly entries = new Map<string, MemoryBucket>();

  constructor(private readonly now: () => number = Date.now) {}

  /** `key`'s tokens at `at`, refilled since its last take and capped. */
  private refill(key: string, at: number, rate: TokenRate): number {
    const state = this.entries.get(key);
    if (!state) return rate.capacity;
    const elapsed = Math.max(0, at - state.at);
    return Math.min(rate.capacity, state.tokens + elapsed * (rate.perMinute / 60_000));
  }

  /** Drops buckets that refilled to capacity, once there are too many. */
  private sweep(at: number): void {
    if (this.entries.size <= MAX_IDLE_BUCKETS) return;
    for (const [key, state] of this.entries) {
      if (this.refill(key, at, state.rate) >= state.rate.capacity)
        this.entries.delete(key);
    }
  }

  /** {@link TokenBucketStore.take}, synchronously. */
  takeNow(key: string, count: number, rate: TokenRate): TokenGrant {
    const at = this.now();
    this.sweep(at);
    const perMs = rate.perMinute / 60_000;
    const before = this.refill(key, at, rate);
    const granted = Math.max(0, Math.min(count, Math.floor(before)));
    const tokens = before - granted;
    this.entries.set(key, { tokens, at, rate });
    if (granted === count) return { granted, waitMs: 0 };
    return { granted, waitMs: Math.ceil((1 - tokens) / perMs) };
  }

  take(key: string, count: number, rate: TokenRate): Promise<TokenGrant> {
    return Promise.resolve(this.takeNow(key, count, rate));
  }
}

/* ─── Backend selection ─── */

/** Token buckets that also expose their in-memory side. */
export interface SharedTokenBuckets extends TokenBucketStore {
  /** The process-memory buckets: the default, and the fallback during an outage. */
  readonly local: MemoryTokenBuckets;
}

/**
 * The token buckets of `namespace`: the shared backend's when one is
 * installed, falling back to process memory when it fails (logged once a
 * minute per namespace, like the counters), else process memory. During
 * an outage each replica's memory bucket starts full: up to one extra
 * capacity per replica, then the per-replica rate.
 */
export function sharedTokenBuckets(namespace: string): SharedTokenBuckets {
  const local = new MemoryTokenBuckets();
  async function take(key: string, count: number, rate: TokenRate): Promise<TokenGrant> {
    const installed = installedSharedBackend();
    if (installed) {
      try {
        return await installed.backend.tokens(namespace).take(key, count, rate);
      } catch (error: unknown) {
        reportFallback(namespace, error);
      }
    }
    return local.takeNow(key, count, rate);
  }
  return { local, take };
}
