import { logger } from "./logger.ts";

/**
 * State that several replicas must share (#185): fixed-window counters
 * (rate limits, failed-attempt budgets) and one-time entries (reveal
 * tokens).
 *
 * Every store has a process-memory implementation, the default: one
 * replica, nothing else to run. With `REDIS_URL` set, the boot installs a
 * Redis backend (`redis-store.ts`) and the same stores live there, so
 * every replica sees the same counts and any replica redeems a token
 * another one stored. Callers never know which backend answers.
 *
 * When Redis fails mid-operation:
 * - **counters fall back to this replica's memory** (the single-replica
 *   behaviour): limits keep holding, per replica, and nobody is locked
 *   out. One `error` line per namespace a minute says so.
 * - **one-time entries fail closed**: the error reaches the caller, which
 *   then shows nothing. A secret is never revealed from a store that
 *   might be stale, and never to anyone else.
 */

/* ─── Contracts ─── */

/** The limit a {@link WindowCounter.take} enforces. */
export interface WindowOptions {
  /** Most weight a key may hold in one window. */
  max: number;
  /** Window length; a key's window starts at its first counted request. */
  windowMs: number;
  /** What this request counts as (default 1). */
  weight?: number;
  /** What a refused request still counts as on every key (default 0). */
  refusedWeight?: number;
}

/** Outcome of a {@link WindowCounter.take}. */
export type WindowDecision =
  | { limited: false; count: number }
  | { limited: true; count: number; retryAfterMs: number };

/** A key's live window. */
export interface WindowState {
  /** Weight counted in the window. */
  count: number;
  /** Milliseconds until the window ends. */
  resetInMs: number;
}

/**
 * Fixed-window counters. Each key's window starts with its first counted
 * request and lasts `windowMs`; every operation on one call is atomic, so
 * concurrent requests on any replica cannot both slip under a limit.
 */
export interface WindowCounter {
  /**
   * Counts one request against every key, or refuses it: refused when,
   * for any key, its count plus `weight` would pass `max`. A refusal adds
   * `refusedWeight` to every key instead; `retryAfterMs` is the longest
   * wait among the keys over the limit. `count` is the highest count
   * among the keys afterwards.
   */
  take(keys: readonly string[], options: WindowOptions): Promise<WindowDecision>;
  /** The key's live window, or `null` when it has none. */
  peek(key: string): Promise<WindowState | null>;
  /** Takes one back from a live window, never below zero; no-op without one. */
  refund(key: string): Promise<void>;
  /** Forgets the keys' windows. */
  delete(keys: readonly string[]): Promise<void>;
  /**
   * True the first time it is asked during the key's live window, false
   * afterwards and when the key has no live window. A new window resets it.
   */
  markOnce(key: string): Promise<boolean>;
}

/** What a one-time entry holds. */
export interface OneTimeEntry {
  /**
   * Who may take it: compared for equality, returned on a mismatch for the
   * caller's log line. Must not be a secret.
   */
  guard: string;
  /** The secret itself; the Redis backend encrypts it at rest. */
  value: string;
}

/** Outcome of a {@link OneTimeStore.take}. */
export type OneTimeTake =
  | { status: "missing" }
  | { status: "mismatch"; guard: string }
  | { status: "taken"; value: string };

/**
 * Entries readable once, for a limited time, only by the holder of the
 * matching guard. A take with the wrong guard leaves the entry in place.
 */
export interface OneTimeStore {
  /** Stores `entry` under `key` for `ttlMs`. */
  put(key: string, entry: OneTimeEntry, ttlMs: number): Promise<void>;
  /** Takes the entry if `guard` matches, atomically: two takes never both get it. */
  take(key: string, guard: string): Promise<OneTimeTake>;
}

/** A shared backend (Redis), installed at boot when `REDIS_URL` is set. */
export interface SharedStoreBackend {
  /** The counters of `namespace`; keys of different namespaces never meet. */
  counter(namespace: string): WindowCounter;
  /** The one-time entries of `namespace`. */
  oneTime(namespace: string): OneTimeStore;
  /** Closes the connection; later operations fail. */
  close(): void;
}

/** A store failure with a code safe to log (never a key, value or URL). */
export class SharedStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SharedStoreError";
  }
}

/** A failure's code for a log line: never its message, which may name a key. */
export function sharedStoreErrorCode(error: unknown): string {
  if (error instanceof SharedStoreError) return error.code;
  const code: unknown =
    typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return code;
  /** A Redis error reply starts with its code: `WRONGTYPE ...`, `OOM ...`. */
  const first = error instanceof Error ? error.message.split(" ", 1)[0] : undefined;
  return first !== undefined && /^[A-Z]{2,32}$/.test(first) ? first : "UNKNOWN";
}

/* ─── In-memory implementations (one replica) ─── */

/** The clock of the memory stores; tests move it with `setSystemTime`. */
const now = (): number => Date.now();

/** One key's window in memory. */
interface MemoryWindow {
  /** Weight counted in the window. */
  count: number;
  /** Unix epoch ms at which the window ends. */
  expiresAt: number;
  /** {@link WindowCounter.markOnce} already answered true in this window. */
  marked: boolean;
}

/** {@link WindowCounter} in process memory: exact for one replica. */
export class MemoryWindowCounter implements WindowCounter {
  /** Live and not yet swept windows, by key. Tests may read and clear it. */
  readonly entries = new Map<string, MemoryWindow>();

  /** The key's window, dropping it once over. */
  private live(key: string, at: number): MemoryWindow | undefined {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt <= at) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  take(keys: readonly string[], options: WindowOptions): Promise<WindowDecision> {
    const { max, windowMs, weight = 1, refusedWeight = 0 } = options;
    const at = now();
    let limited = false;
    let retryAfterMs = 0;
    for (const key of keys) {
      const entry = this.live(key, at);
      if ((entry?.count ?? 0) + weight > max) {
        limited = true;
        retryAfterMs = Math.max(retryAfterMs, entry ? entry.expiresAt - at : windowMs);
      }
    }
    const add = limited ? refusedWeight : weight;
    let count = 0;
    for (const key of keys) {
      let entry = this.live(key, at);
      if (add > 0) {
        if (!entry) {
          entry = { count: 0, expiresAt: at + windowMs, marked: false };
          this.entries.set(key, entry);
        }
        entry.count += add;
      }
      count = Math.max(count, entry?.count ?? 0);
    }
    return Promise.resolve(
      limited ? { limited: true, count, retryAfterMs } : { limited: false, count },
    );
  }

  peek(key: string): Promise<WindowState | null> {
    const at = now();
    const entry = this.live(key, at);
    return Promise.resolve(
      entry ? { count: entry.count, resetInMs: entry.expiresAt - at } : null,
    );
  }

  refund(key: string): Promise<void> {
    const entry = this.live(key, now());
    if (entry) entry.count = Math.max(0, entry.count - 1);
    return Promise.resolve();
  }

  delete(keys: readonly string[]): Promise<void> {
    for (const key of keys) this.entries.delete(key);
    return Promise.resolve();
  }

  markOnce(key: string): Promise<boolean> {
    const entry = this.live(key, now());
    if (!entry || entry.marked) return Promise.resolve(false);
    entry.marked = true;
    return Promise.resolve(true);
  }

  /** Drops every window that has ended; returns how many. */
  prune(): number {
    const at = now();
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= at) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

/** One one-time entry in memory. */
interface MemoryOneTime extends OneTimeEntry {
  /** Unix epoch ms after which the entry is gone. */
  expiresAt: number;
}

/**
 * {@link OneTimeStore} in process memory, capped at `maxEntries`: past the
 * cap (after dropping expired entries) the oldest entry is evicted, so a
 * burst cannot grow the map without bound.
 */
export class MemoryOneTimeStore implements OneTimeStore {
  /** Entries by key, oldest first. Tests may read and clear it. */
  readonly entries = new Map<string, MemoryOneTime>();

  constructor(private readonly maxEntries: number) {}

  put(key: string, entry: OneTimeEntry, ttlMs: number): Promise<void> {
    const at = now();
    for (const [k, e] of this.entries) {
      if (e.expiresAt <= at) this.entries.delete(k);
    }
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, {
      guard: entry.guard,
      value: entry.value,
      expiresAt: at + ttlMs,
    });
    return Promise.resolve();
  }

  take(key: string, guard: string): Promise<OneTimeTake> {
    const entry = this.entries.get(key);
    if (!entry) return Promise.resolve({ status: "missing" });
    if (entry.expiresAt <= now()) {
      this.entries.delete(key);
      return Promise.resolve({ status: "missing" });
    }
    if (entry.guard !== guard) {
      return Promise.resolve({ status: "mismatch", guard: entry.guard });
    }
    this.entries.delete(key);
    return Promise.resolve({ status: "taken", value: entry.value });
  }
}

/* ─── Backend selection ─── */

/** The shared backend, or `null` for process memory (the default). */
let backend: SharedStoreBackend | null = null;

/**
 * Installs the shared backend (boot, when `REDIS_URL` is set), or `null`
 * to go back to process memory (tests). Stores created earlier switch
 * with it: they look the backend up on every call.
 */
export function useSharedBackend(next: SharedStoreBackend | null): void {
  backend = next;
}

/** Closes the shared backend, if any (graceful shutdown). */
export function closeSharedStore(): void {
  const current = backend;
  backend = null;
  current?.close();
}

/** How often each namespace may log that it fell back to memory. */
const FALLBACK_LOG_INTERVAL_MS = 60_000;

/** Last fallback line per namespace, and how many were held back since. */
const fallbackLogged = new Map<string, { at: number; suppressed: number }>();

/**
 * Logs a counter falling back to memory: `error`, at most once a minute
 * per namespace, with the count of the ones held back in between.
 */
function reportFallback(namespace: string, error: unknown): void {
  const at = Date.now();
  const last = fallbackLogged.get(namespace);
  if (last && at - last.at < FALLBACK_LOG_INTERVAL_MS) {
    last.suppressed += 1;
    return;
  }
  fallbackLogged.set(namespace, { at, suppressed: 0 });
  logger.error(
    "Shared store unavailable: rate limits fall back to this replica's memory",
    {
      namespace,
      code: sharedStoreErrorCode(error),
      suppressedSinceLast: last?.suppressed ?? 0,
    },
  );
}

/** A counter that also exposes its in-memory side (default and fallback). */
export interface SharedWindowCounter extends WindowCounter {
  /** The process-memory counter: the default, and the fallback during an outage. */
  readonly local: MemoryWindowCounter;
}

/**
 * The fixed-window counters of `namespace`: the shared backend's when one
 * is installed, falling back to process memory when it fails (see the
 * module comment), else process memory.
 */
export function sharedWindowCounter(namespace: string): SharedWindowCounter {
  const local = new MemoryWindowCounter();
  /** Runs `op` on the shared backend, or on `local` without one or when it fails. */
  async function run<T>(op: (counter: WindowCounter) => Promise<T>): Promise<T> {
    const shared = backend;
    if (!shared) return op(local);
    try {
      return await op(shared.counter(namespace));
    } catch (error: unknown) {
      reportFallback(namespace, error);
      return op(local);
    }
  }
  return {
    local,
    take: (keys, options) => run((c) => c.take(keys, options)),
    peek: (key) => run((c) => c.peek(key)),
    refund: (key) => run((c) => c.refund(key)),
    delete: (keys) => run((c) => c.delete(keys)),
    markOnce: (key) => run((c) => c.markOnce(key)),
  };
}

/** A one-time store that also exposes its in-memory side (the default). */
export interface SharedOneTimeStore extends OneTimeStore {
  /** The process-memory store, used when no shared backend is installed. */
  readonly local: MemoryOneTimeStore;
}

/**
 * The one-time entries of `namespace`: the shared backend's when one is
 * installed, else process memory capped at `maxLocalEntries`. Fails
 * closed: a backend error rejects, never falls back (an entry stored in
 * one replica's memory could not be taken on another).
 */
export function sharedOneTimeStore(
  namespace: string,
  maxLocalEntries: number,
): SharedOneTimeStore {
  const local = new MemoryOneTimeStore(maxLocalEntries);
  const store = (): OneTimeStore => backend?.oneTime(namespace) ?? local;
  return {
    local,
    put: (key, entry, ttlMs) => store().put(key, entry, ttlMs),
    take: (key, guard) => store().take(key, guard),
  };
}
