import { ownerEmailProblem } from "./auth.ts";
import { optionalBoundedInt, optionalEnv, optionalStrictBoolean } from "./env.ts";
import { readSystemMailFrom } from "./mail.ts";

/** Longest `TLSRPT_ORGANIZATION_NAME` accepted, in characters. */
export const MAX_TLSRPT_ORGANIZATION_NAME_LENGTH = 100;

/**
 * Reads `TLSRPT_ENABLED` (#345): whether BunMail sends SMTP TLS reports
 * (RFC 8460) to recipient domains that publish a `_smtp._tls` record.
 * Default `false`: off means no lookups, no recording and no report job.
 * Only `true` or `false`; anything else refuses to boot.
 */
export function readTlsRptEnabled(
  raw: string | undefined = process.env["TLSRPT_ENABLED"],
): boolean {
  return optionalStrictBoolean("TLSRPT_ENABLED", false, raw);
}

/**
 * Reads `TLSRPT_CONTACT_EMAIL` (#345): the report's `contact-info`, and its
 * domain the `TLS-Report-Submitter`. Unset: `SYSTEM_MAIL_FROM`. When TLS-RPT
 * is on and neither is set, or the value is not one bare address, BunMail
 * refuses to boot. Trimmed and lower-cased. `null` when TLS-RPT is off and
 * nothing is set. Exported for tests.
 */
export function readTlsRptContactEmail(
  enabled: boolean,
  raw: string = optionalEnv("TLSRPT_CONTACT_EMAIL", ""),
  systemMailFrom: string | null = readSystemMailFrom(),
): string | null {
  const email = raw.trim().toLowerCase();
  if (email !== "") {
    const problem = ownerEmailProblem(email);
    if (problem) {
      throw new Error(
        `[config] TLSRPT_CONTACT_EMAIL is not usable: ${problem}.\n` +
          "  → Set it to one bare address that receives questions about the reports,\n" +
          "    e.g. tls-reports@yourcompany.com.",
      );
    }
    return email;
  }
  if (systemMailFrom !== null) return systemMailFrom;
  if (!enabled) return null;
  throw new Error(
    "[config] TLSRPT_ENABLED=true needs a contact address for the reports.\n" +
      "  → Set TLSRPT_CONTACT_EMAIL (or SYSTEM_MAIL_FROM), e.g. tls-reports@yourcompany.com.",
  );
}

/**
 * Reads `TLSRPT_ORGANIZATION_NAME` (#345): the report's `organization-name`.
 * Unset or blank: `fallback` (the contact address's domain). 1 to
 * {@link MAX_TLSRPT_ORGANIZATION_NAME_LENGTH} printable characters, no
 * control characters; anything else refuses to boot. Exported for tests.
 */
export function readTlsRptOrganizationName(
  fallback: string,
  raw: string = optionalEnv("TLSRPT_ORGANIZATION_NAME", ""),
): string {
  const name = raw.trim();
  if (name === "") return fallback;
  if (name.length > MAX_TLSRPT_ORGANIZATION_NAME_LENGTH || /\p{Cc}/u.test(name)) {
    throw new Error(
      `[config] TLSRPT_ORGANIZATION_NAME must be 1 to ${MAX_TLSRPT_ORGANIZATION_NAME_LENGTH} printable characters, got "${raw}"`,
    );
  }
  return name;
}

/** Default and bounds of `TLSRPT_MAX_REPORTS_PER_DAY` (#345). */
export const DEFAULT_TLSRPT_MAX_REPORTS_PER_DAY = 500;
export const MIN_TLSRPT_MAX_REPORTS_PER_DAY = 1;
export const MAX_TLSRPT_MAX_REPORTS_PER_DAY = 100_000;

/**
 * Reads `TLSRPT_MAX_REPORTS_PER_DAY` (#345): the most report deliveries
 * (mail and HTTPS together, every replica together) BunMail makes in one
 * UTC day. The reporting addresses come from recipient domains' DNS, so
 * without a cap a sender who controls many of them could make BunMail
 * mail or POST any number of reports a day. Unset or blank: 500. Anything
 * other than a whole number from 1 to 100000 refuses to boot.
 */
export function readTlsRptMaxReportsPerDay(
  raw: string | undefined = process.env["TLSRPT_MAX_REPORTS_PER_DAY"],
): number {
  return optionalBoundedInt(
    "TLSRPT_MAX_REPORTS_PER_DAY",
    DEFAULT_TLSRPT_MAX_REPORTS_PER_DAY,
    MIN_TLSRPT_MAX_REPORTS_PER_DAY,
    MAX_TLSRPT_MAX_REPORTS_PER_DAY,
    raw,
  );
}

/** Default and bounds of `TLSRPT_MAX_REPORTS_PER_DESTINATION_PER_DAY` (#345). */
export const DEFAULT_TLSRPT_MAX_REPORTS_PER_DESTINATION = 50;
export const MIN_TLSRPT_MAX_REPORTS_PER_DESTINATION = 1;
export const MAX_TLSRPT_MAX_REPORTS_PER_DESTINATION = 1_000;

/**
 * Reads `TLSRPT_MAX_REPORTS_PER_DESTINATION_PER_DAY` (#345): the most
 * reports one destination (one mail address, or one HTTPS origin) gets in
 * one UTC day, every replica together. Any domain can name any mailbox or
 * URL as its reporting address, so without it many domains could aim
 * BunMail's reports at one third party. Unset or blank: 50, room for a
 * shared report collector that receives many domains' reports on one
 * origin, still a small bound for any single victim. Anything other than a
 * whole number from 1 to 1000 refuses to boot.
 */
export function readTlsRptMaxReportsPerDestination(
  raw: string | undefined = process.env["TLSRPT_MAX_REPORTS_PER_DESTINATION_PER_DAY"],
): number {
  return optionalBoundedInt(
    "TLSRPT_MAX_REPORTS_PER_DESTINATION_PER_DAY",
    DEFAULT_TLSRPT_MAX_REPORTS_PER_DESTINATION,
    MIN_TLSRPT_MAX_REPORTS_PER_DESTINATION,
    MAX_TLSRPT_MAX_REPORTS_PER_DESTINATION,
    raw,
  );
}

/** The `config.tlsRpt` section. */
export interface TlsRptConfig {
  /** `TLSRPT_ENABLED`: reports are recorded and sent. */
  enabled: boolean;
  /** The report's `organization-name`. Empty when off and nothing is set. */
  organizationName: string;
  /** The report's `contact-info`; `null` when off and nothing is set. */
  contactEmail: string | null;
  /** `TLS-Report-Submitter`: the contact address's domain; empty when there is none. */
  submitter: string;
  /** `TLSRPT_MAX_REPORTS_PER_DAY`: report deliveries per UTC day, all replicas together. */
  maxReportsPerDay: number;
  /** `TLSRPT_MAX_REPORTS_PER_DESTINATION_PER_DAY`: reports per destination per UTC day. */
  maxReportsPerDestination: number;
}

/** SMTP TLS reporting (RFC 8460, #345). */
export function buildTlsRptConfig(): TlsRptConfig {
  const enabled = readTlsRptEnabled();
  const contactEmail = readTlsRptContactEmail(enabled);
  const submitter = contactEmail?.split("@")[1] ?? "";
  return {
    enabled,
    organizationName: readTlsRptOrganizationName(submitter),
    contactEmail,
    submitter,
    maxReportsPerDay: readTlsRptMaxReportsPerDay(),
    maxReportsPerDestination: readTlsRptMaxReportsPerDestination(),
  };
}
