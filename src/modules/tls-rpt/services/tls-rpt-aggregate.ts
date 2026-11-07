import { createHash } from "crypto";
import type {
  TlsRptObservation,
  TlsRptPolicy,
  TlsRptPolicyType,
  TlsRptResultType,
} from "../types/tls-rpt.types.ts";

/**
 * How a session becomes a counter of a TLS report (#345), and the caps
 * that bound a report however hostile the receiving side is. Pure.
 *
 * A report (one domain, one UTC day) holds at most
 * {@link MAX_POLICIES_PER_REPORT} policies (a domain that changes its
 * MTA-STS policy all day long cannot grow it), and at most
 * {@link MAX_DETAIL_ROWS_PER_REPORT} detailed failure counters (MX host,
 * address, reason). Past that cap, a failure is counted on its policy's
 * row for that result type without details, so the totals stay exact:
 * at most `policies x (1 + failure types)` such rows besides the detailed
 * ones. A session of a policy beyond the policy cap is dropped.
 */

/** Most distinct policies counted in one report. */
export const MAX_POLICIES_PER_REPORT = 4;

/** Most detailed failure counters in one report. */
export const MAX_DETAIL_ROWS_PER_REPORT = 100;

/** Longest policy string or MX list stored, in characters; longer ones are cut at a line. */
export const MAX_POLICY_TEXT_LENGTH = 4_000;

/** The key of one counter. */
export interface ResultKey {
  policyType: TlsRptPolicyType;
  policyHash: string;
  resultType: TlsRptResultType;
  receivingMxHostname: string;
  receivingIp: string;
  failureReasonCode: string;
}

/** Joins lines with `\n`, keeping whole lines up to {@link MAX_POLICY_TEXT_LENGTH} characters. */
export function joinBounded(lines: readonly string[]): string {
  let text = "";
  for (const line of lines) {
    const next = text === "" ? line : `${text}\n${line}`;
    if (next.length > MAX_POLICY_TEXT_LENGTH) break;
    text = next;
  }
  return text;
}

/** Identifies a policy within a report: a SHA-256 of its type, string and MX patterns. */
export function policyHash(policy: TlsRptPolicy): string {
  return createHash("sha256")
    .update(JSON.stringify([policy.type, policy.policyString, policy.mxHost]))
    .digest("hex")
    .slice(0, 32);
}

/** The counter a session's observation goes to, before the caps. */
export function resultKeyOf(
  policy: TlsRptPolicy,
  observation: TlsRptObservation,
): ResultKey {
  const base = { policyType: policy.type, policyHash: policyHash(policy) };
  if (observation.result === "success") {
    return {
      ...base,
      resultType: "success",
      receivingMxHostname: "",
      receivingIp: "",
      failureReasonCode: "",
    };
  }
  return {
    ...base,
    resultType: observation.result,
    receivingMxHostname: observation.receivingMxHostname,
    receivingIp: observation.receivingIp,
    failureReasonCode: observation.failureReasonCode,
  };
}

function sameKey(a: ResultKey, b: ResultKey): boolean {
  return (
    a.policyType === b.policyType &&
    a.policyHash === b.policyHash &&
    a.resultType === b.resultType &&
    a.receivingMxHostname === b.receivingMxHostname &&
    a.receivingIp === b.receivingIp &&
    a.failureReasonCode === b.failureReasonCode
  );
}

/** A failure counter without details: where failures past the detail cap go. */
function isUndetailedFailure(key: ResultKey): boolean {
  return (
    key.resultType !== "success" &&
    key.receivingMxHostname === "" &&
    key.receivingIp === "" &&
    key.failureReasonCode === ""
  );
}

/**
 * The counter to increment for `candidate` given the report's `existing`
 * counters, or `null` to drop the session (its policy is past
 * {@link MAX_POLICIES_PER_REPORT}). An existing counter is always used; a
 * new detailed failure past {@link MAX_DETAIL_ROWS_PER_REPORT} goes to its
 * policy's undetailed counter for that result type.
 */
export function resultKeyFor(
  existing: readonly ResultKey[],
  candidate: ResultKey,
): ResultKey | null {
  if (existing.some((key) => sameKey(key, candidate))) return candidate;
  const policies = new Set(existing.map((key) => `${key.policyType} ${key.policyHash}`));
  if (
    !policies.has(`${candidate.policyType} ${candidate.policyHash}`) &&
    policies.size >= MAX_POLICIES_PER_REPORT
  ) {
    return null;
  }
  if (candidate.resultType === "success" || isUndetailedFailure(candidate)) {
    return candidate;
  }
  const detailed = existing.filter(
    (key) => key.resultType !== "success" && !isUndetailedFailure(key),
  ).length;
  if (detailed < MAX_DETAIL_ROWS_PER_REPORT) return candidate;
  return {
    ...candidate,
    receivingMxHostname: "",
    receivingIp: "",
    failureReasonCode: "",
  };
}

/** The UTC day of `at`, as `YYYY-MM-DD`. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Earliest delay after a day ends before its report is sent. */
export const REPORT_DELAY_MIN_MS = 60 * 60_000;

/** Spread added to {@link REPORT_DELAY_MIN_MS}, so reports do not all go out at once. */
export const REPORT_DELAY_JITTER_MS = 4 * 60 * 60_000;

/**
 * When the report of `day` is first due: the day's end (midnight UTC) plus
 * one hour plus up to four more (`random` in `[0, 1)`), so reports from
 * many BunMail instances, and from one instance to many domains, spread
 * out instead of all landing on the receivers at 00:00.
 */
export function reportDueAt(day: string, random: number): Date {
  const end = Date.parse(`${day}T00:00:00Z`) + 24 * 60 * 60_000;
  return new Date(
    end + REPORT_DELAY_MIN_MS + Math.floor(random * REPORT_DELAY_JITTER_MS),
  );
}
