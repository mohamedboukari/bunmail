import type { MxStatus } from "../../bounces/services/return-path-mx.ts";
import { getDkimDnsRecord } from "../services/domain.service.ts";
import type { DomainDnsStatus } from "../services/domain-dns-status.service.ts";
import { getRequiredDnsRecords } from "../services/required-dns-records.ts";
import type { DmarcCheck, Domain, RequiredDnsRecord } from "../types/domain.types.ts";

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
  spfVerified: boolean;
  dkimVerified: boolean;
  dmarcVerified: boolean;
  verifiedAt: Date | null;
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
 * Strips `dkimPrivateKey` and `dkimPublicKey`: exposes the DKIM DNS
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
    spfVerified: domain.spfVerified,
    dkimVerified: domain.dkimVerified,
    dmarcVerified: domain.dmarcVerified,
    verifiedAt: domain.verifiedAt,
    unsubscribeEmail: domain.unsubscribeEmail,
    unsubscribeUrl: domain.unsubscribeUrl,
    notifyEmail: domain.notifyEmail,
    dnsRecords: getRequiredDnsRecords(domain),
    dmarc: dns?.dmarc ?? null,
    mx: dns?.mx ?? null,
    createdAt: domain.createdAt,
  };
}
