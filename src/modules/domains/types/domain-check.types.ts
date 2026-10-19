/**
 * Outcome of one DNS check of a domain (#250):
 *
 * - `pass`: the record is published and correct.
 * - `fail`: a definitive failure, the record is missing or does not match.
 * - `unknown`: the lookup itself failed (SERVFAIL, timeout, network), so
 *   nothing is known about the record. It never counts as a failure.
 */
export type DnsCheckStatus = "pass" | "fail" | "unknown";

/** The DNS records verification checks, in display order. */
export type DnsCheckName = "spf" | "dkim" | "dmarc";

/** One check's outcome and a short reason for the operator (no TXT values). */
export interface DnsCheckOutcome {
  status: DnsCheckStatus;
  reason: string;
}

/**
 * The result of one verification of a domain (#250), stored as
 * `domains.last_check_result` and returned as `lastCheckResult`.
 */
export interface DomainCheckResult {
  spf: DnsCheckOutcome;
  dkim: DnsCheckOutcome;
  dmarc: DnsCheckOutcome;
  /** When the checks ran, ISO 8601. */
  checkedAt: string;
}
