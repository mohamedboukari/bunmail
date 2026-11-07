import { resolveTxtRecords } from "../../../utils/dns-txt.ts";
import { isEmailAddress } from "../../../utils/recipients.ts";
import { withTimeout } from "../../emails/services/mx-route.ts";
import type { TlsRptRua } from "../types/tls-rpt.types.ts";

/**
 * A recipient domain's TLS-RPT record (RFC 8460 section 3, #345): the TXT
 * record at `_smtp._tls.<domain>`, parsed strictly, and a bounded in-memory
 * cache of the answer, so the delivery path looks each domain up at most
 * once an hour.
 *
 * Every `rua` is chosen by the recipient domain's owner, so it is treated
 * as hostile input: only `mailto:` (one plain address, no header fields)
 * and `https:` (no credentials, no fragment) are kept, at most
 * {@link MAX_RUA_PER_RECORD} of them. Where they are sent is checked again
 * at send time (the SSRF guard for `https:`, the MX address check for
 * `mailto:`).
 */

/** Most reporting addresses used from one record; the rest are ignored. */
export const MAX_RUA_PER_RECORD = 5;

/** Longest `rua` URI kept, in characters. */
export const MAX_RUA_LENGTH = 2048;

/**
 * What a decoded `mailto:` address may not contain (#345): control
 * characters (a `%00` or `%0D%0A` would reach the SMTP envelope), the
 * address-list and comment syntax `( ) [ ] \ ; : ,` (a comment, a group,
 * a quoted route), and anything outside ASCII.
 */
const UNSAFE_ADDRESS_RE = /[\p{Cc}()[\]\\;:,]|[^\x20-\x7e]/u;

/** The record version (RFC 8460 section 3: `v=TLSRPTv1`). */
const VERSION_FIELD = "v=TLSRPTv1";

/** One `rua` URI, or `null` when it is not one BunMail sends to. */
export function parseRua(raw: string): TlsRptRua | null {
  const uri = raw.trim();
  if (uri === "" || uri.length > MAX_RUA_LENGTH) return null;
  const colon = uri.indexOf(":");
  if (colon <= 0) return null;
  const scheme = uri.slice(0, colon).toLowerCase();
  if (scheme === "mailto") {
    const rest = uri.slice(colon + 1);
    /** Header fields (`?subject=`, a second `to`) are never honoured. */
    if (rest.includes("?") || rest.includes("#")) return null;
    let address: string;
    try {
      address = decodeURIComponent(rest);
    } catch {
      return null;
    }
    if (UNSAFE_ADDRESS_RE.test(address)) return null;
    const at = address.lastIndexOf("@");
    if (at <= 0) return null;
    address = `${address.slice(0, at)}@${address.slice(at + 1).toLowerCase()}`;
    if (!isEmailAddress(address)) return null;
    const destination = address.toLowerCase();
    return { scheme: "mailto", uri, address, key: `mailto:${destination}`, destination };
  }
  if (scheme === "https") {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" || url.hostname === "") return null;
    /** Credentials in a URL would be sent as given: never. */
    if (url.username !== "" || url.password !== "" || url.hash !== "") return null;
    return {
      scheme: "https",
      uri,
      url: url.href,
      key: url.href,
      destination: url.origin,
    };
  }
  return null;
}

/**
 * The reporting addresses of a domain's `_smtp._tls` TXT records (RFC 8460
 * section 3), or `null` when the domain publishes no usable record.
 *
 * - Each record is given as its strings, which are joined.
 * - Records whose first field is not `v=TLSRPTv1` are ignored; anything
 *   but exactly one remaining record means no record.
 * - Fields are `name=value`, separated by `;`; unknown fields are ignored,
 *   a malformed field or a second `rua` makes the record invalid.
 * - `rua` is a comma-separated list; each URI is checked by
 *   {@link parseRua}, duplicates (by normalised form: an address that
 *   differs only by case, an equivalent URL) dropped, at most
 *   {@link MAX_RUA_PER_RECORD} kept. No usable URI: no record.
 */
export function parseTlsRptTxt(records: readonly string[][]): TlsRptRua[] | null {
  const candidates = records
    .map((chunks) => chunks.join(""))
    .filter((text) => text.split(";")[0]?.trim() === VERSION_FIELD);
  if (candidates.length !== 1) return null;
  const fields = (candidates[0] ?? "").split(";").map((field) => field.trim());
  let rua: string | null = null;
  for (const [index, field] of fields.slice(1).entries()) {
    /** A trailing `;` leaves one empty field; any other empty field is malformed. */
    if (field === "") {
      if (index === fields.length - 2) continue;
      return null;
    }
    const eq = field.indexOf("=");
    if (eq <= 0) return null;
    const name = field.slice(0, eq).trim();
    if (name !== "rua") continue;
    if (rua !== null) return null;
    rua = field.slice(eq + 1);
  }
  if (rua === null) return null;
  const found: TlsRptRua[] = [];
  for (const raw of rua.split(",")) {
    const parsed = parseRua(raw);
    if (parsed === null) continue;
    if (found.some((r) => r.key === parsed.key)) continue;
    found.push(parsed);
    if (found.length === MAX_RUA_PER_RECORD) break;
  }
  return found.length > 0 ? found : null;
}

/* ─── Lookup and cache ─── */

/** Longest the TXT lookup may take; past it, the lookup counts as failed. */
const DNS_LOOKUP_TIMEOUT_MS = 15_000;

/** How long an answer (a record, or none) is reused. */
export const TLSRPT_RECORD_TTL_MS = 60 * 60_000;

/** How long a failed lookup is reused as "no record" before it is tried again. */
const TLSRPT_RECORD_ERROR_TTL_MS = 5 * 60_000;

/** Most domains whose answer is cached; the oldest entry is evicted past it. */
export const TLSRPT_RECORD_CACHE_LIMIT = 10_000;

/** DNS codes that mean "no such record", not a failed lookup. */
const NO_RECORDS = new Set(["ENOTFOUND", "ENODATA"]);

/** The TXT lookup and the clock, replaceable in tests. */
export interface TlsRptRecordDeps {
  resolveTxt: (name: string) => Promise<string[][]>;
  now: () => number;
  timeoutMs: number;
}

const realDeps: TlsRptRecordDeps = {
  /** Our own TXT lookup: Bun's `resolveTxt` splits multi-string records (oven-sh/bun#44692). */
  resolveTxt: (name) => resolveTxtRecords(name),
  now: () => Date.now(),
  timeoutMs: DNS_LOOKUP_TIMEOUT_MS,
};

let deps: TlsRptRecordDeps = realDeps;

/** What a lookup said: the record, no record, or a failed lookup. */
export type TlsRptLookup =
  | { kind: "record"; rua: TlsRptRua[] }
  | { kind: "none" }
  | { kind: "error"; code: string };

/** Looks `domain`'s record up now, without the cache. Never throws. */
export async function lookupTlsRptRecord(
  domain: string,
  lookupDeps: TlsRptRecordDeps = deps,
): Promise<TlsRptLookup> {
  try {
    const records = await withTimeout(
      lookupDeps.resolveTxt(`_smtp._tls.${domain}`),
      lookupDeps.timeoutMs,
    );
    const rua = parseTlsRptTxt(records);
    return rua === null ? { kind: "none" } : { kind: "record", rua };
  } catch (error) {
    const code: unknown =
      typeof error === "object" && error !== null
        ? Reflect.get(error, "code")
        : undefined;
    if (typeof code === "string" && NO_RECORDS.has(code)) return { kind: "none" };
    return { kind: "error", code: typeof code === "string" ? code : "unknown error" };
  }
}

/** Cached answers by domain: whether it publishes a usable record, until `expiresAt`. */
const cache = new Map<string, { publishes: boolean; expiresAt: number }>();

/** Lookups in progress, by domain: concurrent sessions share one. */
const inFlight = new Map<string, Promise<boolean>>();

/**
 * Whether `domain` publishes a usable TLS-RPT record, from the cache when
 * the answer is under {@link TLSRPT_RECORD_TTL_MS} old (a failed lookup:
 * five minutes, as "no"). Bounded to {@link TLSRPT_RECORD_CACHE_LIMIT}
 * domains. Never throws.
 */
export async function publishesTlsRpt(domain: string): Promise<boolean> {
  const name = domain.trim().toLowerCase().replace(/\.$/, "");
  const now = deps.now();
  const cached = cache.get(name);
  if (cached !== undefined && now < cached.expiresAt) return cached.publishes;
  const running = inFlight.get(name);
  if (running) return running;
  const lookup = lookupTlsRptRecord(name).then((answer) => {
    const publishes = answer.kind === "record";
    const ttl =
      answer.kind === "error" ? TLSRPT_RECORD_ERROR_TTL_MS : TLSRPT_RECORD_TTL_MS;
    cache.delete(name);
    cache.set(name, { publishes, expiresAt: deps.now() + ttl });
    while (cache.size > TLSRPT_RECORD_CACHE_LIMIT) {
      const oldest = cache.keys().next();
      if (oldest.done === true) break;
      cache.delete(oldest.value);
    }
    return publishes;
  });
  const shared = lookup.finally(() => inFlight.delete(name));
  inFlight.set(name, shared);
  return shared;
}

/**
 * @public Replaces the lookup or the clock (tests), or restores the real
 * ones with `null`. Also empties the cache.
 */
export function setTlsRptRecordDeps(override: Partial<TlsRptRecordDeps> | null): void {
  deps = override === null ? realDeps : { ...realDeps, ...override };
  cache.clear();
  inFlight.clear();
}

/** @public Number of cached domains (tests). */
export function tlsRptRecordCacheSize(): number {
  return cache.size;
}
