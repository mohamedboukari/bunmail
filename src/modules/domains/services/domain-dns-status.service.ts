import { resolveMx, resolveTxt } from "dns/promises";
import { config } from "../../../config.ts";
import {
  MX_ANSWER_TTL_MS,
  MX_ERROR_TTL_MS,
  clearMxCache,
  resolveMxStatus,
  type MxStatus,
} from "../../bounces/services/return-path-mx.ts";
import type { DmarcCheck } from "../types/domain.types.ts";
import { checkDmarc } from "./dmarc-check.service.ts";

/**
 * The live DNS status of a domain shown by the domains API and the domain
 * page (#250): its DMARC check and its MX status. Informational only,
 * nothing gates on it.
 *
 * Lookups follow the return-path MX conventions (#236): `dns/promises`, a
 * 5 second timeout per lookup, answers cached in memory for an hour and
 * errors for five minutes, at most 10,000 domains. The MX answer shares the
 * return-path cache, so the page shows the answer the mailer uses. Running
 * **Verify** replaces the cached DMARC check with a fresh one.
 */

/** The DNS status of one domain. */
export interface DomainDnsStatus {
  dmarc: DmarcCheck;
  mx: MxStatus;
}

/** DNS lookups and clock, replaceable in tests. */
export interface DomainDnsDeps {
  resolveTxt: (hostname: string) => Promise<string[][]>;
  resolveMx: (domain: string) => Promise<Array<{ exchange: string }>>;
  now: () => number;
  timeoutMs: number;
}

const realDeps: DomainDnsDeps = {
  resolveTxt,
  resolveMx,
  now: () => Date.now(),
  timeoutMs: 5_000,
};

let deps: DomainDnsDeps = realDeps;

/** Most domains whose DMARC check is cached; the oldest is evicted beyond this. */
const DMARC_CACHE_MAX_ENTRIES = 10_000;

interface CacheEntry {
  check: DmarcCheck;
  expiresAt: number;
}

/** Cached DMARC checks by lowercased domain name; insertion order = age. */
const dmarcCache = new Map<string, CacheEntry>();

/** Checks in flight, so concurrent requests for one domain share one lookup. */
const inflight = new Map<string, Promise<DmarcCheck>>();

/**
 * Replaces the DNS lookups (tests), or restores the real ones with `null`.
 * Empties the DMARC and MX caches either way.
 */
export function setDomainDnsDeps(override: Partial<DomainDnsDeps> | null): void {
  deps = override === null ? realDeps : { ...realDeps, ...override };
  dmarcCache.clear();
  inflight.clear();
  clearMxCache();
}

function cacheKey(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Stores a DMARC check for `name`: for an hour, or five minutes after a
 * DNS error. `verifyDomain` calls it so the page shows the fresh result.
 */
export function rememberDmarcCheck(name: string, check: DmarcCheck): void {
  const key = cacheKey(name);
  const ttl = check.status === "error" ? MX_ERROR_TTL_MS : MX_ANSWER_TTL_MS;
  dmarcCache.delete(key);
  dmarcCache.set(key, { check, expiresAt: deps.now() + ttl });
  while (dmarcCache.size > DMARC_CACHE_MAX_ENTRIES) {
    const oldest = dmarcCache.keys().next().value;
    if (oldest === undefined) break;
    dmarcCache.delete(oldest);
  }
}

/** The cached DMARC check of `name`, looked up when missing or expired. */
async function cachedDmarcCheck(name: string): Promise<DmarcCheck> {
  const key = cacheKey(name);
  const cached = dmarcCache.get(key);
  if (cached && cached.expiresAt > deps.now()) return cached.check;
  const pending = inflight.get(key);
  if (pending) return pending;
  const lookup = checkDmarc(key, deps)
    .then((check) => {
      rememberDmarcCheck(key, check);
      return check;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, lookup);
  return lookup;
}

/** The DMARC check and MX status of a domain. Never rejects. */
export async function getDomainDnsStatus(name: string): Promise<DomainDnsStatus> {
  const [dmarc, mx] = await Promise.all([
    cachedDmarcCheck(name),
    resolveMxStatus(name, config.mail.hostname, deps),
  ]);
  return { dmarc, mx };
}

/** Whether one mail flow is active for a domain, with why. */
export interface MailFlowFeature {
  name: string;
  active: boolean;
  explanation: string;
}

/** Why the flows that need the MX are off, by MX status. */
function inactiveCause(mx: MxStatus, smtpEnabled: boolean): string {
  if (!smtpEnabled) return "Inbound SMTP is off (SMTP_ENABLED=false).";
  switch (mx.status) {
    case "elsewhere":
      return `The MX points at ${mx.hosts.join(", ")}, so that host receives this domain's mail.`;
    case "none":
      return "The domain has no MX record.";
    case "error":
      return "The MX lookup failed: the status is retried within five minutes.";
    case "here":
      return "";
  }
}

/**
 * Which mail flows BunMail handles for a domain (#250), from its MX status
 * and `SMTP_ENABLED`. All four need inbound SMTP on and the MX pointing at
 * `MAIL_HOSTNAME`; sending does not need either.
 */
export function mailFlowFeatures(mx: MxStatus, smtpEnabled: boolean): MailFlowFeature[] {
  const active = smtpEnabled && mx.status === "here";
  const cause = inactiveCause(mx, smtpEnabled);
  return [
    {
      name: "Signed return paths",
      active,
      explanation: active
        ? "Outbound mail uses a signed b+...@ envelope sender on this domain, so each bounce is matched to its email and recipient."
        : `${cause} The From address stays the envelope sender.`,
    },
    {
      name: "Async bounces",
      active,
      explanation: active
        ? "Bounces that arrive after delivery come back here: the email is marked bounced and a hard bounce suppresses the recipient."
        : `${cause} Late bounces do not reach BunMail.`,
    },
    {
      name: "DMARC reports",
      active,
      explanation: active
        ? "Aggregate reports sent to an address on this domain are stored under DMARC Reports."
        : `${cause} Reports sent to an address on this domain do not reach BunMail.`,
    },
    {
      name: "Inbound mail",
      active,
      explanation: active
        ? "Mail to this domain is accepted and listed under Inbound."
        : `${cause} BunMail does not receive mail for this domain.`,
    },
  ];
}
