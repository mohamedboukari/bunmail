import { logger } from "./logger.ts";
import type { SlotSemaphore } from "./shared-slots.ts";

/**
 * State that several replicas must share (#185): fixed-window counters
 * (rate limits, failed-attempt budgets), one-time entries (reveal tokens,
 * and the claimed `state` of each SSO callback, #224), and counting
 * semaphores with leased slots (the per-MX session limit, `shared-slots.ts`).
 *
 * Every store has a process-memory implementation, the default: one
 * replica, nothing else to run. With `REDIS_URL` set, the boot installs a
 * Redis backend (`redis-store.ts`) and the same stores live there, so
 * every replica sees the same counts and any replica redeems a token
 * another one stored. Callers never know which backend answers.
 *
 * When Redis fails mid-operation:
 * - **counters and semaphores fall back to this replica's memory** (the
 *   single-replica behaviour): limits keep holding, per replica, and
 *   nobody is locked out. One `error` line per namespace a minute says so.
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

/**
 * Which window each key of a {@link WindowCounter.take} counted in, by
 * key: an opaque id, absent for a key left without a live window. A
 * {@link WindowCounter.refund} gives back only into the window it names,
 * never into a later one.
 */
export type WindowTicket = ReadonlyMap<string, string>;

/** Outcome of a {@link WindowCounter.take}. */
export type WindowDecision =
  | { limited: false; count: number; windows: WindowTicket }
  | { limited: true; count: number; retryAfterMs: number; windows: WindowTicket };

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
   * among the keys afterwards; `windows` names each key's live window.
   */
  take(keys: readonly string[], options: WindowOptions): Promise<WindowDecision>;
  /** The key's live window, or `null` when it has none. */
  peek(key: string): Promise<WindowState | null>;
  /**
   * Takes one back from the key's live window, never below zero, only
   * while it is still the window `windowId` (from a take's `windows`): a
   * no-op once that window has ended, so a refund that arrives late never
   * gives back a count of the next window.
   */
  refund(key: string, windowId: string): Promise<void>;
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
  /**
   * Records `key` for `ttlMs` when nothing live is stored under it, and
   * says whether it did: true the first time, false while the key lives.
   * Atomic: two concurrent claims of one key never both get true. The
   * single use of an SSO callback's `state` (#224) rests on it. Holds no
   * value: a claimed key is only ever claimed, never taken. Rejects when
   * the store cannot record it (an outage; in memory, every slot taken by
   * a live entry): never a silent `true`.
   */
  claim(key: string, ttlMs: number): Promise<boolean>;
}

/** A shared backend (Redis), installed at boot when `REDIS_URL` is set. */
export interface SharedStoreBackend {
  /** The counters of `namespace`; keys of different namespaces never meet. */
  counter(namespace: string): WindowCounter;
  /** The one-time entries of `namespace`. */
  oneTime(namespace: string): OneTimeStore;
  /** The counting semaphores of `namespace`. */
  slots(namespace: string): SlotSemaphore;
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
  /** The window's identity, for {@link WindowCounter.refund}. */
  id: string;
}

/** The last memory window id handed out; ids never repeat in a process. */
let memoryWindowSeq = 0;

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
    const windows = new Map<string, string>();
    for (const key of keys) {
      let entry = this.live(key, at);
      if (add > 0) {
        if (!entry) {
          memoryWindowSeq += 1;
          entry = {
            count: 0,
            expiresAt: at + windowMs,
            marked: false,
            id: String(memoryWindowSeq),
          };
          this.entries.set(key, entry);
        }
        entry.count += add;
      }
      if (entry) windows.set(key, entry.id);
      count = Math.max(count, entry?.count ?? 0);
    }
    return Promise.resolve(
      limited
        ? { limited: true, count, retryAfterMs, windows }
        : { limited: false, count, windows },
    );
  }

  peek(key: string): Promise<WindowState | null> {
    const at = now();
    const entry = this.live(key, at);
    return Promise.resolve(
      entry ? { count: entry.count, resetInMs: entry.expiresAt - at } : null,
    );
  }

  refund(key: string, windowId: string): Promise<void> {
    const entry = this.live(key, now());
    if (entry && entry.id === windowId) entry.count = Math.max(0, entry.count - 1);
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
    this.store(key, entry, ttlMs);
    return Promise.resolve();
  }

  /** Writes an entry, after dropping the expired ones and, at the cap, the oldest. */
  private store(key: string, entry: OneTimeEntry, ttlMs: number): void {
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
  }

  /**
   * Atomic within the process: the check and the write run with no await
   * between them. Unlike `put`, a full store never evicts a live entry for
   * a claim (that would let the evicted key be claimed again): expired
   * entries are swept, and when every one is still live the claim rejects
   * (`ONE_TIME_FULL`), so the caller fails closed as on a store error.
   */
  claim(key: string, ttlMs: number): Promise<boolean> {
    const at = now();
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > at) return Promise.resolve(false);
    if (this.entries.size >= this.maxEntries) {
      for (const [k, e] of this.entries) {
        if (e.expiresAt <= at) this.entries.delete(k);
      }
      if (this.entries.size >= this.maxEntries) {
        return Promise.reject(
          new SharedStoreError("ONE_TIME_FULL", "One-time store full of live entries"),
        );
      }
    }
    this.store(key, { guard: "", value: "" }, ttlMs);
    return Promise.resolve(true);
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
 * Bumped whenever the backend changes: a window id from a take names the
 * store that answered it (this generation's backend, or memory), so a
 * refund never lands on another store.
 */
let backendGeneration = 0;

/**
 * Installs the shared backend (boot, when `REDIS_URL` is set), or `null`
 * to go back to process memory (tests). Stores created earlier switch
 * with it: they look the backend up on every call.
 */
export function useSharedBackend(next: SharedStoreBackend | null): void {
  backend = next;
  backendGeneration += 1;
}

/**
 * The installed backend with its generation, or `null` for process
 * memory: for the stores kept in other modules (`shared-slots.ts`), which
 * tag what they hand out with the generation as the counters do.
 */
export function installedSharedBackend(): {
  backend: SharedStoreBackend;
  generation: number;
} | null {
  return backend ? { backend, generation: backendGeneration } : null;
}

/** Closes the shared backend, if any (graceful shutdown). */
export function closeSharedStore(): void {
  const current = backend;
  backend = null;
  backendGeneration += 1;
  current?.close();
}

/** How often each namespace may log that it fell back to memory. */
const FALLBACK_LOG_INTERVAL_MS = 60_000;

/** Last fallback line per namespace, and how many were held back since. */
const fallbackLogged = new Map<string, { at: number; suppressed: number }>();

/**
 * Logs a store falling back to memory: `error`, at most once a minute
 * per namespace, with the count of the ones held back in between.
 */
export function reportFallback(namespace: string, error: unknown): void {
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

/* ─── Sweep of the in-memory counters ─── */

/** A memory store the sweep prunes: drops what has ended, returns how many. */
interface LocalSweepTarget {
  prune(): number;
}

/**
 * The memory side of every counter {@link sharedWindowCounter} made, and
 * of every semaphore `shared-slots.ts` made. The stores are module
 * constants, so this holds one entry per namespace.
 */
const localCounters = new Set<LocalSweepTarget>();

/** Adds a memory store of another module to the periodic sweep. */
export function addToLocalSweep(target: LocalSweepTarget): void {
  localCounters.add(target);
}

/** How often the sweep drops ended windows from the memory counters. */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** The periodic sweep timer; null when not running. */
let sweepInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Drops the ended windows of every in-memory counter, and the lapsed
 * leases and waiters of every memory semaphore; returns how many.
 * A key's window is dropped when it is next read anyway; the sweep is for
 * keys never seen again (rotating client IPs, deleted API keys, unknown
 * domain ids), which would otherwise stay in the map for good.
 */
export function pruneLocalCounters(): number {
  let removed = 0;
  for (const counter of localCounters) removed += counter.prune();
  return removed;
}

/**
 * Starts the periodic sweep of every in-memory counter (the default
 * store, and the fallback while Redis is down; Redis expires its keys on
 * its own). Idempotent: calling twice is a no-op while it runs.
 */
export function startLocalCounterSweep(): void {
  if (sweepInterval) return;
  sweepInterval = setInterval(() => pruneLocalCounters(), SWEEP_INTERVAL_MS);
  logger.debug("Shared-store memory sweep started", { intervalMs: SWEEP_INTERVAL_MS });
}

/** Stops the periodic sweep: called from the graceful shutdown handler. */
export function stopLocalCounterSweep(): void {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
    logger.debug("Shared-store memory sweep stopped");
  }
}

/**
 * The fixed-window counters of `namespace`: the shared backend's when one
 * is installed, falling back to process memory when it fails (see the
 * module comment), else process memory.
 */
export function sharedWindowCounter(namespace: string): SharedWindowCounter {
  const local = new MemoryWindowCounter();
  localCounters.add(local);
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
  /**
   * Takes on the shared backend, or on `local` without one or when it
   * fails, and prefixes every window id with the store that answered:
   * `s<generation>:` for the backend, `l:` for memory (see `refund`).
   */
  async function take(
    keys: readonly string[],
    options: WindowOptions,
  ): Promise<WindowDecision> {
    const shared = backend;
    if (shared) {
      const generation = backendGeneration;
      try {
        return tagWindows(
          await shared.counter(namespace).take(keys, options),
          `s${generation}:`,
        );
      } catch (error: unknown) {
        reportFallback(namespace, error);
      }
    }
    return tagWindows(await local.take(keys, options), "l:");
  }
  /**
   * Refunds into the store that counted the take, and only there: a take
   * that fell back to memory refunds memory; one the backend answered
   * refunds the backend only while that same backend is installed and
   * answers. Anything else (the backend changed, or fails now) skips the
   * refund: the count stays, which errs on the side of the limit.
   */
  async function refund(key: string, windowId: string): Promise<void> {
    const split = windowId.indexOf(":");
    const store = windowId.slice(0, split);
    const id = windowId.slice(split + 1);
    if (store === "l") return local.refund(key, id);
    const shared = backend;
    if (!shared || store !== `s${backendGeneration}`) return;
    try {
      await shared.counter(namespace).refund(key, id);
    } catch (error: unknown) {
      reportFallback(namespace, error);
    }
  }
  return {
    local,
    take,
    peek: (key) => run((c) => c.peek(key)),
    refund,
    delete: (keys) => run((c) => c.delete(keys)),
    markOnce: (key) => run((c) => c.markOnce(key)),
  };
}

/** The decision with every window id prefixed by `tag`. */
function tagWindows(decision: WindowDecision, tag: string): WindowDecision {
  const windows = new Map<string, string>();
  for (const [key, id] of decision.windows) windows.set(key, `${tag}${id}`);
  return { ...decision, windows };
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
    claim: (key, ttlMs) => store().claim(key, ttlMs),
  };
}
