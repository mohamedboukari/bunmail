/**
 * Types of the BIMI readiness check (#415). BunMail sends nothing
 * differently for BIMI: the check only tells the operator whether a
 * domain's record, DMARC policy and logo meet what mailbox providers ask
 * for before they show the logo.
 */

/** The parts of a BIMI check, in display order. */
export type BimiArea = "record" | "dmarc" | "logo" | "certificate";

/**
 * How one finding counts: `pass` (a requirement met), `fail` (a
 * requirement not met), `warn` (allowed, but a provider may not show the
 * logo), `info` (context, no verdict).
 */
export type BimiSeverity = "pass" | "fail" | "warn" | "info";

/** One line of a BIMI check. Text only: never markup from the logo. */
export interface BimiFinding {
  area: BimiArea;
  severity: BimiSeverity;
  text: string;
}

/**
 * What the `default._bimi` lookup found:
 *
 * - `valid`: one `v=BIMI1` record with an https `l=` (or only an `a=`).
 * - `declined`: one record whose `l=` and `a=` are empty: the domain
 *   declines to show a logo.
 * - `missing`: no record at the domain nor at its organizational domain.
 * - `multiple`: more than one `v=BIMI1` record (receivers then use none).
 * - `invalid`: one record that breaks the syntax.
 * - `error`: the lookup failed (SERVFAIL, timeout).
 */
export type BimiRecordStatus =
  "valid" | "declined" | "missing" | "multiple" | "invalid" | "error";

/** The tags of one BIMI record, parsed strictly. */
export interface ParsedBimiRecord {
  /** `l=`: the logo URL; `""` when the tag is present but empty, null when absent. */
  logoUrl: string | null;
  /** `a=`: the certificate (VMC or CMC) URL; `""` when empty, null when absent. */
  authorityUrl: string | null;
  /** Syntax problems: any one makes the record `invalid`. */
  problems: string[];
}

/** The BIMI record lookup of a domain. */
export interface BimiRecordCheck {
  status: BimiRecordStatus;
  /** The name whose record applies (`default._bimi.<domain>`), or the one queried. */
  host: string;
  /** True when the record is the organizational domain's. */
  inherited: boolean;
  /** The https `l=` URL, when the record is valid and has one. */
  logoUrl: string | null;
  /** The https `a=` URL, when the record is valid and has one. */
  authorityUrl: string | null;
}

/**
 * The overall verdict:
 *
 * - `ready`: a valid record, a DMARC policy that enforces, and a logo that
 *   passes every SVG Tiny PS rule checked.
 * - `not-ready`: a record exists but something above fails.
 * - `declined`: the record declines a logo.
 * - `missing`: no record.
 * - `error`: a lookup or the logo fetch failed for a temporary reason, so
 *   nothing definitive is known.
 */
export type BimiStatus = "ready" | "not-ready" | "declined" | "missing" | "error";

/** One BIMI check of a domain, as the domain page shows it. */
export interface BimiCheck {
  status: BimiStatus;
  /** One line for the operator. */
  summary: string;
  record: BimiRecordCheck;
  /** Every finding, grouped by area in display order. */
  findings: BimiFinding[];
  /** When the check ran, ISO 8601. */
  checkedAt: string;
}
