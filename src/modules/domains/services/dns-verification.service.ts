import { spf as mailauthSpf } from "mailauth/lib/spf";
import { logger } from "../../../utils/logger.ts";
import type { Domain } from "../types/domain.types.ts";
import { config } from "../../../config.ts";
import { resolveSendingIps, type SendingIps } from "./sending-ips.service.ts";
import { checkDmarc } from "./dmarc-check.service.ts";
import { dkimRecordHost, dkimRecordsMatchKey } from "./dkim-keys.ts";
import { rememberDmarcCheck, resolveDomainTxt } from "./domain-dns-status.service.ts";
import { applyDomainCheck } from "./domain-check.service.ts";
import type { DnsCheckOutcome, DomainCheckResult } from "../types/domain-check.types.ts";

export interface VerificationResult {
  /** True only when the check passed (`checks.spf.status === "pass"`). */
  spf: boolean;
  dkim: boolean;
  dmarc: boolean;
  /** Why SPF passed or failed, for the operator (#247). */
  spfReason?: string;
  /** Why DKIM passed or failed (#250). */
  dkimReason?: string;
  /** Why DMARC passed or failed, for the operator (#250). */
  dmarcReason?: string;
  /** Each check as pass, fail or unknown (a failed lookup) (#250). */
  checks?: DomainCheckResult;
}

/** How a verification runs (#250). */
export interface VerifyOptions {
  /**
   * `manual`: Verify, or the inline check of a send. `scheduled`: the
   * re-verification loop, which logs per domain at `debug` only and never
   * stores a failed DMARC lookup in the page's status cache (a DNS blip
   * must not replace a good cached answer).
   */
  source?: "manual" | "scheduled";
  /** The check time (tests). */
  now?: Date;
}

/** DNS and SPF evaluation, injectable for tests (#247). */
export interface VerificationDeps {
  resolveTxt: (hostname: string) => Promise<string[][]>;
  /** RFC 7208 result (`pass`, `fail`, `softfail`, ...) of `domain` for mail sent from `ip`. */
  evaluateSpf: (domain: string, ip: string) => Promise<string>;
  sendingIps: () => Promise<SendingIps>;
}

/**
 * Evaluates SPF with mailauth in strict RFC 7208 mode: every mechanism,
 * macros, includes and redirects, the 10-lookup and 2-void-lookup limits,
 * capped at 10 seconds (a slow chain is a `temperror`, not a hang).
 */
async function evaluateSpfWithMailauth(domain: string, ip: string): Promise<string> {
  const result = await mailauthSpf({
    sender: `postmaster@${domain}`,
    ip,
    helo: config.mail.hostname,
    mta: config.mail.hostname,
    strict: true,
    maxElapsedTime: 10_000,
  });
  return result.status.result;
}

const defaultDeps: VerificationDeps = {
  /** The domains module's DNS seam (`setDomainDnsDeps` replaces it in tests). */
  resolveTxt: resolveDomainTxt,
  evaluateSpf: evaluateSpfWithMailauth,
  sendingIps: () => resolveSendingIps(),
};

/** DNS answers meaning "no such record", as opposed to a failed lookup. */
const NO_RECORD_CODES = new Set(["ENOTFOUND", "ENODATA"]);

/** Longest reason stored per check: they quote names and IPs, never TXT values. */
const REASON_MAX = 300;

function outcome(status: DnsCheckOutcome["status"], reason: string): DnsCheckOutcome {
  return {
    status,
    reason: reason.length > REASON_MAX ? `${reason.slice(0, REASON_MAX)}...` : reason,
  };
}

/** The `code` of a DNS error, or an empty string. */
function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error
    ? String(Reflect.get(error, "code"))
    : "";
}

/**
 * The TXT records at `hostname`, joined per record. `null` when the lookup
 * itself failed (SERVFAIL, timeout, network): an empty list means the
 * name has no TXT record.
 */
async function lookupTxt(
  hostname: string,
  deps: VerificationDeps,
): Promise<string[] | null> {
  try {
    return (await deps.resolveTxt(hostname)).map((parts) => parts.join(""));
  } catch (error: unknown) {
    return NO_RECORD_CODES.has(errorCode(error)) ? [] : null;
  }
}

/** The version tag that starts an SPF record (RFC 7208 4.5). */
const SPF_RECORD = /^v=spf1(\s|$)/i;

/**
 * Checks that the domain's SPF record authorizes this server (#247).
 *
 * The record must exist exactly once (two records are a permerror that
 * also breaks the domain's other senders), carry no `<placeholder>`, and
 * give `pass` for every sending IP (`MAIL_PUBLIC_IP`, or the A/AAAA records
 * of `MAIL_HOSTNAME`). A record that merely exists (`v=spf1 -all`, a
 * Google Workspace record that does not include this server) no longer
 * counts as verified.
 *
 * `unknown` (#250) when a lookup failed: the domain's TXT lookup, an SPF
 * `temperror`, or no known sending IP (this server's own DNS or config,
 * not the domain's record).
 */
async function verifySPF(
  domainName: string,
  deps: VerificationDeps,
): Promise<DnsCheckOutcome> {
  const txt = await lookupTxt(domainName, deps);
  if (txt === null) {
    return outcome("unknown", "DNS lookup failed (temporary): try again later");
  }

  const records = txt.filter((record) => SPF_RECORD.test(record));
  if (records.length === 0) return outcome("fail", "No SPF record");
  if (records.length > 1) {
    return outcome(
      "fail",
      "More than one SPF record (permerror): merge them into one record",
    );
  }
  if (/[<>]/.test(records[0] ?? "")) {
    return outcome(
      "fail",
      "The SPF record still contains a placeholder such as <YOUR_SERVER_IP>",
    );
  }

  const { ips, source } = await deps.sendingIps();
  if (ips.length === 0) {
    return outcome(
      "unknown",
      "Sending IPs unknown: set MAIL_PUBLIC_IP or give MAIL_HOSTNAME an A or AAAA record",
    );
  }
  for (const ip of ips) {
    let result: string;
    try {
      result = await deps.evaluateSpf(domainName, ip);
    } catch {
      result = "temperror";
    }
    if (result === "temperror") {
      return outcome(
        "unknown",
        `SPF temperror for ${ip}: a DNS lookup failed, try again later`,
      );
    }
    if (result !== "pass") {
      return outcome(
        "fail",
        `SPF ${result} for ${ip} (from ${source}): the record must authorize this server, for example with a:${config.mail.hostname}`,
      );
    }
  }
  return outcome("pass", `SPF passes for ${ips.join(", ")}`);
}

/**
 * Checks whether the domain has a valid DKIM TXT record at
 * `<selector>._domainkey.<domain>` containing the expected public key.
 *
 * Some DNS providers split long TXT values across multiple records
 * rather than multiple chunks within a single record, so we also
 * check the concatenation of all records. `unknown` when the lookup
 * failed (#250).
 */
async function verifyDKIM(
  domainName: string,
  selector: string,
  publicKeyPem: string | null,
  deps: VerificationDeps,
): Promise<DnsCheckOutcome> {
  if (!publicKeyPem) return outcome("fail", "No DKIM key on file for this domain");

  const host = dkimRecordHost(selector, domainName);
  const records = await lookupTxt(host, deps);
  if (records === null) {
    return outcome(
      "unknown",
      `DNS lookup of ${host} failed (temporary): try again later`,
    );
  }
  if (records.length === 0) return outcome("fail", `No TXT record at ${host}`);
  /** The same comparison completing a key rotation uses (#250). */
  if (!dkimRecordsMatchKey(records, publicKeyPem)) {
    return outcome("fail", `The TXT record at ${host} does not carry this domain's key`);
  }
  return outcome("pass", `The DKIM key is published at ${host}`);
}

/**
 * Checks the domain's DMARC record (#250, `dmarc-check.service.ts`):
 * exactly one `v=DMARC1` record, at `_dmarc.<domain>` or inherited from the
 * organizational domain, with a valid `p=`. Always a fresh lookup, never
 * the status cache. The result refreshes the DMARC check the domain page
 * and API show; a failed lookup does so only for a manual Verify, so the
 * loop never replaces a good cached answer with a DNS blip.
 */
async function verifyDMARC(
  domainName: string,
  deps: VerificationDeps,
  source: VerifyOptions["source"],
): Promise<DnsCheckOutcome> {
  const check = await checkDmarc(domainName, { resolveTxt: deps.resolveTxt });
  if (check.status !== "error" || source !== "scheduled") {
    rememberDmarcCheck(domainName, check);
  }
  if (check.status === "error") return outcome("unknown", check.reason);
  return outcome(check.ok ? "pass" : "fail", check.reason);
}

/**
 * Runs the SPF, DKIM and DMARC checks of a domain (#250) without storing
 * anything. Never rejects on a DNS error: that check is `unknown`.
 */
export async function runDnsChecks(
  domain: Pick<Domain, "name" | "dkimSelector" | "dkimPublicKey">,
  deps: VerificationDeps = defaultDeps,
  options: VerifyOptions = {},
): Promise<DomainCheckResult> {
  const now = options.now ?? new Date();
  const [spf, dkim, dmarc] = await Promise.all([
    verifySPF(domain.name, deps),
    verifyDKIM(domain.name, domain.dkimSelector, domain.dkimPublicKey, deps),
    verifyDMARC(domain.name, deps, options.source),
  ]);
  return { spf, dkim, dmarc, checkedAt: now.toISOString() };
}

/**
 * Runs SPF, DKIM, and DMARC DNS verification for a domain, stores the
 * outcome (`applyDomainCheck`: the flags, `verifiedAt`, the failure count,
 * the check time and result, the next scheduled check, and the
 * `domain.verified` or `domain.verification_failed` event), and returns it.
 * Verify, the inline check of a send and the re-verification loop all run
 * this, so they follow the same rules (#250).
 */
export async function verifyDomain(
  domain: Domain,
  deps: VerificationDeps = defaultDeps,
  options: VerifyOptions = {},
): Promise<VerificationResult> {
  const scheduled = options.source === "scheduled";
  logger.debug("Verifying DNS records", { domainId: domain.id, domain: domain.name });

  const now = options.now ?? new Date();
  const checks = await runDnsChecks(domain, deps, { ...options, now });
  const result: VerificationResult = {
    spf: checks.spf.status === "pass",
    dkim: checks.dkim.status === "pass",
    dmarc: checks.dmarc.status === "pass",
    spfReason: checks.spf.reason,
    dkimReason: checks.dkim.reason,
    dmarcReason: checks.dmarc.reason,
    checks,
  };

  const summary = {
    domainId: domain.id,
    domain: domain.name,
    spf: checks.spf.status,
    dkim: checks.dkim.status,
    dmarc: checks.dmarc.status,
  };
  if (scheduled) logger.debug("DNS verification result", summary);
  else logger.info("DNS verification result", summary);

  await applyDomainCheck(domain.id, checks, now);
  return result;
}
