/** A Redis logical database in a URL path: `/0` to `/99`, or none. */
const REDIS_DB_PATH_RE = /^\/?(\d{1,2})?$/;

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
