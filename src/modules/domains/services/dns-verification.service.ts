import { eq } from "drizzle-orm";
import { spf as mailauthSpf } from "mailauth/lib/spf";
import { db } from "../../../db/index.ts";
import { domains } from "../models/domain.schema.ts";
import { logger } from "../../../utils/logger.ts";
import type { Domain } from "../types/domain.types.ts";
import { config } from "../../../config.ts";
import { resolveSendingIps, type SendingIps } from "./sending-ips.service.ts";
import { checkDmarc } from "./dmarc-check.service.ts";
import { rememberDmarcCheck, resolveDomainTxt } from "./domain-dns-status.service.ts";

export interface VerificationResult {
  spf: boolean;
  dkim: boolean;
  dmarc: boolean;
  /** Why SPF passed or failed, for the operator (#247). */
  spfReason?: string;
  /** Why DMARC passed or failed, for the operator (#250). */
  dmarcReason?: string;
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

/**
 * Resolves all TXT records for a hostname and flattens them
 * into a single string array (TXT records can be multi-part).
 */
async function resolveTxt(hostname: string, deps: VerificationDeps): Promise<string[]> {
  try {
    const records = await deps.resolveTxt(hostname);
    return records.map((parts) => parts.join(""));
  } catch {
    return [];
  }
}

/**
 * Extracts the raw base64 public key from a PEM-encoded key,
 * stripping headers, footers, and whitespace.
 */
function extractPubKeyBase64(pem: string): string {
  return pem
    .replace(/-----BEGIN PUBLIC KEY-----/g, "")
    .replace(/-----END PUBLIC KEY-----/g, "")
    .replace(/\s/g, "");
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
 */
async function verifySPF(
  domainName: string,
  deps: VerificationDeps,
): Promise<{ ok: boolean; reason: string }> {
  let txt: string[];
  try {
    txt = (await deps.resolveTxt(domainName)).map((parts) => parts.join(""));
  } catch (error: unknown) {
    const code =
      error instanceof Error && "code" in error ? String(Reflect.get(error, "code")) : "";
    if (!NO_RECORD_CODES.has(code)) {
      return { ok: false, reason: "DNS lookup failed (temporary): try again later" };
    }
    txt = [];
  }

  const records = txt.filter((record) => SPF_RECORD.test(record));
  if (records.length === 0) return { ok: false, reason: "No SPF record" };
  if (records.length > 1) {
    return {
      ok: false,
      reason: "More than one SPF record (permerror): merge them into one record",
    };
  }
  if (/[<>]/.test(records[0] ?? "")) {
    return {
      ok: false,
      reason: "The SPF record still contains a placeholder such as <YOUR_SERVER_IP>",
    };
  }

  const { ips, source } = await deps.sendingIps();
  if (ips.length === 0) {
    return {
      ok: false,
      reason:
        "Sending IPs unknown: set MAIL_PUBLIC_IP or give MAIL_HOSTNAME an A or AAAA record",
    };
  }
  for (const ip of ips) {
    const result = await deps.evaluateSpf(domainName, ip);
    if (result !== "pass") {
      return {
        ok: false,
        reason: `SPF ${result} for ${ip} (from ${source}): the record must authorize this server, for example with a:${config.mail.hostname}`,
      };
    }
  }
  return { ok: true, reason: `SPF passes for ${ips.join(", ")}` };
}

/**
 * Checks whether the domain has a valid DKIM TXT record at
 * `<selector>._domainkey.<domain>` containing the expected public key.
 *
 * Some DNS providers split long TXT values across multiple records
 * rather than multiple chunks within a single record, so we also
 * check the concatenation of all records.
 */
async function verifyDKIM(
  domainName: string,
  selector: string,
  publicKeyPem: string | null,
  deps: VerificationDeps,
): Promise<boolean> {
  if (!publicKeyPem) return false;

  const host = `${selector}._domainkey.${domainName}`;
  const records = await resolveTxt(host, deps);
  const expectedKey = extractPubKeyBase64(publicKeyPem);

  const allCandidates = [...records, records.join("")];

  return allCandidates.some((r) => {
    const cleaned = r.replace(/\s/g, "");
    return cleaned.includes("v=DKIM1") && cleaned.includes(`p=${expectedKey}`);
  });
}

/**
 * Checks the domain's DMARC record (#250, `dmarc-check.service.ts`):
 * exactly one `v=DMARC1` record, at `_dmarc.<domain>` or inherited from the
 * organizational domain, with a valid `p=`. The result also refreshes the
 * DMARC check the domain page and API show.
 */
async function verifyDMARC(
  domainName: string,
  deps: VerificationDeps,
): Promise<{ ok: boolean; reason: string }> {
  const check = await checkDmarc(domainName, { resolveTxt: deps.resolveTxt });
  rememberDmarcCheck(domainName, check);
  return { ok: check.ok, reason: check.reason };
}

/**
 * Runs SPF, DKIM, and DMARC DNS verification for a domain,
 * updates the database with the results, and returns the outcome.
 */
export async function verifyDomain(
  domain: Domain,
  deps: VerificationDeps = defaultDeps,
): Promise<VerificationResult> {
  logger.info("Verifying DNS records", { domain: domain.name });

  const [spfCheck, dkim, dmarcCheck] = await Promise.all([
    verifySPF(domain.name, deps),
    verifyDKIM(domain.name, domain.dkimSelector, domain.dkimPublicKey, deps),
    verifyDMARC(domain.name, deps),
  ]);
  const spf = spfCheck.ok;
  const dmarc = dmarcCheck.ok;

  const result: VerificationResult = {
    spf,
    dkim,
    dmarc,
    spfReason: spfCheck.reason,
    dmarcReason: dmarcCheck.reason,
  };

  logger.info("DNS verification result", { domain: domain.name, ...result });

  const now = new Date();
  await db
    .update(domains)
    .set({
      spfVerified: spf,
      dkimVerified: dkim,
      dmarcVerified: dmarc,
      verifiedAt: now,
      updatedAt: now,
    })
    .where(eq(domains.id, domain.id));

  return result;
}
