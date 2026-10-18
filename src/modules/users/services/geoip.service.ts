import { Reader, type Response as MmdbResponse } from "mmdb-lib";
import { config, type GeoipSettings } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";
import { isBlockedIp } from "../../../utils/ssrf-guard.ts";

/**
 * Approximate location of an IP address for the Active sessions page
 * (#281): "City, Country" or "Country". Off unless the operator
 * configured a source (`config.geoip`):
 *
 * - **Offline** (`GEOIP_DB_PATH`): a DB-IP Lite or MaxMind GeoLite2
 *   City/Country `.mmdb` file, read once into memory with `mmdb-lib`.
 *   No third party sees any address. A missing or unreadable file logs
 *   one `warn` at first use and turns location off until the restart;
 *   it never stops the server or a login.
 * - **Online, opt-in** (`GEOIP_PROVIDER=ipinfo`): ipinfo.io's free Lite
 *   API over HTTPS, which answers with the country. Every sign-in IP is
 *   sent to ipinfo. A 3 second timeout, a capped response, and the JSON
 *   checked field by field.
 *
 * Private, loopback, link-local and reserved addresses are never looked
 * up (`isBlockedIp`). The result is approximate: a VPN or proxy shows the
 * VPN's location. Never logs the provider token.
 */

/** `sessions.location` is `varchar(128)`. */
const LOCATION_MAX_LENGTH = 128;

/** How long an online lookup may take before it is abandoned. */
export const GEOIP_TIMEOUT_MS = 3000;

/** Largest provider response read; a real answer is a few hundred bytes. */
export const GEOIP_MAX_RESPONSE_BYTES = 16 * 1024;

/** One looked-up record of an `.mmdb` file (shape unchecked). */
export type MmdbLookup = (ip: string) => unknown;

/** The `fetch` the online lookup uses, injectable for tests. */
export type GeoipFetch = (url: string, init: RequestInit) => Promise<Response>;

/** True for a non-null, non-array object. */
function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `value[key]` when `value` is an object, else `undefined`. */
function field(value: unknown, key: string): unknown {
  return isObject(value) ? Reflect.get(value, key) : undefined;
}

/**
 * A place name as stored: trimmed, control characters dropped, inner
 * whitespace collapsed; `null` when nothing is left or it is not a string.
 */
function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned === "" ? null : cleaned;
}

/**
 * The stored label: "City, Country", or "Country" when the city is
 * unknown; `null` without a country (a city alone is too ambiguous to
 * show). Cut to the column width in code points, never splitting a
 * surrogate pair.
 */
export function formatLocation(city: unknown, country: unknown): string | null {
  const countryName = cleanName(country);
  if (!countryName) return null;
  const cityName = cleanName(city);
  const label = cityName ? `${cityName}, ${countryName}` : countryName;
  return Array.from(label).slice(0, LOCATION_MAX_LENGTH).join("");
}

/**
 * The label of an `.mmdb` record (DB-IP Lite and GeoLite2 City/Country
 * share the layout: `city.names.en`, `country.names.en`). Checked field
 * by field: the file is operator-supplied data, not a type guarantee.
 */
export function locationFromMmdbRecord(record: unknown): string | null {
  return formatLocation(
    field(field(field(record, "city"), "names"), "en"),
    field(field(field(record, "country"), "names"), "en"),
  );
}

/**
 * The label of an ipinfo answer. The Lite API returns `country` (a
 * name) and no city; a `city` field, which richer plans add, is used
 * when present.
 */
export function locationFromIpinfo(body: unknown): string | null {
  return formatLocation(field(body, "city"), field(body, "country"));
}

/**
 * Loads an `.mmdb` file into memory and returns its lookup. Throws when
 * the file is missing or is not a MaxMind DB (the caller logs it and
 * turns location off).
 */
export async function loadMmdbLookup(path: string): Promise<MmdbLookup> {
  const buffer = Buffer.from(await Bun.file(path).arrayBuffer());
  const reader = new Reader<MmdbResponse>(buffer);
  return (ip) => reader.get(ip);
}

/**
 * Reads at most `max` bytes of a response body as text; throws when the
 * body is longer, so a misbehaving endpoint cannot make us buffer it.
 */
async function readCapped(response: Response, max: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > max) throw new Error("GeoIP response too large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new Error("GeoIP response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Asks ipinfo's Lite API (HTTPS only, free tier) for the location of
 * `ip`. Throws on a timeout, a network error, a non-2xx answer, an
 * oversized answer or invalid JSON; the messages never carry the URL,
 * which holds the token.
 */
export async function fetchIpinfoLocation(
  ip: string,
  token: string,
  fetchImpl: GeoipFetch = fetch,
): Promise<string | null> {
  const url = `https://api.ipinfo.io/lite/${encodeURIComponent(ip)}?token=${encodeURIComponent(token)}`;
  const response: unknown = await fetchImpl(url, {
    signal: AbortSignal.timeout(GEOIP_TIMEOUT_MS),
    redirect: "error",
    headers: { accept: "application/json" },
  }).catch((error: unknown) => error);
  if (!(response instanceof Response)) {
    /**
     * Deliberately not chained as `cause`: a fetch error message can quote
     * the URL, which holds the token. Only the error class is kept.
     */
    const kind = response instanceof Error ? response.name : "unknown";
    throw new Error(`ipinfo request failed (${kind})`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`ipinfo answered HTTP ${response.status}`);
  }
  const text = await readCapped(response, GEOIP_MAX_RESPONSE_BYTES);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("ipinfo answered invalid JSON");
  }
  return locationFromIpinfo(body);
}

/**
 * The loaded `.mmdb` lookup, shared by every request: the file is read
 * once, at the first lookup. Resolves to `null` when it could not be
 * loaded (location stays off until the restart).
 */
let mmdbLookup: Promise<MmdbLookup | null> | undefined;

/** Loads the configured file once; one `warn` when that fails. */
function sharedMmdbLookup(dbPath: string): Promise<MmdbLookup | null> {
  mmdbLookup ??= loadMmdbLookup(dbPath).then(
    (lookup) => {
      logger.info("GeoIP database loaded, session locations on");
      return lookup;
    },
    (error: unknown) => {
      logger.warn("GeoIP database could not be loaded, session locations off", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    },
  );
  return mmdbLookup;
}

/**
 * The approximate location of `ip` under `settings`, or `null` when
 * location is off, the address is not a public IP, or nothing is known
 * about it. Throws when an online lookup fails (the caller logs it).
 */
export async function lookupLocation(
  ip: string | null,
  settings: GeoipSettings = config.geoip,
): Promise<string | null> {
  if (settings.source === "off" || !ip || isBlockedIp(ip)) return null;
  if (settings.source === "mmdb") {
    const lookup = await sharedMmdbLookup(settings.dbPath);
    return lookup ? locationFromMmdbRecord(lookup(ip)) : null;
  }
  return fetchIpinfoLocation(ip, settings.token);
}
