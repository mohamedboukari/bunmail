import type { Domain } from "../types/domain.types.ts";

/**
 * Shape of a domain in API responses.
 * Hides the DKIM private key — it must never be exposed in API responses.
 */
export interface SerializedDomain {
  id: string;
  name: string;
  dkimSelector: string;
  spfVerified: boolean;
  dkimVerified: boolean;
  dmarcVerified: boolean;
  verifiedAt: Date | null;
  createdAt: Date;
}

/**
 * Transforms a raw database domain row into the public API response shape.
 * Strips `dkimPrivateKey` and `dkimPublicKey` — keys are internal secrets.
 */
export function serializeDomain(domain: Domain): SerializedDomain {
  return {
    id: domain.id,
    name: domain.name,
    dkimSelector: domain.dkimSelector,
    spfVerified: domain.spfVerified,
    dkimVerified: domain.dkimVerified,
    dmarcVerified: domain.dmarcVerified,
    verifiedAt: domain.verifiedAt,
    createdAt: domain.createdAt,
  };
}
