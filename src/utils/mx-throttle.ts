/**
 * Per-provider concurrency throttle for outbound SMTP delivery.
 *
 * Direct-to-MX delivery means BunMail is the sender's MTA, and strict
 * receivers (Outlook, Yahoo) will reject parallel sessions from the
 * same source IP with `421 Too many concurrent SMTP connections`. ESPs
 * hide this from their customers by pooling at the IP level; a
 * self-hosted MTA has to do its own throttling.
 *
 * The throttle is a counting semaphore per key, kept in module-level
 * state. The mailer keys it by the provider bucket of the MX host it
 * connects to (#250, `provider-bucket.ts`: every Microsoft MX is one
 * bucket, every Google MX another, any other MX its registrable domain),
 * so two host names of one provider share the limit. It holds **across
 * poll cycles**: back-to-back batches that both hit the same bucket still
 * serialize, which is the whole point. Sends to different buckets use
 * disjoint semaphores and proceed in parallel. (#91)
 *
 * Concurrency is set per-call by the mailer service (which reads
 * `config.mail.mxConcurrency`); this module stays config-agnostic so
 * unit tests can drive scenarios directly without a config shim.
 */

interface MxLock {
  /** Slots currently held by callers running `fn`. */
  active: number;
  /** FIFO queue of resolvers waiting for a slot. */
  queue: Array<() => void>;
}

/**
 * Module-level lock table. One entry per key (provider bucket) in use.
 * Entries are deleted when they drain to zero so the map can't grow
 * unbounded under churn (e.g. a long tail of unique receiver MXs).
 */
const locks = new Map<string, MxLock>();

/**
 * Runs `fn` while holding a slot on the semaphore of `key` (a provider
 * bucket). Awaits acquisition when all `max` slots are already held; the
 * wait is FIFO.
 *
 * The lock is released in a `finally`, so a thrown error still wakes
 * the next waiter: a hung MX won't deadlock the queue forever, since
 * the transport's own socket timeout kicks in inside `fn`.
 *
 * **Slot accounting (subtle).** Releases hand off the slot directly to
 * the next waiter rather than decrementing `active` and re-incrementing
 * it from the waiter's side. That keeps `active` consistent with the
 * actual number of in-flight `fn` calls + just-woken-but-not-yet-running
 * callers, with no window where a slot is "free" but a waiter hasn't
 * grabbed it yet. The cleanup branch (`locks.delete`) only fires when
 * the entry has zero active and zero waiting, so a race with a fresh
 * acquire on the same key can't mistakenly drop a live lock.
 */
export async function withMxLock<T>(
  key: string,
  max: number,
  fn: () => Promise<T>,
): Promise<T> {
  let lock = locks.get(key);
  if (!lock) {
    lock = { active: 0, queue: [] };
    locks.set(key, lock);
  }

  if (lock.active < max) {
    lock.active++;
  } else {
    /** All slots taken: wait FIFO. The resolver is "handed" a slot
     *  by a releasing caller; we don't increment `active` here because
     *  the releaser left it unchanged when it handed off. */
    await new Promise<void>((resolve) => {
      lock.queue.push(resolve);
    });
  }

  try {
    return await fn();
  } finally {
    const next = lock.queue.shift();
    if (next) {
      /** Pass the slot to the next waiter: `active` stays the same. */
      next();
    } else {
      lock.active--;
    }
    if (lock.active === 0 && lock.queue.length === 0) {
      locks.delete(key);
    }
  }
}

/**
 * Test-only inspection of the current lock state for a given key.
 * Returns `undefined` when no callers are using that key (i.e. the
 * entry has been GC'd from the map).
 */
export function _inspectLock(
  key: string,
): { active: number; waiting: number } | undefined {
  const lock = locks.get(key);
  if (!lock) return undefined;
  return { active: lock.active, waiting: lock.queue.length };
}

/**
 * Test-only reset of all locks. Used between tests to keep module
 * state isolated since `bun test` shares module instances within a file.
 */
export function _resetLocks(): void {
  locks.clear();
}
