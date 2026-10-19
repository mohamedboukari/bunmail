import { resolveMx } from "dns/promises";
import { config } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";

/**
 * Whether a sender domain gets signed return paths (#236).
 *
 * `SMTP_ENABLED=true` means this BunMail receives mail for some domains,
 * not necessarily for every domain it sends for: a domain whose MX points
 * elsewhere (a Google Workspace mailbox, say) would get `b+...@domain`
 * envelopes that its own mail host rejects, so its DSNs would be lost
 * instead of reaching a human at the From address, and receivers doing
 * sender-verification callouts could refuse the mail. So the return path
 * is signed only when the sender domain's MX set names this server
 * (`MAIL_HOSTNAME`, case-insensitive, trailing dot ignored).
 *
 * Answers are cached in memory per domain: an hour for a yes or a no
 * (NXDOMAIN and "no MX" count as no), five minutes after a DNS error or
 * timeout. An error falls back to the plain envelope (fail safe) and is
 * logged at `warn`, once per domain per cache period. Same conventions as
 * the reverse DNS check (#248): `dns/promises`, lookups injectable for
 * tests.
 */

/** How long a yes or a no is kept. */
export const MX_ANSWER_TTL_MS = 60 * 60 * 1000;

/** How long a DNS error is kept (the plain envelope is used meanwhile). */
export const MX_ERROR_TTL_MS = 5 * 60 * 1000;

/** Longest a lookup may take before it counts as an error. */
const MX_LOOKUP_TIMEOUT_MS = 5_000;

/** Most domains cached; the oldest entry is evicted beyond this. */
export const MX_CACHE_MAX_ENTRIES = 10_000;

/** DNS error codes that mean "no MX here", an answer rather than a failure. */
const NO_MX_CODES = new Set(["ENOTFOUND", "ENODATA"]);

/** The DNS lookup and clock, injectable for tests. */
export interface MxCheckDeps {
  resolveMx: (domain: string) => Promise<Array<{ exchange: string }>>;
  now: () => number;
  timeoutMs: number;
}

const defaultDeps: MxCheckDeps = {
  resolveMx,
  now: () => Date.now(),
  timeoutMs: MX_LOOKUP_TIMEOUT_MS,
};

/**
 * What a domain's MX set says about this server (#250): `here` when it
 * names `MAIL_HOSTNAME`, `elsewhere` when it names other hosts only, `none`
 * without MX hosts (NXDOMAIN, no MX, or only a null MX), `error` when the
 * lookup failed or timed out. Informational on the domain page; the
 * return path uses only `here`.
 */
export interface MxStatus {
  status: "here" | "elsewhere" | "none" | "error";
  /** The MX host names, lowercased, without the trailing dot, in DNS order. */
  hosts: string[];
}

interface CacheEntry {
  mx: MxStatus;
  expiresAt: number;
}

/** Cached answers, by `<hostname> <domain>`; insertion order = age. */
const cache = new Map<string, CacheEntry>();

/** Lookups in flight, so concurrent sends for one domain share one query. */
const inflight = new Map<string, Promise<MxStatus>>();

/** Empties the cache (tests). */
export function clearMxCache(): void {
  cache.clear();
  inflight.clear();
}

/** Number of cached domains (tests). */
export function mxCacheSize(): number {
  return cache.size;
}

/** Lowercased, without a trailing dot. */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/** The error code of a DNS failure, when it has one. */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

/** Stores an answer, evicting the oldest entries past the bound. */
function remember(key: string, entry: CacheEntry): void {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MX_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** One DNS lookup with a timeout; rejects on error or timeout. */
async function lookupWithTimeout(
  domain: string,
  deps: MxCheckDeps,
): Promise<Array<{ exchange: string }>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      deps.resolveMx(domain),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(Object.assign(new Error("MX lookup timed out"), { code: "ETIMEOUT" })),
          deps.timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves and caches one domain's answer. Never rejects. */
async function resolveAndRemember(
  key: string,
  domain: string,
  hostname: string,
  deps: MxCheckDeps,
): Promise<MxStatus> {
  try {
    const records = await lookupWithTimeout(domain, deps);
    /** A null MX (`.`, RFC 7505) normalizes to "" and names no host. */
    const hosts = [
      ...new Set(records.map((r) => normalizeHost(r.exchange)).filter((h) => h !== "")),
    ];
    const status =
      hosts.length === 0 ? "none" : hosts.includes(hostname) ? "here" : "elsewhere";
    const mx: MxStatus = { status, hosts };
    remember(key, { mx, expiresAt: deps.now() + MX_ANSWER_TTL_MS });
    return mx;
  } catch (error) {
    const code = errorCode(error);
    if (code !== undefined && NO_MX_CODES.has(code)) {
      const mx: MxStatus = { status: "none", hosts: [] };
      remember(key, { mx, expiresAt: deps.now() + MX_ANSWER_TTL_MS });
      return mx;
    }
    const mx: MxStatus = { status: "error", hosts: [] };
    remember(key, { mx, expiresAt: deps.now() + MX_ERROR_TTL_MS });
    logger.warn("Sender domain MX lookup failed: plain envelope sender used", {
      domain,
      code: code ?? null,
      retryInSeconds: Math.round(MX_ERROR_TTL_MS / 1000),
    });
    return mx;
  }
}

/**
 * The MX status of `domain` relative to `mailHostname` (both compared
 * lowercased, trailing dot ignored), from the cache shared with the
 * return-path decision (#236, #250). Never rejects: a DNS error or timeout
 * answers `error`. An empty name answers `none` without a lookup.
 */
export async function resolveMxStatus(
  domain: string,
  mailHostname: string,
  deps: MxCheckDeps = defaultDeps,
): Promise<MxStatus> {
  const name = normalizeHost(domain);
  const hostname = normalizeHost(mailHostname);
  if (!name || !hostname) return { status: "none", hosts: [] };
  const key = `${hostname} ${name}`;

  const cached = cache.get(key);
  if (cached && cached.expiresAt > deps.now()) return cached.mx;

  const pending = inflight.get(key);
  if (pending) return pending;
  const lookup = resolveAndRemember(key, name, hostname, deps).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, lookup);
  return lookup;
}

/**
 * True when `domain`'s MX set names `mailHostname` (both compared
 * lowercased, trailing dot ignored). Cached; never rejects: a DNS error or
 * timeout answers `false`.
 */
export async function mxPointsHere(
  domain: string,
  mailHostname: string,
  deps: MxCheckDeps = defaultDeps,
): Promise<boolean> {
  return (await resolveMxStatus(domain, mailHostname, deps)).status === "here";
}

/**
 * Whether an email from `fromAddress` is sent with signed return paths:
 * inbound SMTP is enabled and the sender domain's MX points at this server
 * (`MAIL_HOSTNAME`). Decided once per email and attempt, for all of its
 * recipients.
 */
export async function signedReturnPathEnabled(
  fromAddress: string,
  deps: MxCheckDeps = defaultDeps,
): Promise<boolean> {
  if (!config.smtp.enabled) return false;
  const domain = fromAddress.slice(fromAddress.lastIndexOf("@") + 1);
  return mxPointsHere(domain, config.mail.hostname, deps);
}
