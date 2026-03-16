import { resolveTxt as dnsResolveTxt } from "dns/promises";
import { eq } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { domains } from "../models/domain.schema.ts";
import { logger } from "../../../utils/logger.ts";
import type { Domain } from "../types/domain.types.ts";

export interface VerificationResult {
  spf: boolean;
  dkim: boolean;
  dmarc: boolean;
}

/**
 * Resolves all TXT records for a hostname and flattens them
 * into a single string array (TXT records can be multi-part).
 */
async function resolveTxt(hostname: string): Promise<string[]> {
  try {
    const records = await dnsResolveTxt(hostname);
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

/**
 * Checks whether the domain has a valid SPF TXT record.
 * Looks for a record starting with `v=spf1`.
 */
async function verifySPF(domainName: string): Promise<boolean> {
  const records = await resolveTxt(domainName);
  return records.some((r) => r.startsWith("v=spf1"));
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
): Promise<boolean> {
  if (!publicKeyPem) return false;

  const host = `${selector}._domainkey.${domainName}`;
  const records = await resolveTxt(host);
  const expectedKey = extractPubKeyBase64(publicKeyPem);

  const allCandidates = [...records, records.join("")];

  return allCandidates.some((r) => {
    const cleaned = r.replace(/\s/g, "");
    return cleaned.includes("v=DKIM1") && cleaned.includes(`p=${expectedKey}`);
  });
}

/**
 * Checks whether the domain has a DMARC TXT record at `_dmarc.<domain>`.
 */
async function verifyDMARC(domainName: string): Promise<boolean> {
  const host = `_dmarc.${domainName}`;
  const records = await resolveTxt(host);
  return records.some((r) => r.startsWith("v=DMARC1"));
}

/**
 * Runs SPF, DKIM, and DMARC DNS verification for a domain,
 * updates the database with the results, and returns the outcome.
 */
export async function verifyDomain(domain: Domain): Promise<VerificationResult> {
  logger.info("Verifying DNS records", { domain: domain.name });

  const [spf, dkim, dmarc] = await Promise.all([
    verifySPF(domain.name),
    verifyDKIM(domain.name, domain.dkimSelector, domain.dkimPublicKey),
    verifyDMARC(domain.name),
  ]);

  const result: VerificationResult = { spf, dkim, dmarc };

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
