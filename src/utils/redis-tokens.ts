import { SharedStoreError } from "./shared-store.ts";
import type { TokenBucketStore, TokenGrant, TokenRate } from "./shared-tokens.ts";

/**
 * The Redis side of the shared token buckets (#391, `shared-tokens.ts`),
 * used by the Redis backend (`redis-store.ts`).
 *
 * One hash per bucket, `<prefix><key>`: `t` its tokens and `a` when they
 * were counted (ms). The script is the memory implementation's arithmetic
 * line for line, timed by the Redis clock (`TIME`), never a replica's, so
 * clock skew between replicas cannot mint tokens. The key expires when the
 * bucket would be full again: a missing bucket is a full one, so nothing
 * is lost and an idle bucket leaves nothing behind.
 */

/**
 * KEYS[1]: the bucket. ARGV: count, capacity, perMinute.
 * Returns { granted, waitMs }. Values are stored with 17 significant
 * digits, so a fraction of a token survives the round trip exactly.
 */
const TAKE_TOKENS_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local count = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
local perMs = tonumber(ARGV[3]) / 60000
local state = redis.call('HMGET', KEYS[1], 't', 'a')
local tokens = cap
if state[1] and state[2] then
  local elapsed = math.max(0, now - tonumber(state[2]))
  tokens = math.min(cap, tonumber(state[1]) + elapsed * perMs)
end
local granted = math.max(0, math.min(count, math.floor(tokens)))
tokens = tokens - granted
redis.call('HSET', KEYS[1], 't', string.format('%.17g', tokens), 'a', string.format('%.17g', now))
redis.call('PEXPIRE', KEYS[1], math.max(1, math.ceil((cap - tokens) / perMs)))
local wait = 0
if granted < count then wait = math.ceil((1 - tokens) / perMs) end
return { granted, wait }
`;

/** What the buckets need of the Redis connection. */
interface RedisScriptRunner {
  eval(
    script: string,
    keys: readonly string[],
    args: readonly string[],
  ): Promise<unknown>;
}

/** A whole number, at least `min`, for a script argument. */
function whole(value: number, min: number): string {
  return String(Math.max(min, Math.trunc(value)));
}

/** A refill rate for a script argument: as given (fractions too), never 0 or less. */
function positive(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    throw new SharedStoreError(
      "TOKEN_RATE_INVALID",
      "Token refill rate must be positive",
    );
  }
  return String(value);
}

/** {@link TokenBucketStore} in Redis: one hash per bucket, see the module comment. */
export class RedisTokenBuckets implements TokenBucketStore {
  constructor(
    private readonly connection: RedisScriptRunner,
    private readonly prefix: string,
  ) {}

  async take(key: string, count: number, rate: TokenRate): Promise<TokenGrant> {
    const reply: unknown = await this.connection.eval(
      TAKE_TOKENS_SCRIPT,
      [`${this.prefix}${key}`],
      [whole(count, 0), whole(rate.capacity, 1), positive(rate.perMinute)],
    );
    if (!Array.isArray(reply)) throw badReply();
    const [granted, waitMs]: unknown[] = reply;
    if (
      typeof granted !== "number" ||
      typeof waitMs !== "number" ||
      !Number.isInteger(granted) ||
      !Number.isInteger(waitMs)
    ) {
      throw badReply();
    }
    return { granted, waitMs };
  }
}

/** A malformed reply: a bug or a foreign value under our key. */
function badReply(): SharedStoreError {
  return new SharedStoreError("REDIS_BAD_REPLY", "Unexpected Redis reply to token take");
}
