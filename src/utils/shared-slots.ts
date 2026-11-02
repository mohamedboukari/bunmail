import {
  addToLocalSweep,
  installedSharedBackend,
  reportFallback,
} from "./shared-store.ts";

/**
 * Counting semaphores whose slots are leases (#185): at most `max`
 * holders per key at once, across every replica sharing the store. The
 * per-MX session limit (`mx-throttle.ts`) rests on it.
 *
 * - **Leases, not locks:** a slot is held until its holder releases it or
 *   its lease runs out, so a replica that crashes mid-session frees its
 *   slots within one lease. A holder of a long session renews its lease.
 * - **First come, first served across replicas:** an acquire that finds no
 *   free slot puts its holder in line and returns false; the holder asks
 *   again (polling) and gets a freed slot only when no live waiter came
 *   before it, so a replica with a backlog cannot keep a slot to itself.
 *   A place in line lapses when its holder stops asking (`queueTtlMs`).
 * - **Holder ids are unique per acquisition** and never reused, so a late
 *   release or renewal can only ever touch its own slot.
 *
 * The memory implementation is exact for one replica; the Redis one lives
 * in `redis-slots.ts`. {@link sharedSlotSemaphore} picks between them and
 * falls back to memory during an outage, like the counters.
 */

/* ─── Contract ─── */

/** The limit an {@link SlotSemaphore.acquire} enforces. */
export interface SlotOptions {
  /** Most holders of one key at once. */
  max: number;
  /** How long a granted slot lives unless renewed. */
  leaseMs: number;
  /** How long a refused holder keeps its place in line without asking again. */
  queueTtlMs: number;
}

/** Counting semaphores with leased slots; every operation is atomic. */
export interface SlotSemaphore {
  /**
   * Grants `holder` a slot of `key` (true) when fewer than `max` live
   * leases are held and no live waiter is ahead of it in line, else puts
   * it in line, or keeps its place, and returns false. Asking again while
   * holding renews the lease.
   */
  acquire(key: string, holder: string, options: SlotOptions): Promise<boolean>;
  /** Extends the holder's live lease to `leaseMs` from now; false when it holds none. */
  renew(key: string, holder: string, leaseMs: number): Promise<boolean>;
  /** Frees the holder's slot and its place in line; a no-op for anyone else. */
  release(key: string, holder: string): Promise<void>;
}

/* ─── In memory (one replica) ─── */

/** The clock of the memory semaphore; tests move it with `setSystemTime`. */
const now = (): number => Date.now();

/** One key's slots in memory. */
interface MemorySlots {
  /** Lease end (Unix epoch ms) by holder. */
  holders: Map<string, number>;
  /** Waiters in arrival order, with when each one's place lapses (epoch ms). */
  queue: Map<string, number>;
}

/** {@link SlotSemaphore} in process memory: exact for one replica. */
export class MemorySlotSemaphore implements SlotSemaphore {
  /** Keys with a live holder or waiter. Tests may read it. */
  readonly entries = new Map<string, MemorySlots>();

  /** The key's slots without lapsed leases and places; created when missing. */
  private live(key: string, at: number): MemorySlots {
    let slots = this.entries.get(key);
    if (!slots) {
      slots = { holders: new Map(), queue: new Map() };
      this.entries.set(key, slots);
    }
    MemorySlotSemaphore.drop(slots, at);
    return slots;
  }

  /** Drops lapsed leases and places; returns how many. */
  private static drop(slots: MemorySlots, at: number): number {
    let removed = 0;
    for (const map of [slots.holders, slots.queue]) {
      for (const [holder, until] of map) {
        if (until <= at) {
          map.delete(holder);
          removed += 1;
        }
      }
    }
    return removed;
  }

  /** Forgets a key left without holders and waiters. */
  private tidy(key: string, slots: MemorySlots): void {
    if (slots.holders.size === 0 && slots.queue.size === 0) this.entries.delete(key);
  }

  acquire(key: string, holder: string, options: SlotOptions): Promise<boolean> {
    const at = now();
    const slots = this.live(key, at);
    let granted = slots.holders.has(holder);
    if (!granted) {
      const free = options.max - slots.holders.size;
      if (free > 0) {
        const index = [...slots.queue.keys()].indexOf(holder);
        granted = (index === -1 ? slots.queue.size : index) < free;
      }
    }
    if (granted) {
      slots.holders.set(holder, at + options.leaseMs);
      slots.queue.delete(holder);
    } else {
      /** `set` on a waiter keeps its place: a Map keeps insertion order. */
      slots.queue.set(holder, at + options.queueTtlMs);
    }
    return Promise.resolve(granted);
  }

  renew(key: string, holder: string, leaseMs: number): Promise<boolean> {
    const slots = this.entries.get(key);
    if (!slots) return Promise.resolve(false);
    const at = now();
    MemorySlotSemaphore.drop(slots, at);
    const held = slots.holders.has(holder);
    if (held) slots.holders.set(holder, at + leaseMs);
    this.tidy(key, slots);
    return Promise.resolve(held);
  }

  release(key: string, holder: string): Promise<void> {
    const slots = this.entries.get(key);
    if (slots) {
      slots.holders.delete(holder);
      slots.queue.delete(holder);
      this.tidy(key, slots);
    }
    return Promise.resolve();
  }

  /** Drops every lapsed lease and place, and the keys left empty; returns how many. */
  prune(): number {
    const at = now();
    let removed = 0;
    for (const [key, slots] of this.entries) {
      removed += MemorySlotSemaphore.drop(slots, at);
      this.tidy(key, slots);
    }
    return removed;
  }
}

/* ─── Backend selection ─── */

/** What became of a {@link SharedSlotSemaphore.renew}. */
export type SlotRenewal =
  /** The lease was extended. */
  | "renewed"
  /** The holder no longer holds the slot (released, lapsed, or the backend changed). */
  | "lost"
  /** The store did not answer; the lease may still be live, so try again later. */
  | "unavailable";

/** A semaphore that also exposes its in-memory side (the outage fallback). */
export interface SharedSlotSemaphore {
  /** The process-memory semaphore: the fallback during an outage. */
  readonly local: MemorySlotSemaphore;
  /**
   * True while a shared backend is installed. Without one a caller keeps
   * its own in-process limit and has nothing to share, so it skips this.
   */
  isShared(): boolean;
  /**
   * {@link SlotSemaphore.acquire} on the shared backend, or on `local`
   * without one or when it fails. Resolves to the grant (which store
   * answered: `s<generation>` or `l`, for `renew` and `release`), or
   * `null` when the holder must wait and ask again. Never rejects.
   */
  acquire(key: string, holder: string, options: SlotOptions): Promise<string | null>;
  /** Renews in the store of `grant`, only while it is still installed. Never rejects. */
  renew(
    key: string,
    holder: string,
    grant: string,
    leaseMs: number,
  ): Promise<SlotRenewal>;
  /**
   * Releases in the store of `grant`, only while it is still installed:
   * anything else leaves the slot to lapse with its lease. Never rejects.
   */
  release(key: string, holder: string, grant: string): Promise<void>;
}

/**
 * The counting semaphores of `namespace`: the shared backend's when one is
 * installed, falling back to process memory when it fails (logged once a
 * minute per namespace, like the counters), else process memory.
 */
export function sharedSlotSemaphore(namespace: string): SharedSlotSemaphore {
  const local = new MemorySlotSemaphore();
  addToLocalSweep(local);

  /** The backend's semaphore while `grant` names the installed backend, else null. */
  function storeOf(grant: string): SlotSemaphore | null {
    if (grant === "l") return local;
    const installed = installedSharedBackend();
    if (!installed || grant !== `s${installed.generation}`) return null;
    return installed.backend.slots(namespace);
  }

  async function acquire(
    key: string,
    holder: string,
    options: SlotOptions,
  ): Promise<string | null> {
    const installed = installedSharedBackend();
    if (installed) {
      const store = installed.backend.slots(namespace);
      try {
        return (await store.acquire(key, holder, options))
          ? `s${installed.generation}`
          : null;
      } catch (error: unknown) {
        reportFallback(namespace, error);
        /**
         * The acquire may have been granted before its reply was lost (a
         * timeout): give that slot back now rather than after its lease.
         * Best effort, the failure was just logged; the lease bounds it.
         */
        void store.release(key, holder).catch(() => undefined);
      }
    }
    return (await local.acquire(key, holder, options)) ? "l" : null;
  }

  async function renew(
    key: string,
    holder: string,
    grant: string,
    leaseMs: number,
  ): Promise<SlotRenewal> {
    const store = storeOf(grant);
    if (!store) return "lost";
    try {
      return (await store.renew(key, holder, leaseMs)) ? "renewed" : "lost";
    } catch (error: unknown) {
      reportFallback(namespace, error);
      return "unavailable";
    }
  }

  async function release(key: string, holder: string, grant: string): Promise<void> {
    const store = storeOf(grant);
    if (!store) return;
    try {
      await store.release(key, holder);
    } catch (error: unknown) {
      reportFallback(namespace, error);
    }
  }

  return {
    local,
    isShared: () => installedSharedBackend() !== null,
    acquire,
    renew,
    release,
  };
}
