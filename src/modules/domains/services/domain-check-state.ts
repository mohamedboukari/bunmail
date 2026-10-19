import type {
  DnsCheckName,
  DnsCheckStatus,
  DomainCheckResult,
} from "../types/domain-check.types.ts";

/**
 * The verification state machine of a domain (#250), pure: what one DNS
 * check changes, shared by Verify and the re-verification loop.
 *
 * DNS blips must never stop sending, so:
 *
 * - A check whose lookup errored is `unknown`: it changes nothing (no
 *   failure counted, `verifiedAt` and the per-check flags kept) and the
 *   domain is checked again in an hour.
 * - A definitive failure counts one failure and rechecks in an hour. A
 *   flag that was true stays true until {@link FLIP_AFTER_FAILURES}
 *   failures in a row: only then do the flags follow the result, and a
 *   verified domain flips to failing (`verifiedAt` cleared, the
 *   `domain.verification_failed` event).
 * - A pass of every check resets the count, keeps `verifiedAt` (or sets
 *   it, when the domain was not verified: the `domain.verified` event) and
 *   schedules the next check one interval later, plus or minus an hour.
 */

/** Definitive failures in a row that flip a verified domain to failing. */
export const FLIP_AFTER_FAILURES = 2;

/** When a failing or inconclusive domain is checked again. */
export const RECHECK_AFTER_PROBLEM_MS = 60 * 60 * 1000;

/** Spread of the next check after a pass: plus or minus this. */
export const RECHECK_JITTER_MS = 60 * 60 * 1000;

/** The checks, in display and event order. */
export const DNS_CHECK_NAMES: readonly DnsCheckName[] = ["spf", "dkim", "dmarc"];

/** The columns of a domain row the state machine reads and writes. */
export interface DomainCheckState {
  spfVerified: boolean;
  dkimVerified: boolean;
  dmarcVerified: boolean;
  verifiedAt: Date | null;
  consecutiveFailures: number;
}

/** What one check does to a domain. */
export interface DomainCheckTransition {
  /** `fail` if any check failed, else `unknown` if any errored, else `pass`. */
  outcome: DnsCheckStatus;
  /** The state to store. */
  next: DomainCheckState;
  /** When the loop checks the domain next. */
  nextCheckAt: Date;
  /**
   * `failed`: a verified domain flipped to failing. `verified`: a domain
   * that was not verified now passes every check. Null: neither.
   */
  event: "failed" | "verified" | null;
  /** The checks that failed definitively, in {@link DNS_CHECK_NAMES} order. */
  failedChecks: DnsCheckName[];
}

/** The overall outcome: one failure decides, then one error, else a pass. */
export function overallOutcome(result: DomainCheckResult): DnsCheckStatus {
  const statuses = new Set(DNS_CHECK_NAMES.map((name) => result[name].status));
  if (statuses.has("fail")) return "fail";
  if (statuses.has("unknown")) return "unknown";
  return "pass";
}

/**
 * The next check after a pass: `intervalMs` later, plus or minus
 * {@link RECHECK_JITTER_MS}, so domains verified together spread out.
 * `random` returns a number in [0, 1), like `Math.random`.
 */
export function nextCheckAfterPass(
  now: Date,
  intervalMs: number,
  random: () => number = Math.random,
): Date {
  const jitter = Math.round((random() * 2 - 1) * RECHECK_JITTER_MS);
  return new Date(now.getTime() + intervalMs + jitter);
}

/** The flag of one check: a pass sets it, a failure clears it only when `settle`. */
function nextFlag(previous: boolean, status: DnsCheckStatus, settle: boolean): boolean {
  if (status === "pass") return true;
  if (status === "fail" && settle) return false;
  return previous;
}

/**
 * What `result` does to a domain in `previous` state, checked at `now`.
 * `intervalMs` is the loop's interval between passing checks.
 */
export function nextDomainCheckState(
  previous: DomainCheckState,
  result: DomainCheckResult,
  now: Date,
  intervalMs: number,
  random: () => number = Math.random,
): DomainCheckTransition {
  const outcome = overallOutcome(result);
  const failedChecks = DNS_CHECK_NAMES.filter((name) => result[name].status === "fail");

  const consecutiveFailures =
    outcome === "pass"
      ? 0
      : outcome === "fail"
        ? previous.consecutiveFailures + 1
        : previous.consecutiveFailures;
  /** Enough failures in a row: the flags follow the result, failures included. */
  const settled = outcome === "fail" && consecutiveFailures >= FLIP_AFTER_FAILURES;

  let verifiedAt = previous.verifiedAt;
  let event: DomainCheckTransition["event"] = null;
  if (outcome === "pass" && previous.verifiedAt === null) {
    verifiedAt = now;
    event = "verified";
  } else if (settled && previous.verifiedAt !== null) {
    verifiedAt = null;
    event = "failed";
  }

  return {
    outcome,
    next: {
      spfVerified: nextFlag(previous.spfVerified, result.spf.status, settled),
      dkimVerified: nextFlag(previous.dkimVerified, result.dkim.status, settled),
      dmarcVerified: nextFlag(previous.dmarcVerified, result.dmarc.status, settled),
      verifiedAt,
      consecutiveFailures,
    },
    nextCheckAt:
      outcome === "pass"
        ? nextCheckAfterPass(now, intervalMs, random)
        : new Date(now.getTime() + RECHECK_AFTER_PROBLEM_MS),
    event,
    failedChecks,
  };
}
