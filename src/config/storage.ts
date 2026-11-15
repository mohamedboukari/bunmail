import { optionalBoundedInt } from "./env.ts";

/** A Redis logical database in a URL path: `/0` to `/99`, or none. */
const REDIS_DB_PATH_RE = /^\/?(\d{1,2})?$/;

/** Bun's own default pool size, kept when `DATABASE_POOL_MAX` is unset. */
const DEFAULT_DATABASE_POOL_MAX = 10;

/** Upper bound for `DATABASE_POOL_MAX`: well past any sane single process. */
const MAX_DATABASE_POOL_MAX = 1000;

/**
 * Reads `DATABASE_POOL_MAX` (#423): the most PostgreSQL connections the
 * app's pool opens. Unset or blank keeps Bun's default of 10; anything
 * other than a whole number from 1 to 1000 refuses to boot.
 *
 * What it is for: sizing the pool to the load (queries past it wait for
 * a free connection) and keeping the app, times its replicas, within
 * Postgres's `max_connections`. It was added for a Bun 1.3.14 bug (#423):
 * a burst of more concurrent queries than the pool had connections, some
 * of them statements a connection had not prepared yet, could stall the
 * pool (oven-sh/bun#32004, #33627, #34756, #35114). Bun 1.4.4 fixed it
 * (#447), so a queueing pool is safe now. The integration tests set it
 * (`test/integration/_preload.ts`). Exported for tests.
 */
export function readDatabasePoolMax(
  raw: string | undefined = process.env["DATABASE_POOL_MAX"],
): number {
  return optionalBoundedInt(
    "DATABASE_POOL_MAX",
    DEFAULT_DATABASE_POOL_MAX,
    1,
    MAX_DATABASE_POOL_MAX,
    raw,
  );
}

/**
 * Reads `REDIS_URL` (#185): where the state shared by several replicas
 * lives (rate limits, login throttles, one-time reveals). Unset or blank
 * keeps that state in process memory (one replica). Anything else must be
 * a `redis://` or `rediss://` (TLS) URL with a host, an optional user and
 * password, an optional database number as the path and no query, or the
 * server refuses to boot. The URL can carry a password, so neither this
 * error nor any log line ever repeats it. Exported for tests.
 */
export function readRedisUrl(
  raw: string | undefined = process.env["REDIS_URL"],
): string | null {
  const value = raw?.trim() ?? "";
  if (value === "") return null;
  const problem = (): Error =>
    new Error(
      "[config] REDIS_URL must be a redis:// or rediss:// URL with a host, such as redis://redis:6379 or rediss://:password@redis.example.com:6380/0.\n" +
        "  → Leave it empty to keep the shared state in memory (a single replica).",
    );
  if (!URL.canParse(value)) throw problem();
  const url = new URL(value);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") throw problem();
  if (url.hostname === "" || url.search !== "" || url.hash !== "") throw problem();
  if (!REDIS_DB_PATH_RE.test(url.pathname)) throw problem();
  return value;
}
