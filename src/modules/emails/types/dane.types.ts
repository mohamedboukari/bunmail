import type { TlsaRecord } from "../../../utils/dns-rdata.ts";

/**
 * DANE types of the emails module (RFC 7672, #345): what a recipient domain
 * and each of its MX hosts were found to be under DANE.
 */

/**
 * A recipient domain whose MX lookup was DNSSEC-validated (RFC 7672
 * section 2.2.1), or that has no MX records by a validated denial (an
 * implicit MX, section 2.2.2): DANE applies to its MX hosts one by one.
 */
export interface SecureMx {
  /** The recipient domain: the original next-hop domain. */
  nextHop: string;
  /** The next-hop domain after the MX lookup's CNAME expansion; `nextHop` without one. */
  expandedNextHop: string;
  /** No MX records: the domain itself is its SMTP server name. */
  implicit: boolean;
}

/**
 * DANE for one MX host, decided before connecting to it: it published a
 * DNSSEC-validated TLSA RRset (RFC 7672 sections 2.2.2 and 2.2.3).
 */
export interface DaneHost {
  /** The MX host name connected to (as the MX record lists it). */
  mxHost: string;
  /** The TLSA base domain: the SNI (section 8.1) and the primary reference identifier. */
  baseDomain: string;
  /** Names a DANE-TA(2) server certificate may carry (section 3.2.2), lowercased, base domain first. */
  referenceIds: string[];
  /** Every TLSA record of the RRset, for the TLS report's `policy-string`. */
  records: TlsaRecord[];
  /**
   * The usable records after digest algorithm agility (RFC 7671 section 9).
   * Empty: the host committed to TLS, but no record can authenticate it,
   * so TLS is required without authentication (RFC 7672 section 2.2).
   */
  usable: TlsaRecord[];
}
