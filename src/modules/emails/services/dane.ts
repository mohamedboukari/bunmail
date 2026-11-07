import { dottedName, type TlsaRecord } from "../../../utils/dns-rdata.ts";
import { lookupSecure, type SecureLookupOptions } from "../../../utils/dns-secure.ts";
import { logger } from "../../../utils/logger.ts";
import type { DaneHost, SecureMx } from "../types/dane.types.ts";
import { usableTlsa } from "./dane-verify.ts";
import { orderMxHosts, type MxRoute } from "./mx-route.ts";

/**
 * Where DANE applies (RFC 7672 section 2, #345): the recipient domain's
 * MX lookup, then, host by host as delivery reaches them, the address and
 * TLSA lookups. Every lookup goes to the trusted resolver
 * (`DANE_RESOLVER`, `dns-secure.ts`); only its AD bit says "secure".
 *
 * **The domain** ({@link resolveDaneRoute}, section 2.2.1). The MX lookup
 * gives the route as `mx-route.ts` would (preference order, random ties,
 * null MX, implicit MX, NXDOMAIN), plus whether DANE applies:
 *
 * - A secure MX RRset (or a secure denial of MX records, for the implicit
 *   MX of section 2.2.2): DANE applies to each MX host, see below.
 * - An insecure one: DANE does not apply to this domain. Delivery goes on
 *   as without DANE (MTA-STS, or opportunistic TLS). BunMail does not use
 *   the optional "DANE despite an insecure MX" of section 2.2.1.
 * - A lookup failure (SERVFAIL, which is how a validating resolver
 *   reports a bogus answer, a timeout, ...): the servers to use cannot be
 *   determined, so delivery is delayed (section 2.1.2), never sent to
 *   hosts from another, unvalidated source.
 *
 * **Each MX host** ({@link decideDaneHost}, sections 2.2.2 and 2.2.3):
 *
 * 1. Its A and AAAA records first (section 2.2.2: they come before TLSA,
 *    and their DNSSEC status decides whether TLSA is looked up at all).
 *    A failed lookup makes the host unusable for this attempt (the next
 *    MX host is tried; with none left the mail waits); no address at all
 *    makes it unreachable.
 * 2. The candidate TLSA base domains: the host name when it is not an
 *    alias and its addresses are secure; the fully expanded name, then the
 *    host name, when it is an alias and the whole expansion is secure; the
 *    host name alone when the expansion is insecure but the host's own
 *    CNAME record is secure (a separate CNAME query, section 2.1.3); none
 *    otherwise (DANE does not apply to the host).
 * 3. `_<port>._tcp.<candidate>` TLSA, candidate by candidate: the first
 *    secure, non-empty RRset is the host's, and its candidate the TLSA
 *    base domain. An insecure RRset or a denial (secure or not) moves on
 *    to the next candidate; a failed lookup makes the host unusable, never
 *    "no DANE" (section 2.1.2: no downgrade on a lookup error).
 * 4. Records found: TLS is required. When at least one is usable it must
 *    authenticate the server (`dane-verify.ts`); when none is, TLS is
 *    still required but not authenticated (section 2.2: the host committed
 *    to TLS by publishing them).
 *
 * The reference identifiers a DANE-TA certificate may name (section
 * 3.2.2): the TLSA base domain, the original next-hop domain and, when the
 * MX lookup went through a CNAME, the expanded next-hop domain. For an
 * implicit MX: the base domain and the original domain.
 *
 * Logs one line per decision at `debug` (domain, MX host, outcome), and
 * failures at `warn`. Names only: no record content beyond counts.
 */

/** A recipient domain's route under DANE, and whether DANE applies to it. */
export interface DaneRoute {
  route: MxRoute;
  /** Set when the MX RRset (or its denial) is secure: DANE applies host by host. */
  secureMx: SecureMx | null;
}

/** A domain name as compared: lowercased, no trailing dot. */
function normalised(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Resolves `domain`'s MX route at the trusted resolver (#345), and whether
 * DANE applies to it; see the module comment. Never throws.
 */
export async function resolveDaneRoute(
  domain: string,
  options: SecureLookupOptions,
  random: () => number = Math.random,
): Promise<DaneRoute> {
  const nextHop = normalised(domain);
  const mx = await lookupSecure(nextHop, "MX", options);
  if (mx.kind === "failure") {
    logger.warn("DANE: MX lookup failed, delivery delayed", {
      domain: nextHop,
      code: mx.code,
    });
    return {
      route: {
        kind: "retry",
        error: `${nextHop}: DANE: MX lookup failed (${mx.code}); will retry`,
      },
      secureMx: null,
    };
  }
  if (mx.kind === "nxdomain") {
    return {
      route: { kind: "failed", error: `${nextHop}: domain does not exist` },
      secureMx: null,
    };
  }
  if (mx.kind === "nodata") {
    const secureMx = mx.secure
      ? { nextHop, expandedNextHop: mx.name, implicit: true }
      : null;
    return implicitDaneRoute(nextHop, secureMx, options);
  }

  if (mx.records.some((record) => record.exchange.length === 0)) {
    return {
      route: {
        kind: "failed",
        error: `${nextHop}: domain does not accept mail (null MX)`,
      },
      secureMx: null,
    };
  }
  const records: { exchange: string; priority: number }[] = [];
  for (const record of mx.records) {
    const exchange = dottedName(record.exchange);
    if (exchange !== null) records.push({ exchange, priority: record.preference });
  }
  if (records.length === 0) {
    return {
      route: { kind: "retry", error: `${nextHop}: no usable MX host name; will retry` },
      secureMx: null,
    };
  }
  logger.debug("DANE: MX records", { domain: nextHop, secure: mx.secure });
  return {
    route: { kind: "hosts", hosts: orderMxHosts(records, random), implicit: false },
    secureMx: mx.secure ? { nextHop, expandedNextHop: mx.name, implicit: false } : null,
  };
}

/**
 * The implicit MX (RFC 5321 5.1, RFC 7672 2.2.2): no MX records, the
 * domain's own addresses. When the MX denial is secure (DNSSEC in play),
 * any failed address lookup delays delivery (RFC 7672 2.1.2). When it is
 * not, this behaves like `mx-route.ts`'s implicit MX: one family with
 * addresses is enough, and only a failure with no address at all retries.
 */
async function implicitDaneRoute(
  domain: string,
  secureMx: SecureMx | null,
  options: SecureLookupOptions,
): Promise<DaneRoute> {
  const [a, aaaa] = await Promise.all([
    lookupSecure(domain, "A", options),
    lookupSecure(domain, "AAAA", options),
  ]);
  const answered = a.kind === "records" || aaaa.kind === "records";
  const failure = [a, aaaa].find((answer) => answer.kind === "failure");
  if (failure !== undefined && (secureMx !== null || !answered)) {
    const code = failure.kind === "failure" ? failure.code : "";
    return {
      route: {
        kind: "retry",
        error: `${domain}: address lookup failed temporarily (${code}); will retry`,
      },
      secureMx: null,
    };
  }
  if (!answered) {
    return {
      route: { kind: "failed", error: `${domain}: domain has no MX or address records` },
      secureMx: null,
    };
  }
  logger.debug("DANE: no MX records, implicit MX", {
    domain,
    secure: secureMx !== null,
  });
  return { route: { kind: "hosts", hosts: [domain], implicit: true }, secureMx };
}

/** What DANE says about one MX host of a domain with a secure MX RRset. */
export type DaneHostDecision =
  /** DANE applies: TLS required, and authenticated when `host.usable` is not empty. */
  | { kind: "dane"; addresses: string[]; host: DaneHost }
  /** DANE does not apply to this host: delivery as without DANE, to these addresses. */
  | { kind: "none"; addresses: string[] }
  /**
   * Not usable on this attempt: a lookup failed (`lookupFailed`), or the
   * host has no address. The next MX host is tried.
   */
  | { kind: "skip"; reason: string; lookupFailed: boolean };

/**
 * DANE's decision for `mxHost` (a host of `secureMx`'s domain) connected
 * to on `port`; see the module comment. Never throws.
 */
export async function decideDaneHost(
  mxHost: string,
  secureMx: SecureMx,
  port: number,
  options: SecureLookupOptions,
): Promise<DaneHostDecision> {
  const decision = await decide(normalised(mxHost), secureMx, port, options);
  const context = { domain: secureMx.nextHop, mxHost };
  if (decision.kind === "skip") {
    if (decision.lookupFailed) {
      logger.warn("DANE: MX host skipped, a DNSSEC lookup failed", {
        ...context,
        reason: decision.reason,
      });
    } else {
      logger.debug("DANE: MX host skipped", { ...context, reason: decision.reason });
    }
  } else if (decision.kind === "none") {
    logger.debug("DANE: not applicable to the MX host", context);
  } else {
    logger.debug("DANE: applies to the MX host", {
      ...context,
      baseDomain: decision.host.baseDomain,
      tlsaRecords: decision.host.records.length,
      usableRecords: decision.host.usable.length,
      mode: decision.host.usable.length > 0 ? "authenticated" : "encrypted-only",
    });
  }
  return decision;
}

/** {@link decideDaneHost} without its log line. */
async function decide(
  mxHost: string,
  secureMx: SecureMx,
  port: number,
  options: SecureLookupOptions,
): Promise<DaneHostDecision> {
  const [a, aaaa] = await Promise.all([
    lookupSecure(mxHost, "A", options),
    lookupSecure(mxHost, "AAAA", options),
  ]);
  if (a.kind === "failure" || aaaa.kind === "failure") {
    const code = a.kind === "failure" ? a.code : aaaa.kind === "failure" ? aaaa.code : "";
    return {
      kind: "skip",
      reason: `address lookup failed (${code})`,
      lookupFailed: true,
    };
  }
  /** The address answers that returned records: their names, security and addresses. */
  const answered: {
    name: string;
    secure: boolean;
    aliased: boolean;
    addresses: string[];
  }[] = [];
  for (const answer of [a, aaaa]) {
    if (answer.kind !== "records") continue;
    answered.push({
      name: answer.name,
      secure: answer.secure,
      aliased: answer.aliased,
      addresses: answer.records.map((record) => record.address),
    });
  }
  const addresses = answered.flatMap((answer) => answer.addresses);
  const first = answered[0];
  if (first === undefined || addresses.length === 0) {
    return { kind: "skip", reason: "no address records", lookupFailed: false };
  }

  const candidates = await baseDomainCandidates(mxHost, first.name, answered, options);
  if (candidates === "failure") {
    return { kind: "skip", reason: "CNAME lookup failed", lookupFailed: true };
  }

  for (const candidate of candidates) {
    const tlsa = await lookupSecure(`_${port}._tcp.${candidate}`, "TLSA", options);
    if (tlsa.kind === "failure") {
      return {
        kind: "skip",
        reason: `TLSA lookup failed (${tlsa.code})`,
        lookupFailed: true,
      };
    }
    if (tlsa.kind !== "records" || !tlsa.secure) continue;
    const records: TlsaRecord[] = tlsa.records.map(
      ({ usage, selector, matchingType, data }) => ({
        usage,
        selector,
        matchingType,
        data,
      }),
    );
    return {
      kind: "dane",
      addresses,
      host: {
        mxHost,
        baseDomain: candidate,
        referenceIds: referenceIds(candidate, secureMx),
        records,
        usable: usableTlsa(records),
      },
    };
  }
  return { kind: "none", addresses };
}

/**
 * The candidate TLSA base domains of `mxHost` (RFC 7672 sections 2.2.2 and
 * 2.2.3), from its address answers (`expanded` is their CNAME-expanded
 * name), or `"failure"` when the CNAME lookup that decides it failed.
 */
async function baseDomainCandidates(
  mxHost: string,
  expanded: string,
  answered: readonly { secure: boolean; aliased: boolean }[],
  options: SecureLookupOptions,
): Promise<string[] | "failure"> {
  const secure = answered.every((answer) => answer.secure);
  const aliased = answered.some((answer) => answer.aliased) && expanded !== mxHost;
  if (!aliased) return secure ? [mxHost] : [];
  if (secure) return [expanded, mxHost];
  /** Insecure CNAME (2.2.2): the host name is a candidate only if its own CNAME is secure. */
  const cname = await lookupSecure(mxHost, "CNAME", options);
  if (cname.kind === "failure") return "failure";
  return cname.kind === "records" && cname.secure ? [mxHost] : [];
}

/** The reference identifiers of a DANE-TA name check (RFC 7672 section 3.2.2), base domain first. */
function referenceIds(baseDomain: string, secureMx: SecureMx): string[] {
  const names = secureMx.implicit
    ? [baseDomain, secureMx.nextHop]
    : [baseDomain, secureMx.nextHop, secureMx.expandedNextHop];
  return [...new Set(names.map(normalised))];
}
