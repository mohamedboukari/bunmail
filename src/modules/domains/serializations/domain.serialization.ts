import type { MxStatus } from "../../bounces/services/return-path-mx.ts";
import { getDkimDnsRecord } from "../services/domain.service.ts";
import type { DomainDnsStatus } from "../services/domain-dns-status.service.ts";
import {
  PREVIOUS_DKIM_SELECTOR_ADVICE,
  dkimRecordHost,
  dkimRecordValue,
} from "../services/dkim-keys.ts";
import { getRequiredDnsRecords } from "../services/required-dns-records.ts";
import type { DmarcCheck, Domain, RequiredDnsRecord } from "../types/domain.types.ts";
import type { DomainCheckResult } from "../types/domain-check.types.ts";

/** A DKIM key rotation in progress (#250): the record to publish before completing it. */
export interface SerializedDkimPending {
  selector: string;
  /** Where the pending TXT record goes: `<selector>._domainkey.<domain>`. */
  host: string;
  /** Its value, unsplit like `dkimDnsRecord` (`dnsRecords` has it split). */
  dnsRecord: string;
  /** When the rotation started. */
  createdAt: Date | null;
}

/** The selector active before the last completed rotation (#250). BunMail no longer signs with it. */
export interface SerializedDkimPrevious {
  selector: string;
  host: string;
  /** Its TXT value, to recognise the record to keep for now; null if unknown. */
  dnsRecord: string | null;
  /** When the rotation switched away from it. */
  rotatedAt: Date | null;
  /** What to do with its record. */
  advice: string;
}

/**
 * Shape of a domain in API responses.
 * Hides the DKIM private key: it must never be exposed in API responses.
 * Exposes the DKIM DNS record value so users can set up their DNS.
 */
export interface SerializedDomain {
  id: string;
  name: string;
  dkimSelector: string;
  dkimDnsRecord: string | null;
  /** The pending key rotation (#250), or null when none is pending. */
  dkimPending: SerializedDkimPending | null;
  /** The previous selector after a rotation (#250), or null before the first one. */
  dkimPrevious: SerializedDkimPrevious | null;
  spfVerified: boolean;
  dkimVerified: boolean;
  dmarcVerified: boolean;
  /**
   * When every required check (SPF, DKIM, DMARC) passed and has kept
   * passing (#250); null when not verified or flipped to failing.
   */
  verifiedAt: Date | null;
  /** When the DNS checks last ran, by Verify or the re-verification loop (#250). */
  lastCheckedAt: Date | null;
  /** The last check per record: `pass`, `fail` or `unknown`, with a reason (#250). */
  lastCheckResult: DomainCheckResult | null;
  /** Mailbox used for `List-Unsubscribe`; null means the mailer falls back to `unsubscribe@<name>`. */
  unsubscribeEmail: string | null;
  /** One-click HTTPS unsubscribe endpoint; null disables `List-Unsubscribe-Post`. */
  unsubscribeUrl: string | null;
  /** Address notified on inbound mail for this domain; null disables notifications. */
  notifyEmail: string | null;
  /** The DNS records to publish for this domain (#250). */
  dnsRecords: RequiredDnsRecord[];
  /** The current DMARC check (#250); null when not looked up (create, update, delete). */
  dmarc: DmarcCheck | null;
  /** Where the domain's MX points (#250), informational; null when not looked up (create, update, delete). */
  mx: MxStatus | null;
  createdAt: Date;
}

/**
 * Transforms a raw database domain row into the public API response shape.
 * Strips every private key (active and pending, #250) and the public keys:
 * exposes the DKIM DNS
 * record value instead so users know what TXT record to add. `dns` is the
 * domain's live DNS status, or null when the response does not look it up.
 */
export function serializeDomain(
  domain: Domain,
  dns: DomainDnsStatus | null,
): SerializedDomain {
  return {
    id: domain.id,
    name: domain.name,
    dkimSelector: domain.dkimSelector,
    dkimDnsRecord: getDkimDnsRecord(domain),
    dkimPending: serializeDkimPending(domain),
    dkimPrevious: serializeDkimPrevious(domain),
    spfVerified: domain.spfVerified,
    dkimVerified: domain.dkimVerified,
    dmarcVerified: domain.dmarcVerified,
    verifiedAt: domain.verifiedAt,
    lastCheckedAt: domain.lastCheckedAt,
    lastCheckResult: domain.lastCheckResult,
    unsubscribeEmail: domain.unsubscribeEmail,
    unsubscribeUrl: domain.unsubscribeUrl,
    notifyEmail: domain.notifyEmail,
    dnsRecords: getRequiredDnsRecords(domain),
    dmarc: dns?.dmarc ?? null,
    mx: dns?.mx ?? null,
    createdAt: domain.createdAt,
  };
}

function serializeDkimPending(domain: Domain): SerializedDkimPending | null {
  const selector = domain.dkimPendingSelector;
  const publicKey = domain.dkimPendingPublicKey;
  if (selector === null || publicKey === null) return null;
  return {
    selector,
    host: dkimRecordHost(selector, domain.name),
    dnsRecord: dkimRecordValue(publicKey),
    createdAt: domain.dkimPendingCreatedAt,
  };
}

function serializeDkimPrevious(domain: Domain): SerializedDkimPrevious | null {
  const selector = domain.dkimPreviousSelector;
  if (selector === null) return null;
  return {
    selector,
    host: dkimRecordHost(selector, domain.name),
    dnsRecord:
      domain.dkimPreviousPublicKey === null
        ? null
        : dkimRecordValue(domain.dkimPreviousPublicKey),
    rotatedAt: domain.dkimRotatedAt,
    advice: PREVIOUS_DKIM_SELECTOR_ADVICE,
  };
}
