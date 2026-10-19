import { lookup, resolveTxt } from "dns/promises";
import { isIP } from "net";
import { logger } from "../../../utils/logger.ts";
import { isBlockedIp } from "../../../utils/ssrf-guard.ts";
import type { LookupAll } from "./mx-address.ts";
import { withTimeout } from "./mx-route.ts";

/**
 * Outbound MTA-STS (RFC 8461, #250): a recipient domain can publish a
 * policy that says which MX hosts may receive its mail and that they must
 * be reached over verified TLS. Without it, outbound STARTTLS is
 * opportunistic and unverified, so an attacker on the path can strip
 * STARTTLS or present any certificate.
 *
 * **Discovery** ({@link discoverMtaStsPolicy}), per recipient domain, on
 * every attempt:
 *
 * - TXT `_mta-sts.<domain>`: exactly one record starting `v=STSv1`, with
 *   an `id` of 1 to 32 letters and digits ({@link parseMtaStsTxt}). None,
 *   several, or an invalid one: no policy is announced (RFC 8461 3.1).
 * - The policy itself, `https://mta-sts.<domain>/.well-known/mta-sts.txt`
 *   ({@link fetchMtaStsPolicy}): HTTPS with the certificate verified for
 *   `mta-sts.<domain>`, no redirects, a 10 s timeout, at most 64 KB,
 *   `Content-Type: text/plain`. The host is chosen by the recipient
 *   domain, so the request goes only to an address that passes the same
 *   check as an MX host (no private, loopback or link-local address unless
 *   `MAIL_ALLOW_PRIVATE_MX`), pinned to it, with the host name as SNI.
 * - Parsed strictly ({@link parseMtaStsPolicy}): `version: STSv1`, a
 *   `mode`, `max_age` (capped at a year), and `mx` patterns.
 *
 * **Cache** ({@link MtaStsPolicyCache}): in memory, per recipient domain,
 * keyed with the policy `id`, bounded. An unchanged `id` within `max_age`
 * reuses the cached policy without a fetch. A changed `id` or an expired
 * policy is fetched again; when that fails, an unexpired cached policy is
 * kept (RFC 8461 5.1). A TXT record that disappears, or a TXT lookup that
 * fails, also keeps an unexpired cached policy (RFC 8461 5). The cache is
 * per process: each replica discovers and caches on its own, and a fresh
 * process trusts its first fetch (trust on first use, as the RFC accepts).
 *
 * What the mailer does with a policy (enforce, testing, none) is in
 * `mailer.service.ts`. Config-free: the caller passes `allowPrivate`, and
 * every lookup and the fetch are replaceable ({@link setMtaStsDeps}).
 */

/** Longest `max_age` honoured, in seconds (RFC 8461 3.2: 31557600, about a year). */
export const MTA_STS_MAX_AGE_CAP_SECONDS = 31_557_600;

/** Largest policy file read, in bytes (RFC 8461 3.3 suggests 64 KB). */
export const MTA_STS_POLICY_MAX_BYTES = 64 * 1024;

/** Longest a policy fetch may take, headers and body (RFC 8461 3.3 suggests 60 s at most). */
const MTA_STS_FETCH_TIMEOUT_MS = 10_000;

/** Most recipient domains whose policy is cached; the oldest entry is evicted past it. */
export const MTA_STS_CACHE_LIMIT = 10_000;

/**
 * How long a failed policy fetch is not retried for the same domain and
 * policy `id`. Without it, every attempt to a domain whose policy host is
 * down would wait out the fetch timeout again.
 */
const MTA_STS_FETCH_RETRY_AFTER_MS = 5 * 60_000;

/** Longest the TXT lookup may take; past it, the lookup counts as failed. */
const DNS_LOOKUP_TIMEOUT_MS = 15_000;

/** A policy's mode (RFC 8461 5). */
export type MtaStsMode = "enforce" | "testing" | "none";

/** A parsed MTA-STS policy. */
export interface MtaStsPolicy {
  mode: MtaStsMode;
  /** MX patterns, lowercased, without a trailing dot: `mx.example.com` or `*.example.com`. */
  mx: string[];
  /** Lifetime of the policy in seconds, capped at {@link MTA_STS_MAX_AGE_CAP_SECONDS}. */
  maxAge: number;
}

/** A domain's policy in force for an attempt, and the TXT `id` it was fetched under. */
export interface ActiveMtaStsPolicy {
  id: string;
  policy: MtaStsPolicy;
}

/** The lookups, the fetch and the clock, replaceable in tests. */
export interface MtaStsDeps {
  resolveTxt: (name: string) => Promise<string[][]>;
  /** Address lookup of `mta-sts.<domain>`. */
  lookup: LookupAll;
  /** Bun's fetch: `tls`, `decompress` and `redirect: "manual"` are used. */
  fetch: (url: string, init: BunFetchRequestInit) => Promise<Response>;
  /** HTTPS port of the policy host: 443. Tests point it at a local server. */
  httpsPort: number;
  /**
   * Trust anchors (PEM) instead of the system store, for the policy fetch
   * and for verified SMTP TLS in enforce mode. Tests only: production
   * leaves it unset.
   */
  ca?: string;
  fetchTimeoutMs: number;
  dnsTimeoutMs: number;
  now: () => number;
}

const realDeps: MtaStsDeps = {
  /** Called through, so a replaced `dns/promises` export is honoured. */
  resolveTxt: (name) => resolveTxt(name),
  lookup: (host) => lookup(host, { all: true }),
  fetch: (url, init) => fetch(url, init),
  httpsPort: 443,
  fetchTimeoutMs: MTA_STS_FETCH_TIMEOUT_MS,
  dnsTimeoutMs: DNS_LOOKUP_TIMEOUT_MS,
  now: () => Date.now(),
};

let deps: MtaStsDeps = realDeps;

/**
 * Replaces the lookups, the fetch or the trust anchors (tests), or restores
 * the real ones with `null`. Also empties the cache, so a test never sees
 * another test's policy.
 */
export function setMtaStsDeps(override: Partial<MtaStsDeps> | null): void {
  deps = override === null ? realDeps : { ...realDeps, ...override };
  policyCache.clear();
}

/** The trust anchors for verified TLS: `undefined` (the system store) outside tests. */
export function mtaStsTrustAnchors(): string | undefined {
  return deps.ca;
}

/* ─── TXT record ─── */

/** A policy `id`: 1 to 32 letters and digits (RFC 8461 3.1). */
const STS_ID_RE = /^[A-Za-z0-9]{1,32}$/;

/** An extension field name (RFC 8461 3.1, `sts-ext-name`). */
const STS_EXT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;

/** An extension field value: printable ASCII except `;` and `=`. */
const STS_EXT_VALUE_RE = /^[\x21-\x3a\x3c\x3e-\x7e]+$/;

/**
 * The policy `id` announced by the TXT records of `_mta-sts.<domain>`, or
 * `null` when none is (RFC 8461 3.1): records not starting with `v=STSv1`
 * are ignored, and anything but exactly one remaining, valid record means
 * no policy is announced. Each record is given as its strings, which are
 * joined.
 */
export function parseMtaStsTxt(records: string[][]): string | null {
  const candidates = records
    .map((chunks) => chunks.join(""))
    .filter((text) => text.startsWith("v=STSv1"));
  if (candidates.length !== 1) return null;
  const fields = (candidates[0] ?? "").split(";").map((field) => field.trim());
  if (fields[0] !== "v=STSv1") return null;
  let id: string | null = null;
  for (const [index, field] of fields.slice(1).entries()) {
    /** A trailing `;` leaves one empty field; any other empty field is malformed. */
    if (field === "") {
      if (index === fields.length - 2) continue;
      return null;
    }
    const eq = field.indexOf("=");
    if (eq <= 0) return null;
    const name = field.slice(0, eq);
    const value = field.slice(eq + 1);
    if (name === "id") {
      if (id !== null || !STS_ID_RE.test(value)) return null;
      id = value;
    } else if (!STS_EXT_NAME_RE.test(name) || !STS_EXT_VALUE_RE.test(value)) {
      return null;
    }
  }
  return id;
}

/* ─── Policy file ─── */

/** A DNS label: letters, digits and inner hyphens, at most 63 characters. */
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";

/** A host name, or one with a single leading `*.` wildcard label (RFC 8461 3.2). */
const MX_PATTERN_RE = new RegExp(`^(?:\\*\\.)?${LABEL}(?:\\.${LABEL})*$`);

/** One `key: value` line of a policy file (RFC 8461 3.2). */
const POLICY_LINE_RE = /^([A-Za-z0-9_.-]{1,32}):[ \t]*(.*?)[ \t]*$/;

/** An `mx` pattern, lowercased and without a trailing dot, or `null` when invalid. */
function mxPattern(value: string): string | null {
  const pattern = value.toLowerCase().replace(/\.$/, "");
  if (pattern.length === 0 || pattern.length > 253) return null;
  return MX_PATTERN_RE.test(pattern) ? pattern : null;
}

/**
 * Parses a policy file (RFC 8461 3.2), strictly: `version: STSv1`, `mode`
 * one of `enforce`, `testing` and `none`, `max_age` of 1 to 10 digits
 * (capped at {@link MTA_STS_MAX_AGE_CAP_SECONDS}), and at least one `mx`
 * pattern unless the mode is `none`. A required field that is missing,
 * repeated or invalid, or any invalid `mx` pattern, makes the whole policy
 * invalid: `null`. Lines end in CRLF or LF. Unknown keys and lines that are
 * not `key: value` are ignored (RFC 8461 3.2: unknown fields SHOULD be
 * ignored), so stray text never turns an enforce policy into no policy.
 * A body larger than {@link MTA_STS_POLICY_MAX_BYTES} is invalid.
 */
export function parseMtaStsPolicy(body: string): MtaStsPolicy | null {
  if (Buffer.byteLength(body, "utf8") > MTA_STS_POLICY_MAX_BYTES) return null;
  const single: Record<"version" | "mode" | "max_age", string | undefined> = {
    version: undefined,
    mode: undefined,
    max_age: undefined,
  };
  const mx: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = POLICY_LINE_RE.exec(line);
    if (!match) continue;
    const key = match[1] ?? "";
    const value = match[2] ?? "";
    if (key === "mx") {
      const pattern = mxPattern(value);
      if (pattern === null) return null;
      mx.push(pattern);
    } else if (key === "version" || key === "mode" || key === "max_age") {
      if (single[key] !== undefined) return null;
      single[key] = value;
    }
  }
  if (single.version !== "STSv1") return null;
  const mode = single.mode;
  if (mode !== "enforce" && mode !== "testing" && mode !== "none") return null;
  if (single.max_age === undefined || !/^\d{1,10}$/.test(single.max_age)) return null;
  if (mode !== "none" && mx.length === 0) return null;
  return {
    mode,
    mx: [...new Set(mx)],
    maxAge: Math.min(Number(single.max_age), MTA_STS_MAX_AGE_CAP_SECONDS),
  };
}

/* ─── MX matching ─── */

/**
 * Whether `mxHost` matches a policy pattern (RFC 8461 4.1), ignoring case
 * and a trailing dot: an exact name, or `*.example.com`, which matches
 * exactly one leftmost label (`mx1.example.com`, not `a.b.example.com` and
 * not `example.com`).
 */
export function mxMatchesPattern(mxHost: string, pattern: string): boolean {
  const host = mxHost.trim().toLowerCase().replace(/\.$/, "");
  const want = pattern.toLowerCase().replace(/\.$/, "");
  if (!want.startsWith("*.")) return host === want;
  const suffix = want.slice(1);
  if (!host.endsWith(suffix)) return false;
  const label = host.slice(0, host.length - suffix.length);
  return label.length > 0 && !label.includes(".");
}

/** The hosts, in their order, that match at least one of the policy's patterns. */
export function matchingMxHosts(hosts: string[], policy: MtaStsPolicy): string[] {
  return hosts.filter((host) =>
    policy.mx.some((pattern) => mxMatchesPattern(host, pattern)),
  );
}

/* ─── Policy fetch ─── */

/** Thrown when a policy could not be fetched or is invalid. */
export class MtaStsFetchError extends Error {
  override readonly name = "MtaStsFetchError";
}

/**
 * Resolves the policy host to the one address to connect to: refused when
 * it resolves to nothing, or when any address is not public (the MX
 * address rule, `resolveMxAddresses`) unless `allowPrivate`; a scoped
 * address (zone id) is always refused. IPv4 first.
 */
async function policyAddress(
  host: string,
  allowPrivate: boolean,
  policyDeps: MtaStsDeps,
): Promise<string> {
  let addresses: { address: string }[];
  try {
    addresses = await withTimeout(policyDeps.lookup(host), policyDeps.dnsTimeoutMs);
  } catch {
    throw new MtaStsFetchError(`policy host ${host} could not be resolved`);
  }
  if (addresses.length === 0) {
    throw new MtaStsFetchError(`policy host ${host} resolved to no addresses`);
  }
  if (
    addresses.some(
      ({ address }) =>
        address.includes("%") ||
        isIP(address) === 0 ||
        (!allowPrivate && isBlockedIp(address)),
    )
  ) {
    /** No address in the message: it is logged with the domain. */
    throw new MtaStsFetchError(`policy host ${host} resolves to a non-public address`);
  }
  const chosen = addresses.find(({ address }) => isIP(address) === 4) ?? addresses[0];
  if (!chosen) throw new MtaStsFetchError(`policy host ${host} resolved to no addresses`);
  return chosen.address;
}

/** Reads at most {@link MTA_STS_POLICY_MAX_BYTES} of the body as UTF-8, or throws. */
async function readPolicyBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MTA_STS_POLICY_MAX_BYTES) {
        throw new MtaStsFetchError(
          `policy larger than ${MTA_STS_POLICY_MAX_BYTES} bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new MtaStsFetchError("policy is not valid UTF-8");
  }
}

/**
 * Fetches and parses `domain`'s policy (RFC 8461 3.3), or throws
 * {@link MtaStsFetchError}.
 *
 * - The host `mta-sts.<domain>` is resolved once and checked
 *   ({@link policyAddress}); the request goes to that address, never to
 *   the name, so a second DNS answer is never used.
 * - The host name is the TLS server name: Bun's fetch sends it as SNI and
 *   verifies the certificate against it during the handshake (the same
 *   pinning as webhook delivery, `buildPinnedRequest`). It is also the
 *   `Host` header.
 * - No redirects (`redirect: "manual"`, and anything but `200` fails), no
 *   connection reuse, no decompression, a timeout over headers and body,
 *   a body cap, and `Content-Type: text/plain`.
 */
export async function fetchMtaStsPolicy(
  domain: string,
  options: { allowPrivate: boolean },
  policyDeps: MtaStsDeps = deps,
): Promise<MtaStsPolicy> {
  const host = `mta-sts.${domain}`;
  const address = await policyAddress(host, options.allowPrivate, policyDeps);
  const authority = isIP(address) === 6 ? `[${address}]` : address;
  const port = policyDeps.httpsPort === 443 ? "" : `:${policyDeps.httpsPort}`;
  const url = `https://${authority}${port}/.well-known/mta-sts.txt`;

  let response: Response;
  try {
    response = await policyDeps.fetch(url, {
      method: "GET",
      headers: { Host: host, Accept: "text/plain", "Accept-Encoding": "identity" },
      /** SNI, and the certificate checked against the policy host name. */
      tls: {
        serverName: host,
        rejectUnauthorized: true,
        ...(policyDeps.ca === undefined ? {} : { ca: policyDeps.ca }),
      },
      /** A redirect is a failed fetch (RFC 8461 3.3), never followed. */
      redirect: "manual",
      /** A pooled connection could have been verified for another name. */
      keepalive: false,
      /** Never inflate an untrusted body. */
      decompress: false,
      signal: AbortSignal.timeout(policyDeps.fetchTimeoutMs),
    });
  } catch (error) {
    throw new MtaStsFetchError(
      `policy fetch failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    if (response.status !== 200) {
      throw new MtaStsFetchError(`policy fetch answered HTTP ${response.status}`);
    }
    const contentType = (response.headers.get("content-type") ?? "")
      .split(";")[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "text/plain") {
      throw new MtaStsFetchError("policy is not served as text/plain");
    }
    const encoding = (response.headers.get("content-encoding") ?? "")
      .trim()
      .toLowerCase();
    if (encoding !== "" && encoding !== "identity") {
      throw new MtaStsFetchError("policy is served encoded");
    }
    const body = await readPolicyBody(response);
    const policy = parseMtaStsPolicy(body);
    if (policy === null) throw new MtaStsFetchError("policy is invalid");
    return policy;
  } catch (error) {
    await response.body?.cancel().catch(() => undefined);
    if (error instanceof MtaStsFetchError) throw error;
    throw new MtaStsFetchError(
      `policy read failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/* ─── Cache ─── */

/** A cached policy of one recipient domain. */
interface CachedPolicy {
  id: string;
  policy: MtaStsPolicy;
  /** Epoch ms past which the policy is no longer used. */
  expiresAt: number;
  /** A testing-mode "would have failed" warning was logged for this `id`. */
  warned: boolean;
}

/**
 * Policies by recipient domain (#250), in memory, at most `limit` domains:
 * a new domain past the limit evicts the entry stored longest ago. Also
 * remembers failed fetches, by domain and `id`, for
 * {@link MTA_STS_FETCH_RETRY_AFTER_MS}, under the same bound.
 */
export class MtaStsPolicyCache {
  private readonly policies = new Map<string, CachedPolicy>();
  private readonly failures = new Map<string, { id: string; retryAt: number }>();

  constructor(private readonly limit = MTA_STS_CACHE_LIMIT) {}

  /** The unexpired policy of `domain`, if any; an expired one is dropped. */
  get(domain: string, now: number): CachedPolicy | undefined {
    const entry = this.policies.get(domain);
    if (entry === undefined) return undefined;
    if (now >= entry.expiresAt) {
      this.policies.delete(domain);
      return undefined;
    }
    return entry;
  }

  /** Stores `domain`'s freshly fetched policy, as the newest entry. */
  set(domain: string, id: string, policy: MtaStsPolicy, now: number): void {
    this.failures.delete(domain);
    bounded(this.policies, domain, this.limit, {
      id,
      policy,
      expiresAt: now + policy.maxAge * 1000,
      warned: false,
    });
  }

  /** Records a failed fetch of `domain`'s policy `id`. */
  failed(domain: string, id: string, now: number): void {
    bounded(this.failures, domain, this.limit, {
      id,
      retryAt: now + MTA_STS_FETCH_RETRY_AFTER_MS,
    });
  }

  /** Whether a fetch of `domain`'s policy `id` failed recently, so is not tried again yet. */
  recentlyFailed(domain: string, id: string, now: number): boolean {
    const failure = this.failures.get(domain);
    return failure !== undefined && failure.id === id && now < failure.retryAt;
  }

  /**
   * True the first time it is called for `domain`'s cached policy `id`,
   * false after: a testing-mode warning is logged once per policy.
   */
  firstWarning(domain: string, id: string): boolean {
    const entry = this.policies.get(domain);
    if (entry === undefined || entry.id !== id || entry.warned) return false;
    entry.warned = true;
    return true;
  }

  /** Number of cached policies. */
  get size(): number {
    return this.policies.size;
  }

  clear(): void {
    this.policies.clear();
    this.failures.clear();
  }
}

/** Sets `key` as the newest entry of `map`, evicting the oldest past `limit`. */
function bounded<T>(map: Map<string, T>, key: string, limit: number, value: T): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
  }
}

/** The process-wide cache the mailer uses. */
const policyCache = new MtaStsPolicyCache();

/** The process-wide cache, for the mailer's once-per-policy testing warning. */
export function mtaStsCache(): MtaStsPolicyCache {
  return policyCache;
}

/* ─── Discovery ─── */

/** DNS codes that mean "no such record", not a failed lookup. */
const NO_RECORDS = new Set(["ENOTFOUND", "ENODATA"]);

/** What the TXT lookup said: a policy `id`, no policy announced, or a failed lookup. */
type TxtAnswer =
  { kind: "id"; id: string } | { kind: "none" } | { kind: "error"; code: string };

async function lookupTxt(domain: string, policyDeps: MtaStsDeps): Promise<TxtAnswer> {
  try {
    const records = await withTimeout(
      policyDeps.resolveTxt(`_mta-sts.${domain}`),
      policyDeps.dnsTimeoutMs,
    );
    const id = parseMtaStsTxt(records);
    return id === null ? { kind: "none" } : { kind: "id", id };
  } catch (error) {
    const code: unknown =
      typeof error === "object" && error !== null
        ? Reflect.get(error, "code")
        : undefined;
    if (typeof code === "string" && NO_RECORDS.has(code)) return { kind: "none" };
    return { kind: "error", code: typeof code === "string" ? code : "unknown error" };
  }
}

/** Discoveries in progress, by domain: concurrent attempts share one. */
const inFlight = new Map<string, Promise<ActiveMtaStsPolicy | null>>();

/**
 * The MTA-STS policy in force for `domain` on this attempt (#250), or
 * `null` when there is none. Never throws: a failure means the cached
 * policy when one is unexpired, else no policy (opportunistic TLS, as
 * without MTA-STS). See the module comment for the rules.
 */
export async function discoverMtaStsPolicy(
  domain: string,
  options: { allowPrivate: boolean; deps?: MtaStsDeps; cache?: MtaStsPolicyCache },
): Promise<ActiveMtaStsPolicy | null> {
  const name = domain.trim().toLowerCase().replace(/\.$/, "");
  if (options.deps !== undefined || options.cache !== undefined) {
    return discover(
      name,
      options.allowPrivate,
      options.deps ?? deps,
      options.cache ?? policyCache,
    );
  }
  const running = inFlight.get(name);
  if (running) return running;
  const discovery = discover(name, options.allowPrivate, deps, policyCache).finally(
    () => {
      inFlight.delete(name);
    },
  );
  inFlight.set(name, discovery);
  return discovery;
}

async function discover(
  domain: string,
  allowPrivate: boolean,
  policyDeps: MtaStsDeps,
  cache: MtaStsPolicyCache,
): Promise<ActiveMtaStsPolicy | null> {
  const txt = await lookupTxt(domain, policyDeps);
  const now = policyDeps.now();
  const cached = cache.get(domain, now);
  const kept = cached ? { id: cached.id, policy: cached.policy } : null;

  if (txt.kind === "error") {
    logger.warn("MTA-STS TXT lookup failed", {
      domain,
      code: txt.code,
      cachedPolicy: kept !== null,
    });
    return kept;
  }
  /** No record (or no longer one): a cached policy stays until its `max_age` (RFC 8461 5). */
  if (txt.kind === "none") return kept;
  if (cached && cached.id === txt.id) return kept;
  if (cache.recentlyFailed(domain, txt.id, now)) {
    logger.debug("MTA-STS policy fetch failed recently, not retried yet", {
      domain,
      policyId: txt.id,
      cachedPolicy: kept !== null,
    });
    return kept;
  }

  try {
    const policy = await fetchMtaStsPolicy(domain, { allowPrivate }, policyDeps);
    cache.set(domain, txt.id, policy, policyDeps.now());
    logger.debug("MTA-STS policy fetched", {
      domain,
      policyId: txt.id,
      mode: policy.mode,
      maxAge: policy.maxAge,
    });
    return { id: txt.id, policy };
  } catch (error) {
    cache.failed(domain, txt.id, policyDeps.now());
    logger.warn("MTA-STS policy fetch failed", {
      domain,
      policyId: txt.id,
      reason: error instanceof Error ? error.message : String(error),
      cachedPolicy: kept !== null,
    });
    return kept;
  }
}
