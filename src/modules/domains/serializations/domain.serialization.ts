import { getDkimDnsRecord } from "../services/domain.service.ts";
import type { Domain } from "../types/domain.types.ts";

/**
 * Shape of a domain in API responses.
 * Hides the DKIM private key — it must never be exposed in API responses.
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
  createdAt: Date;
}

/**
 * Transforms a raw database domain row into the public API response shape.
 * Strips `dkimPrivateKey` and `dkimPublicKey` — exposes the DKIM DNS
 * record value instead so users know what TXT record to add.
 */
export function serializeDomain(domain: Domain): SerializedDomain {
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
    createdAt: domain.createdAt,
  };
}
