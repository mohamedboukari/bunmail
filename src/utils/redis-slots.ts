import { SharedStoreError } from "./shared-store.ts";
import type { SlotOptions, SlotSemaphore } from "./shared-slots.ts";

/**
 * The Redis side of the leased-slot semaphores (#185, `shared-slots.ts`),
 * used by the Redis backend (`redis-store.ts`).
 *
 * Three sorted sets per key, `<prefix><key>:h|q|w`:
 * - `h` the holders, scored by the end of their lease;
 * - `q` the line of waiters, scored by when each one first asked (one
 *   more than the last when two ask in the same millisecond, so the
 *   order is strictly the order of arrival);
 * - `w` the same waiters, scored by when their place lapses.
 *
 * Every script reads the time from Redis (`TIME`), never from a replica,
 * so clock skew between replicas cannot stretch or cut a lease. Each one
 * first drops the lapsed holders and waiters, so a crashed replica's
 * slots and places free themselves, and every key expires with its latest
 * entry: nothing is left behind once nobody asks.
 */

/**
 * Shared head of every script: `now` from the server clock (ms) and
 * `expire(key, scores)`, which sets `key` to expire with the highest
 * score of `scores`. Redis 5+ replicates script effects, so `TIME` may
 * precede writes.
 */
const PRELUDE = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local function expire(key, scores)
  local top = redis.call('ZRANGE', scores, -1, -1, 'WITHSCORES')
  if top[2] then
    redis.call('PEXPIRE', key, math.max(1, tonumber(top[2]) - now))
  end
end
`;

/**
 * KEYS: holders, line, places. ARGV: holder, max, leaseMs, queueTtlMs.
 * 1 when granted (or renewed, for a holder asking again), 0 when in line.
 */
const ACQUIRE_SCRIPT = `${PRELUDE}
local holder = ARGV[1]
local max = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
for _, gone in ipairs(redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', now)) do
  redis.call('ZREM', KEYS[2], gone)
end
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now)
local granted = redis.call('ZSCORE', KEYS[1], holder) ~= false
if not granted then
  local free = max - redis.call('ZCARD', KEYS[1])
  if free > 0 then
    local ahead = redis.call('ZRANK', KEYS[2], holder)
    if ahead == false then ahead = redis.call('ZCARD', KEYS[2]) end
    granted = ahead < free
  end
end
if granted then
  redis.call('ZADD', KEYS[1], now + tonumber(ARGV[3]), holder)
  redis.call('ZREM', KEYS[2], holder)
  redis.call('ZREM', KEYS[3], holder)
else
  if redis.call('ZSCORE', KEYS[2], holder) == false then
    local arrival = now
    local last = redis.call('ZRANGE', KEYS[2], -1, -1, 'WITHSCORES')
    if last[2] and tonumber(last[2]) >= arrival then arrival = tonumber(last[2]) + 1 end
    redis.call('ZADD', KEYS[2], arrival, holder)
  end
  redis.call('ZADD', KEYS[3], now + tonumber(ARGV[4]), holder)
end
expire(KEYS[1], KEYS[1])
expire(KEYS[2], KEYS[3])
expire(KEYS[3], KEYS[3])
if granted then return 1 end
return 0
`;

/** KEYS[1]: holders. ARGV: holder, leaseMs. 1 renewed, 0 when it holds no live lease. */
const RENEW_SCRIPT = `${PRELUDE}
local lease = redis.call('ZSCORE', KEYS[1], ARGV[1])
if lease == false then return 0 end
if tonumber(lease) <= now then
  redis.call('ZREM', KEYS[1], ARGV[1])
  return 0
end
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[1])
expire(KEYS[1], KEYS[1])
return 1
`;

/** KEYS: holders, line, places. ARGV[1]: holder. Removes it from all three. */
const RELEASE_SCRIPT = `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
return 0
`;

/** What the semaphore needs of the Redis connection. */
export interface RedisScriptRunner {
  eval(
    script: string,
    keys: readonly string[],
    args: readonly string[],
  ): Promise<unknown>;
}

/** A 0/1 reply as a boolean, or a `REDIS_BAD_REPLY` error. */
function flag(reply: unknown, what: string): boolean {
  if (reply !== 0 && reply !== 1) {
    throw new SharedStoreError("REDIS_BAD_REPLY", `Unexpected Redis reply to ${what}`);
  }
  return reply === 1;
}

/** A duration as a whole number of ms, at least 1, for a script argument. */
function ms(value: number): string {
  return String(Math.max(1, Math.trunc(value)));
}

/** {@link SlotSemaphore} in Redis: three sorted sets per key, see the module comment. */
export class RedisSlotSemaphore implements SlotSemaphore {
  constructor(
    private readonly connection: RedisScriptRunner,
    private readonly prefix: string,
  ) {}

  /** The holders, line and places keys of `key`. */
  private keys(key: string): string[] {
    const base = `${this.prefix}${key}`;
    return [`${base}:h`, `${base}:q`, `${base}:w`];
  }

  async acquire(key: string, holder: string, options: SlotOptions): Promise<boolean> {
    return flag(
      await this.connection.eval(ACQUIRE_SCRIPT, this.keys(key), [
        holder,
        String(Math.max(0, Math.trunc(options.max))),
        ms(options.leaseMs),
        ms(options.queueTtlMs),
      ]),
      "slot acquire",
    );
  }

  async renew(key: string, holder: string, leaseMs: number): Promise<boolean> {
    const holders = this.keys(key).slice(0, 1);
    return flag(
      await this.connection.eval(RENEW_SCRIPT, holders, [holder, ms(leaseMs)]),
      "slot renew",
    );
  }

  async release(key: string, holder: string): Promise<void> {
    await this.connection.eval(RELEASE_SCRIPT, this.keys(key), [holder]);
  }
}
