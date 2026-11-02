import { RedisClient } from "bun";
import { createHash, randomUUID } from "crypto";
import { decryptSecret, encryptSecret } from "./crypto.ts";
import { logger } from "./logger.ts";
import { RedisSlotSemaphore } from "./redis-slots.ts";
import type { SlotSemaphore } from "./shared-slots.ts";
import {
  SharedStoreError,
  sharedStoreErrorCode,
  type OneTimeEntry,
  type OneTimeStore,
  type OneTimeTake,
  type SharedStoreBackend,
  type WindowCounter,
  type WindowDecision,
  type WindowOptions,
  type WindowState,
} from "./shared-store.ts";

/**
 * The Redis (or Valkey) backend of the shared stores (#185), on Bun's
 * built-in client: no dependency. Installed at boot when `REDIS_URL` is
 * set; see `shared-store.ts` for the contracts and the outage behaviour.
 *
 * - **Atomic:** every operation is one Lua script (or one command), so
 *   the check and the count of a rate limit cannot interleave with
 *   another replica's.
 * - **Every key expires:** counters with their window, one-time entries
 *   with their lifetime, semaphore slots with their latest lease
 *   (`redis-slots.ts`). Keys are `<prefix><namespace>:<key>`.
 * - **One-time entries are not readable in Redis:** the key is the
 *   SHA-256 of the token and the value is AES-256-GCM encrypted with
 *   `DKIM_ENCRYPTION_KEY` (the same on every replica), so a dump or a
 *   `MONITOR` of Redis yields neither a redeemable token nor the secret.
 *   The ciphertext is bound to its key and guard (associated data), so
 *   write access to Redis cannot move it into an entry of one's own.
 * - **Fails fast:** no offline queue, a short command timeout, and while
 *   Redis is down a reconnect is tried at most once per backoff step, so a
 *   request waits on a dead Redis for one timeout at most.
 *
 * Redis Cluster is not supported: a limiter checks several keys in one
 * script, which Cluster allows only within one hash slot.
 *
 * TLS (`rediss://`): Bun verifies the server certificate and its host name
 * by default (checked on Bun 1.3.14 against a self-signed server: refused
 * without its CA, accepted with it, refused on a host name mismatch), so
 * no `tls` option is passed. A private CA is trusted with
 * `NODE_EXTRA_CA_CERTS`.
 */

/** How long a connection attempt may take. */
const CONNECT_TIMEOUT_MS = 2_000;

/** How long one command may take before it counts as failed. */
const COMMAND_TIMEOUT_MS = 1_000;

/** First and longest wait between reconnection attempts while Redis is down. */
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 30_000;

/** The key prefix of every BunMail key. */
const DEFAULT_KEY_PREFIX = "bunmail:";

/* ─── Lua scripts ─── */

/**
 * KEYS: the counters. ARGV: max, windowMs, weight, refusedWeight, and the
 * id a window this take starts gets.
 * Returns { limited (0/1), highest count after, retryAfterMs, then each
 * key's window id ('' for a key without a window) }.
 * A counter is a hash: `c` the count, `m` the markOnce flag, `w` the
 * window's id (a refund names it, so it never reaches the next window).
 */
const TAKE_SCRIPT = `
local max = tonumber(ARGV[1])
local win = tonumber(ARGV[2])
local weight = tonumber(ARGV[3])
local refused = tonumber(ARGV[4])
local limited = 0
local retry = 0
for _, key in ipairs(KEYS) do
  local count = tonumber(redis.call('HGET', key, 'c') or '0')
  if count + weight > max then
    limited = 1
    local ttl = redis.call('PTTL', key)
    if ttl < 0 then ttl = win end
    if ttl > retry then retry = ttl end
  end
end
local add = weight
if limited == 1 then add = refused end
local top = 0
local ids = {}
for i, key in ipairs(KEYS) do
  local count
  if add > 0 then
    local fresh = redis.call('EXISTS', key) == 0
    count = redis.call('HINCRBY', key, 'c', add)
    redis.call('HSETNX', key, 'w', ARGV[5])
    if fresh or redis.call('PTTL', key) < 0 then
      redis.call('PEXPIRE', key, win)
    end
  else
    count = tonumber(redis.call('HGET', key, 'c') or '0')
  end
  if count > top then top = count end
  ids[i] = redis.call('HGET', key, 'w') or ''
end
local reply = { limited, top, retry }
for i = 1, #ids do reply[3 + i] = ids[i] end
return reply
`;

/** KEYS[1]: the counter. Returns { count, pttl }, or nil without a window. */
const PEEK_SCRIPT = `
local count = redis.call('HGET', KEYS[1], 'c')
if not count then return nil end
return { tonumber(count), redis.call('PTTL', KEYS[1]) }
`;

/**
 * KEYS[1]: the counter. ARGV[1]: the window id the take returned. One
 * back, never below zero, only while that window is the live one.
 */
const REFUND_SCRIPT = `
if redis.call('HGET', KEYS[1], 'w') == ARGV[1] then
  if redis.call('HINCRBY', KEYS[1], 'c', -1) < 0 then
    redis.call('HSET', KEYS[1], 'c', 0)
  end
end
return 0
`;

/** KEYS[1]: the counter. 1 the first time in a live window, else 0. */
const MARK_ONCE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
return redis.call('HSETNX', KEYS[1], 'm', '1')
`;

/** KEYS[1]: the entry. ARGV: guard, encrypted value, ttlMs. */
const PUT_ONCE_SCRIPT = `
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], 'g', ARGV[1], 'v', ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 1
`;

/**
 * KEYS[1]: the entry. ARGV[1]: the guard presented.
 * Returns { 0 } missing, { 1, guard } mismatch (kept), { 2, value } taken.
 */
const TAKE_ONCE_SCRIPT = `
local guard = redis.call('HGET', KEYS[1], 'g')
if not guard then return { 0 } end
if guard ~= ARGV[1] then return { 1, guard } end
local value = redis.call('HGET', KEYS[1], 'v')
redis.call('DEL', KEYS[1])
return { 2, value }
`;

/**
 * KEYS[1]: the entry. ARGV[1]: ttlMs. 1 when no entry lived under the key
 * and one is now held, 0 when one already lived (a claim or a stored
 * value). A hash like every other one-time entry, holding nothing but a
 * marker.
 */
const CLAIM_ONCE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('HSET', KEYS[1], 'c', '1')
redis.call('PEXPIRE', KEYS[1], ARGV[1])
return 1
`;

/* ─── Connection ─── */

/** The URL without credentials, for logs: `redis://host:port/db`. */
export function describeRedisUrl(url: string): string {
  const parsed = new URL(url);
  const db = parsed.pathname === "/" ? "" : parsed.pathname;
  return `${parsed.protocol}//${parsed.host}${db}`;
}

/** Rejects with a `REDIS_COMMAND_TIMEOUT` error once `ms` have passed. */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new SharedStoreError("REDIS_TIMEOUT", `Redis ${what} timed out`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * One Redis connection, reconnected on demand. Bun's own reconnection
 * gives up for good after a few attempts, so it is off: a command finding
 * the connection down tries to reconnect, at most once per backoff step
 * (500 ms doubling to 30 s), and otherwise fails at once. A command that
 * times out drops the connection, so the next ones do not queue behind a
 * hung server. The outage and the recovery are logged once each.
 */
class RedisConnection {
  private client: RedisClient;
  private connecting: Promise<void> | null = null;
  private retryAt = 0;
  private backoffMs = RECONNECT_MIN_MS;
  private downSince: number | null = null;
  /** False until the first connection: a failed boot is logged by the boot. */
  private everUp = false;
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly target: string,
  ) {
    this.client = this.newClient();
  }

  private newClient(): RedisClient {
    const client = new RedisClient(this.url, {
      autoReconnect: false,
      enableOfflineQueue: false,
      connectionTimeout: CONNECT_TIMEOUT_MS,
    });
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- RedisClient has no addEventListener, only this callback
    client.onclose = () => {
      /** Only the current client's close matters, and not ours at shutdown. */
      if (client === this.client && !this.closed)
        this.markDown("REDIS_CONNECTION_CLOSED");
    };
    return client;
  }

  /** Records the start of an outage: one `error` line per outage. */
  private markDown(code: string): void {
    if (this.downSince !== null) return;
    this.downSince = Date.now();
    if (!this.everUp) return;
    logger.error("Redis connection lost: shared state degraded", {
      target: this.target,
      code,
    });
  }

  /** Records the end of an outage. */
  private markUp(): void {
    this.everUp = true;
    this.backoffMs = RECONNECT_MIN_MS;
    this.retryAt = 0;
    if (this.downSince === null) return;
    logger.info("Redis connection restored", {
      target: this.target,
      downMs: Date.now() - this.downSince,
    });
    this.downSince = null;
  }

  /** Connects, or waits for the attempt in progress; fails at once during backoff. */
  private async ensureConnected(): Promise<void> {
    if (this.closed) throw new SharedStoreError("REDIS_CLOSED", "Redis client closed");
    if (this.client.connected) return;
    if (!this.connecting) {
      if (Date.now() < this.retryAt) {
        throw new SharedStoreError("REDIS_UNAVAILABLE", "Redis is down, retry pending");
      }
      this.connecting = this.client
        .connect()
        .then(() => this.markUp())
        .catch((error: unknown) => {
          this.retryAt = Date.now() + this.backoffMs;
          this.backoffMs = Math.min(this.backoffMs * 2, RECONNECT_MAX_MS);
          this.markDown(sharedStoreErrorCode(error));
          /** A failed client is replaced so the next attempt starts clean. */
          this.client.close();
          this.client = this.newClient();
          throw error;
        })
        .finally(() => {
          this.connecting = null;
        });
    }
    await this.connecting;
  }

  /** Sends one command; the reply is narrowed by the caller. */
  async send(command: string, args: string[]): Promise<unknown> {
    await this.ensureConnected();
    const client = this.client;
    try {
      const reply: unknown = await withTimeout(
        client.send(command, args),
        COMMAND_TIMEOUT_MS,
        command,
      );
      return reply;
    } catch (error: unknown) {
      if (error instanceof SharedStoreError && error.code === "REDIS_TIMEOUT") {
        this.markDown("REDIS_TIMEOUT");
        if (client === this.client) {
          /** Back off like a failed connect, so requests fail fast meanwhile. */
          this.retryAt = Date.now() + this.backoffMs;
          this.backoffMs = Math.min(this.backoffMs * 2, RECONNECT_MAX_MS);
          this.client = this.newClient();
          client.close();
        }
      }
      throw error;
    }
  }

  /** Runs a Lua script with its keys and arguments. */
  eval(
    script: string,
    keys: readonly string[],
    args: readonly string[],
  ): Promise<unknown> {
    return this.send("EVAL", [script, String(keys.length), ...keys, ...args]);
  }

  close(): void {
    this.closed = true;
    this.client.close();
  }
}

/* ─── Reply narrowing ─── */

/** A malformed reply: a bug or a foreign value under our key. */
function badReply(what: string): SharedStoreError {
  return new SharedStoreError("REDIS_BAD_REPLY", `Unexpected Redis reply to ${what}`);
}

/** The reply as an array, or a `REDIS_BAD_REPLY` error. */
function arrayReply(reply: unknown, what: string): unknown[] {
  if (!Array.isArray(reply)) throw badReply(what);
  return reply;
}

/** An integer element of a reply. */
function intAt(items: unknown[], index: number, what: string): number {
  const value = items[index];
  if (typeof value !== "number" || !Number.isInteger(value)) throw badReply(what);
  return value;
}

/** A string element of a reply. */
function stringAt(items: unknown[], index: number, what: string): string {
  const value = items[index];
  if (typeof value !== "string") throw badReply(what);
  return value;
}

/* ─── Stores ─── */

/** {@link WindowCounter} in Redis: one hash per key, expiring with its window. */
class RedisWindowCounter implements WindowCounter {
  constructor(
    private readonly connection: RedisConnection,
    private readonly prefix: string,
  ) {}

  private key(key: string): string {
    return `${this.prefix}${key}`;
  }

  async take(keys: readonly string[], options: WindowOptions): Promise<WindowDecision> {
    const { max, windowMs, weight = 1, refusedWeight = 0 } = options;
    const reply = arrayReply(
      await this.connection.eval(
        TAKE_SCRIPT,
        keys.map((k) => this.key(k)),
        [
          String(max),
          String(windowMs),
          String(weight),
          String(refusedWeight),
          randomUUID(),
        ],
      ),
      "take",
    );
    const count = intAt(reply, 1, "take");
    const windows = new Map<string, string>();
    keys.forEach((key, i) => {
      const id = stringAt(reply, 3 + i, "take");
      if (id !== "") windows.set(key, id);
    });
    return intAt(reply, 0, "take") === 1
      ? { limited: true, count, retryAfterMs: intAt(reply, 2, "take"), windows }
      : { limited: false, count, windows };
  }

  async peek(key: string): Promise<WindowState | null> {
    const reply: unknown = await this.connection.eval(PEEK_SCRIPT, [this.key(key)], []);
    if (reply === null) return null;
    const items = arrayReply(reply, "peek");
    const resetInMs = intAt(items, 1, "peek");
    /** A key past its expiry that Redis has not dropped yet counts as gone. */
    return resetInMs > 0 ? { count: intAt(items, 0, "peek"), resetInMs } : null;
  }

  async refund(key: string, windowId: string): Promise<void> {
    await this.connection.eval(REFUND_SCRIPT, [this.key(key)], [windowId]);
  }

  async delete(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.connection.send(
      "DEL",
      keys.map((k) => this.key(k)),
    );
  }

  async markOnce(key: string): Promise<boolean> {
    const reply: unknown = await this.connection.eval(
      MARK_ONCE_SCRIPT,
      [this.key(key)],
      [],
    );
    return reply === 1;
  }
}

/** {@link OneTimeStore} in Redis: hashed keys, encrypted values. */
class RedisOneTimeStore implements OneTimeStore {
  constructor(
    private readonly connection: RedisConnection,
    private readonly prefix: string,
    private readonly secretKey: Buffer,
  ) {}

  /** The token is a secret: only its SHA-256 names the Redis key. */
  private key(key: string): string {
    return `${this.prefix}${createHash("sha256").update(key).digest("hex")}`;
  }

  /**
   * What a value's ciphertext is bound to (AES-GCM associated data): its
   * Redis key and its guard. Someone able to write to Redis cannot move a
   * victim's ciphertext into an entry of their own (another key or
   * another owner): it no longer decrypts.
   */
  private static binding(redisKey: string, guard: string): string {
    return JSON.stringify([redisKey, guard]);
  }

  async put(key: string, entry: OneTimeEntry, ttlMs: number): Promise<void> {
    const redisKey = this.key(key);
    const encrypted = encryptSecret(
      entry.value,
      this.secretKey,
      RedisOneTimeStore.binding(redisKey, entry.guard),
    );
    await this.connection.eval(
      PUT_ONCE_SCRIPT,
      [redisKey],
      [entry.guard, encrypted, String(ttlMs)],
    );
  }

  async take(key: string, guard: string): Promise<OneTimeTake> {
    const redisKey = this.key(key);
    const reply = arrayReply(
      await this.connection.eval(TAKE_ONCE_SCRIPT, [redisKey], [guard]),
      "take once",
    );
    const status = intAt(reply, 0, "take once");
    if (status === 0) return { status: "missing" };
    if (status === 1)
      return { status: "mismatch", guard: stringAt(reply, 1, "take once") };
    const encrypted = stringAt(reply, 1, "take once");
    try {
      const binding = RedisOneTimeStore.binding(redisKey, guard);
      return {
        status: "taken",
        value: decryptSecret(encrypted, this.secretKey, binding),
      };
    } catch {
      /**
       * Stored by a replica with another DKIM_ENCRYPTION_KEY, or moved here
       * from another key or owner: unreadable, so nothing is shown.
       */
      throw new SharedStoreError(
        "ONE_TIME_UNDECRYPTABLE",
        "One-time entry does not decrypt for this key and owner",
      );
    }
  }

  /** The key is hashed like a token's, and nothing else is stored. */
  async claim(key: string, ttlMs: number): Promise<boolean> {
    const reply: unknown = await this.connection.eval(
      CLAIM_ONCE_SCRIPT,
      [this.key(key)],
      [String(Math.max(1, Math.trunc(ttlMs)))],
    );
    if (reply !== 0 && reply !== 1) throw badReply("claim once");
    return reply === 1;
  }
}

/** Options of {@link connectRedisBackend}. */
interface RedisBackendOptions {
  /** 32-byte key that encrypts one-time values (`DKIM_ENCRYPTION_KEY`). */
  secretKey: Buffer;
  /** Prefix of every key (default `bunmail:`); tests use their own. */
  keyPrefix?: string;
}

/**
 * Connects to Redis and returns the backend, or throws when Redis does not
 * answer a `PING` (the boot then refuses to start, like a database it
 * cannot reach). Logs the target without credentials.
 */
export async function connectRedisBackend(
  url: string,
  options: RedisBackendOptions,
): Promise<SharedStoreBackend> {
  const target = describeRedisUrl(url);
  const prefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const connection = new RedisConnection(url, target);
  try {
    const pong = await connection.send("PING", []);
    if (pong !== "PONG") throw badReply("PING");
  } catch (error: unknown) {
    connection.close();
    const code = sharedStoreErrorCode(error);
    logger.error("[boot] Redis did not answer: refusing to start", {
      target,
      code,
      hint: "Check REDIS_URL and that Redis is reachable from this container",
    });
    throw new SharedStoreError(code, `Redis at ${target} did not answer (${code})`);
  }
  logger.info("Shared state in Redis: several replicas share limits and reveals", {
    target,
  });
  const counters = new Map<string, WindowCounter>();
  const oneTimes = new Map<string, OneTimeStore>();
  const slots = new Map<string, SlotSemaphore>();
  return {
    counter(namespace) {
      let counter = counters.get(namespace);
      if (!counter) {
        counter = new RedisWindowCounter(connection, `${prefix}${namespace}:`);
        counters.set(namespace, counter);
      }
      return counter;
    },
    oneTime(namespace) {
      let store = oneTimes.get(namespace);
      if (!store) {
        store = new RedisOneTimeStore(
          connection,
          `${prefix}${namespace}:`,
          options.secretKey,
        );
        oneTimes.set(namespace, store);
      }
      return store;
    },
    slots(namespace) {
      let semaphore = slots.get(namespace);
      if (!semaphore) {
        semaphore = new RedisSlotSemaphore(connection, `${prefix}${namespace}:`);
        slots.set(namespace, semaphore);
      }
      return semaphore;
    },
    close: () => connection.close(),
  };
}
