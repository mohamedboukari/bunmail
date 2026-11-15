import { logger } from "../../../utils/logger.ts";
import type { BimiCheck, BimiFinding, BimiStatus } from "../types/bimi.types.ts";
import { checkBimiLogo, type BimiLogoDeps } from "./bimi-logo.ts";
import {
  dmarcPrerequisite,
  lookupBimiRecord,
  quote,
  type BimiPart,
  type BimiPartOutcome,
} from "./bimi-record.ts";
import { checkDmarc } from "./dmarc-check.service.ts";
import { rememberDmarcCheck, resolveDomainTxt } from "./domain-dns-status.service.ts";

/**
 * The BIMI readiness check of a domain (#415). BunMail sends nothing
 * differently for BIMI; this tells the operator whether mailbox providers
 * could show the domain's logo:
 *
 * 1. the record at `default._bimi.<domain>` (`bimi-record.ts`),
 * 2. the DMARC prerequisite, from a fresh DMARC check that also refreshes
 *    the DMARC panel, as Verify does,
 * 3. the logo at `l=`, fetched through the SSRF guard and checked against
 *    SVG Tiny PS (`bimi-logo.ts`, `bimi-svg.ts`),
 * 4. the certificate at `a=`: presence only. Its chain is not validated;
 *    Gmail and Apple Mail show the logo only with a VMC or CMC.
 *
 * Runs only when an admin asks for it (the domain page's Check BIMI
 * button), never on page load. The last result per domain is kept in
 * process memory for {@link BIMI_RESULT_TTL_MS}, for the page to show
 * after the redirect: nothing is stored in the database, and with several
 * replicas the page shows it only when the same replica serves it.
 *
 * Logs one `info` line per check (the domain and each part's outcome,
 * never a URL or a TXT value) and a `warn` when a lookup or the logo
 * fetch failed for a temporary reason.
 */

/** Longest the record lookup may take, the organizational fallback included. */
const BIMI_DNS_TIMEOUT_MS = 5_000;

/** How long the page shows the last check of a domain. */
const BIMI_RESULT_TTL_MS = 30 * 60 * 1000;

/** Most domains whose last check is kept; the oldest is evicted beyond this. */
const BIMI_RESULT_MAX_ENTRIES = 1_000;

/** The lookups, the logo fetch and the clock, replaceable in tests. */
export interface BimiCheckDeps {
  resolveTxt: (hostname: string) => Promise<string[][]>;
  /** The logo fetch; absent, the seam of `bimi-logo.ts` (`setBimiLogoDeps`). */
  logo?: BimiLogoDeps;
  dnsTimeoutMs: number;
  now: () => Date;
}

const defaultDeps: BimiCheckDeps = {
  /** The domains module's DNS seam (`setDomainDnsDeps` replaces it in tests). */
  resolveTxt: resolveDomainTxt,
  dnsTimeoutMs: BIMI_DNS_TIMEOUT_MS,
  now: () => new Date(),
};

/** A finding about the certificate. */
function certificateFinding(
  severity: BimiFinding["severity"],
  text: string,
): BimiFinding {
  return { area: "certificate", severity, text };
}

/** The `a=` findings: presence only, the chain is not validated. */
function certificatePart(authorityUrl: string | null): BimiFinding[] {
  if (authorityUrl === null) {
    return [
      certificateFinding(
        "warn",
        "No a= certificate: Gmail and Apple Mail show the logo only with a Verified Mark Certificate (VMC) or Common Mark Certificate (CMC); some other providers show it without one",
      ),
    ];
  }
  return [
    certificateFinding(
      "pass",
      `a= names a certificate at ${quote(authorityUrl)} (https)`,
    ),
    certificateFinding(
      "info",
      "BunMail does not fetch or validate the certificate: its issuer, chain and the logo it carries are checked by the mailbox providers",
    ),
  ];
}

/** The verdict from the parts of a valid record. */
function verdict(outcomes: BimiPartOutcome[]): BimiStatus {
  if (outcomes.includes("fail")) return "not-ready";
  if (outcomes.includes("unknown")) return "error";
  return "ready";
}

/** The summary line of a verdict. */
function summaryOf(status: BimiStatus, host: string, hasCertificate: boolean): string {
  switch (status) {
    case "ready":
      return hasCertificate
        ? "BIMI-ready: the record, the DMARC policy and the logo pass every check BunMail runs"
        : "BIMI-ready for providers that need no certificate: Gmail and Apple Mail also need a VMC or CMC (a=)";
    case "not-ready":
      return "Not BIMI-ready: fix the failed items below";
    case "declined":
      return "The BIMI record declines a logo";
    case "missing":
      return `No BIMI record: publish one at ${host}`;
    case "error":
      return "The check could not finish: a lookup or the logo fetch failed. Try again later";
  }
}

/**
 * Checks whether `domain` is BIMI-ready (#415). Never rejects: a failed
 * lookup or fetch is a finding and, when nothing failed for good, the
 * `error` verdict.
 */
export async function checkBimi(
  domain: string,
  overrides: Partial<BimiCheckDeps> = {},
): Promise<BimiCheck> {
  const deps: BimiCheckDeps = { ...defaultDeps, ...overrides };
  const checkedAt = deps.now().toISOString();
  const [lookup, dmarc] = await Promise.all([
    lookupBimiRecord(domain, {
      resolveTxt: deps.resolveTxt,
      timeoutMs: deps.dnsTimeoutMs,
    }),
    checkDmarc(domain, { resolveTxt: deps.resolveTxt }),
  ]);
  /** The same fresh check Verify stores: the DMARC panel shows it too. */
  rememberDmarcCheck(domain, dmarc);
  const prerequisite = dmarcPrerequisite(dmarc);
  const { record } = lookup;

  let logo: (BimiPart & { fetch: string }) | null = null;
  let status: BimiStatus;
  const findings: BimiFinding[] = [...lookup.findings, ...prerequisite.findings];
  switch (record.status) {
    case "error":
      status = "error";
      break;
    case "missing":
    case "declined":
      status = record.status;
      break;
    case "invalid":
    case "multiple":
      status = "not-ready";
      break;
    case "valid": {
      const outcomes: BimiPartOutcome[] = [prerequisite.outcome];
      if (record.logoUrl !== null) {
        logo = await checkBimiLogo(record.logoUrl, deps.logo);
        findings.push(...logo.findings);
        outcomes.push(logo.outcome);
      } else {
        findings.push({
          area: "logo",
          severity: "info",
          text: "No l= URL: the logo inside the certificate is not checked",
        });
      }
      findings.push(...certificatePart(record.authorityUrl));
      status = verdict(outcomes);
      break;
    }
  }

  const name = domain.trim().toLowerCase();
  if (record.status === "error") {
    logger.warn("BIMI record lookup failed", { domain: name });
  }
  if (logo?.outcome === "unknown") {
    logger.warn("BIMI logo fetch failed", { domain: name });
  }
  logger.info("BIMI check", {
    domain: name,
    status,
    record: record.status,
    inherited: record.inherited,
    dmarc: prerequisite.outcome,
    logo: logo?.outcome ?? "skipped",
    certificate: record.authorityUrl !== null,
  });

  return {
    status,
    summary: summaryOf(status, record.host, record.authorityUrl !== null),
    record,
    /** Grouped by area, in display order; within one, as found. */
    findings: (["record", "dmarc", "logo", "certificate"] as const).flatMap((area) =>
      findings.filter((finding) => finding.area === area),
    ),
    checkedAt,
  };
}

/* ─── Last result per domain ─── */

interface StoredCheck {
  check: BimiCheck;
  expiresAt: number;
}

/** The last check by domain id; insertion order = age. */
const lastChecks = new Map<string, StoredCheck>();

/** Keeps `check` as the last BIMI check of the domain `domainId`. */
export function rememberBimiCheck(
  domainId: string,
  check: BimiCheck,
  now: number = Date.now(),
): void {
  lastChecks.delete(domainId);
  lastChecks.set(domainId, { check, expiresAt: now + BIMI_RESULT_TTL_MS });
  while (lastChecks.size > BIMI_RESULT_MAX_ENTRIES) {
    const oldest = lastChecks.keys().next().value;
    if (oldest === undefined) break;
    lastChecks.delete(oldest);
  }
}

/** The last BIMI check of the domain `domainId` still kept, or null. */
export function lastBimiCheck(
  domainId: string,
  now: number = Date.now(),
): BimiCheck | null {
  const stored = lastChecks.get(domainId);
  if (stored === undefined) return null;
  if (stored.expiresAt <= now) {
    lastChecks.delete(domainId);
    return null;
  }
  return stored.check;
}
