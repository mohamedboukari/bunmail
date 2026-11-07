import { isIP } from "net";
import type { TlsRptResultRow } from "../types/tls-rpt.types.ts";

/**
 * The TLS report itself (RFC 8460 section 4, #345): the JSON document, its
 * file name and mail subject, and its gzip encoding. Pure.
 */

/** Largest gzipped report sent, in bytes; RFC 8460 section 5.2 notes receivers limit around 10 MB. */
export const MAX_REPORT_BYTES = 1_000_000;

/** One `failure-details` entry (RFC 8460 section 4.4). */
interface FailureDetailJson {
  "result-type": string;
  "sending-mta-ip"?: string;
  "receiving-mx-hostname"?: string;
  "receiving-ip"?: string;
  "failed-session-count": number;
  "failure-reason-code"?: string;
}

/** One `policies` entry. */
interface PolicyJson {
  policy: {
    "policy-type": string;
    "policy-string"?: string[];
    "policy-domain": string;
    "mx-host"?: string[];
  };
  summary: {
    "total-successful-session-count": number;
    "total-failure-session-count": number;
  };
  "failure-details"?: FailureDetailJson[];
}

/** The report document (RFC 8460 section 4.4). */
export interface TlsRptReportJson {
  "organization-name": string;
  "date-range": { "start-datetime": string; "end-datetime": string };
  "contact-info": string;
  "report-id": string;
  policies: PolicyJson[];
}

/** What a report is built from. */
export interface ReportInput {
  organizationName: string;
  contactEmail: string;
  rfcReportId: string;
  /** The UTC day, `YYYY-MM-DD`. */
  day: string;
  policyDomain: string;
  results: readonly TlsRptResultRow[];
  /** `MAIL_PUBLIC_IP`: the `sending-mta-ip` of the address family of each receiving IP. */
  sendingIps: readonly string[];
}

/** `\n`-joined stored text back to its lines; empty text is no lines. */
function lines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

/** The sending IP of the receiving IP's family, else the first one, else none. */
function sendingIpFor(
  receivingIp: string,
  sendingIps: readonly string[],
): string | undefined {
  const family = isIP(receivingIp);
  return sendingIps.find((ip) => isIP(ip) === family) ?? sendingIps[0];
}

/** One `failure-details` entry of a stored failure counter. */
function failureDetail(
  row: TlsRptResultRow,
  sendingIps: readonly string[],
): FailureDetailJson {
  const sendingIp =
    row.receivingIp === "" ? undefined : sendingIpFor(row.receivingIp, sendingIps);
  /** In the order of RFC 8460's example; fields BunMail does not know are left out. */
  const detail: FailureDetailJson = {
    "result-type": row.resultType,
    ...(sendingIp === undefined ? {} : { "sending-mta-ip": sendingIp }),
    ...(row.receivingMxHostname === ""
      ? {}
      : { "receiving-mx-hostname": row.receivingMxHostname }),
    ...(row.receivingIp === "" ? {} : { "receiving-ip": row.receivingIp }),
    "failed-session-count": row.sessionCount,
    ...(row.failureReasonCode === ""
      ? {}
      : { "failure-reason-code": row.failureReasonCode }),
  };
  return detail;
}

/**
 * Builds the report: one `policies` entry per stored policy (in the order
 * first seen), its summary from every counter of the policy, and its
 * failure details, largest count first. Optional fields that BunMail does
 * not know are left out rather than sent empty.
 */
export function buildReport(input: ReportInput): TlsRptReportJson {
  const byPolicy = new Map<string, TlsRptResultRow[]>();
  for (const row of input.results) {
    const key = `${row.policyType} ${row.policyHash}`;
    const rows = byPolicy.get(key) ?? [];
    rows.push(row);
    byPolicy.set(key, rows);
  }
  const policies: PolicyJson[] = [];
  for (const rows of byPolicy.values()) {
    const first = rows[0];
    if (!first) continue;
    const policyString = lines(first.policyString);
    const mxHost = lines(first.mxHost);
    const failures = rows
      .filter((row) => row.resultType !== "success")
      .toSorted((a, b) => b.sessionCount - a.sessionCount);
    const successful = rows
      .filter((row) => row.resultType === "success")
      .reduce((sum, row) => sum + row.sessionCount, 0);
    const failed = failures.reduce((sum, row) => sum + row.sessionCount, 0);
    const entry: PolicyJson = {
      policy: {
        "policy-type": first.policyType,
        ...(policyString.length > 0 ? { "policy-string": policyString } : {}),
        "policy-domain": input.policyDomain,
        ...(mxHost.length > 0 ? { "mx-host": mxHost } : {}),
      },
      summary: {
        "total-successful-session-count": successful,
        "total-failure-session-count": failed,
      },
    };
    if (failures.length > 0) {
      entry["failure-details"] = failures.map((row) =>
        failureDetail(row, input.sendingIps),
      );
    }
    policies.push(entry);
  }
  return {
    "organization-name": input.organizationName,
    "date-range": {
      "start-datetime": `${input.day}T00:00:00Z`,
      "end-datetime": `${input.day}T23:59:59Z`,
    },
    "contact-info": input.contactEmail,
    "report-id": input.rfcReportId,
    policies,
  };
}

/** Totals of a report, for log lines and metrics. */
export function reportTotals(report: TlsRptReportJson): {
  policies: number;
  successful: number;
  failed: number;
} {
  let successful = 0;
  let failed = 0;
  for (const entry of report.policies) {
    successful += entry.summary["total-successful-session-count"];
    failed += entry.summary["total-failure-session-count"];
  }
  return { policies: report.policies.length, successful, failed };
}

/**
 * The report's file name (RFC 8460 section 5.1):
 * `<submitter>!<policy-domain>!<begin>!<end>.json.gz`, the timestamps in
 * seconds since the epoch (the day's first and last second, UTC).
 */
export function reportFilename(
  submitter: string,
  policyDomain: string,
  day: string,
): string {
  const begin = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
  const end = begin + 24 * 60 * 60 - 1;
  return `${submitter}!${policyDomain}!${begin}!${end}.json.gz`;
}

/** The mail subject (RFC 8460 section 5.3). */
export function reportSubject(
  policyDomain: string,
  submitter: string,
  rfcReportId: string,
): string {
  return `Report Domain: ${policyDomain} Submitter: ${submitter} Report-ID: <${rfcReportId}>`;
}

/** The report as `application/tlsrpt+gzip` bytes (RFC 8460 section 5.2). */
export function encodeReport(report: TlsRptReportJson): Uint8Array<ArrayBuffer> {
  return Bun.gzipSync(new TextEncoder().encode(JSON.stringify(report)));
}
