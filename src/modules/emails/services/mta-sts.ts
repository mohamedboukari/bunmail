import { lookup } from "dns/promises";
import { isIP } from "net";
import { resolveTxtRecords } from "../../../utils/dns-txt.ts";
import { logger } from "../../../utils/logger.ts";
import { withTimeout } from "./mx-route.ts";
import {
  parseMtaStsPolicy,
  parseMtaStsTxt,
  type MtaStsPolicy,
} from "./mta-sts-policy.ts";
import { MtaStsPolicyCache } from "./mta-sts-cache.ts";
import {
  MtaStsFetchError,
  isCertificateError,
  policyAddress,
  readPolicyBody,
  type MtaStsDeps,
  type MtaStsFailureKind,
} from "./mta-sts-fetch.ts";

export {
  MTA_STS_MAX_AGE_CAP_SECONDS,
  MTA_STS_POLICY_MAX_BYTES,
  matchingMxHosts,
  mxMatchesPattern,
  parseMtaStsPolicy,
  parseMtaStsTxt,
  type MtaStsPolicy,
} from "./mta-sts-policy.ts";
export { MtaStsPolicyCache } from "./mta-sts-cache.ts";
/** @public Kept from before the split (#387), when only this file used it. */
export type { MtaStsMode } from "./mta-sts-policy.ts";
/** @public Kept from before the split (#387), when only this file used it. */
export { MTA_STS_CACHE_LIMIT } from "./mta-sts-cache.ts";
export {
  MtaStsFetchError,
  type MtaStsDeps,
  type MtaStsFailureKind,
} from "./mta-sts-fetch.ts";

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
 * `mailer.service.ts` and `mailer-mta-sts.service.ts`. Config-free: the caller passes `allowPrivate`, and
 * every lookup and the fetch are replaceable ({@link setMtaStsDeps}).
 */

/*
 * Split by concern (#387): the TXT record, policy file and MX matching
 * in `mta-sts-policy.ts`, the cache class in `mta-sts-cache.ts`, the
 * fetch's seams and steps in `mta-sts-fetch.ts`. This file keeps the
 * replaceable deps, the process-wide cache and everything that defaults
 * to them: `setMtaStsDeps`, `fetchMtaStsPolicy` and the discovery.
 */

/** Longest a policy fetch may take, headers and body (RFC 8461 3.3 suggests 60 s at most). */
const MTA_STS_FETCH_TIMEOUT_MS = 10_000;

/** Longest the TXT lookup may take; past it, the lookup counts as failed. */
const DNS_LOOKUP_TIMEOUT_MS = 15_000;

/** A domain's policy in force for an attempt, and the TXT `id` it was fetched under. */
export interface ActiveMtaStsPolicy {
  id: string;
  policy: MtaStsPolicy;
}

const realDeps: MtaStsDeps = {
  /** Our own TXT lookup: Bun's `resolveTxt` splits multi-string records (oven-sh/bun#44692). */
  resolveTxt: (name) => resolveTxtRecords(name),
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
      isCertificateError(error) ? "webpki-invalid" : "fetch-error",
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
      throw new MtaStsFetchError("policy is not served as text/plain", "policy-invalid");
    }
    const encoding = (response.headers.get("content-encoding") ?? "")
      .trim()
      .toLowerCase();
    if (encoding !== "" && encoding !== "identity") {
      throw new MtaStsFetchError("policy is served encoded", "policy-invalid");
    }
    const body = await readPolicyBody(response);
    const policy = parseMtaStsPolicy(body);
    if (policy === null)
      throw new MtaStsFetchError("policy is invalid", "policy-invalid");
    return policy;
  } catch (error) {
    await response.body?.cancel().catch(() => undefined);
    if (error instanceof MtaStsFetchError) throw error;
    throw new MtaStsFetchError(
      `policy read failed: ${error instanceof Error ? error.message : String(error)}`,
    );
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

/**
 * What discovery found for a domain on one attempt (#345): the policy in
 * force (`null`: none), and, when a policy was announced but its fetch
 * failed now or recently, why (`failure`). A failure with a kept cached
 * policy still has that policy in force.
 */
export interface MtaStsDiscovery {
  policy: ActiveMtaStsPolicy | null;
  failure: MtaStsFailureKind | null;
}

/** Discoveries in progress, by domain: concurrent attempts share one. */
const inFlight = new Map<string, Promise<MtaStsDiscovery>>();

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
  return (await discoverMtaSts(domain, options)).policy;
}

/**
 * {@link discoverMtaStsPolicy} with the reason a policy fetch failed
 * (#345), for TLS-RPT. The same discovery, shared with concurrent calls.
 */
export async function discoverMtaSts(
  domain: string,
  options: { allowPrivate: boolean; deps?: MtaStsDeps; cache?: MtaStsPolicyCache },
): Promise<MtaStsDiscovery> {
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
): Promise<MtaStsDiscovery> {
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
    return { policy: kept, failure: null };
  }
  /** No record (or no longer one): a cached policy stays until its `max_age` (RFC 8461 5). */
  if (txt.kind === "none") return { policy: kept, failure: null };
  if (cached && cached.id === txt.id) return { policy: kept, failure: null };
  const recent = cache.recentFailure(domain, txt.id, now);
  if (recent !== null) {
    logger.debug("MTA-STS policy fetch failed recently, not retried yet", {
      domain,
      policyId: txt.id,
      cachedPolicy: kept !== null,
    });
    return { policy: kept, failure: recent };
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
    return { policy: { id: txt.id, policy }, failure: null };
  } catch (error) {
    const failure = error instanceof MtaStsFetchError ? error.kind : "fetch-error";
    cache.failed(domain, txt.id, policyDeps.now(), failure);
    logger.warn("MTA-STS policy fetch failed", {
      domain,
      policyId: txt.id,
      reason: error instanceof Error ? error.message : String(error),
      failure,
      cachedPolicy: kept !== null,
    });
    return { policy: kept, failure };
  }
}
