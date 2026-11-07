import { config } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";
import { recordTlsRptSession } from "../../metrics/services/metrics.service.ts";
import type {
  TlsRptDomain,
  TlsRptObservation,
  TlsRptPolicy,
} from "../types/tls-rpt.types.ts";
import {
  classifySession,
  daneUnknownPolicyOf,
  dnssecInvalidObservation,
  noMatchingMxObservation,
  type SessionOutcome,
} from "./tls-rpt-classify.ts";
import { publishesTlsRpt } from "./tls-rpt-record.ts";
import { recordObservation } from "./tls-rpt-store.service.ts";

/**
 * Where the mailer hands TLS-RPT its sessions (#345). Called from the
 * delivery path, so it never throws and never makes the send wait: each
 * recording runs in the background (in the send's log context), after
 * checking, once an hour per domain, that the domain publishes a usable
 * `_smtp._tls` record. With `TLSRPT_ENABLED=false` nothing happens at all:
 * no lookup, no write.
 *
 * At most {@link MAX_CONCURRENT_RECORDINGS} recordings run at once: when
 * the database is slow, a send storm must not pile up background work.
 * Past that, a recording is dropped (counted as
 * `bunmail_tlsrpt_sessions_total{result="dropped"}`, logged at `debug`
 * at most once a minute).
 */

/** Most recordings running at once; past it, new ones are dropped. */
export const MAX_CONCURRENT_RECORDINGS = 4;

/** Least time between two "recording dropped" debug lines. */
const DROP_LOG_INTERVAL_MS = 60_000;

/** The steps a recording takes, replaceable in tests. */
export interface TlsRptObserveDeps {
  enabled: () => boolean;
  publishes: (domain: string) => Promise<boolean>;
  record: (args: {
    domain: string;
    policy: TlsRptPolicy;
    observation: TlsRptObservation;
    at: Date;
  }) => Promise<"recorded" | "dropped">;
  now: () => Date;
}

const realDeps: TlsRptObserveDeps = {
  enabled: () => config.tlsRpt.enabled,
  publishes: publishesTlsRpt,
  record: recordObservation,
  now: () => new Date(),
};

let deps: TlsRptObserveDeps = realDeps;

/** Recordings still running: their number is the semaphore, and tests wait for them. */
const pending = new Set<Promise<void>>();

/** Recordings dropped since the last debug line, and when it was written. */
let droppedSinceLog = 0;
let lastDropLogAt = Number.NEGATIVE_INFINITY;

/**
 * @public Replaces the steps (tests), or restores the real ones with `null`.
 */
export function setTlsRptObserveDeps(override: Partial<TlsRptObserveDeps> | null): void {
  deps = override === null ? realDeps : { ...realDeps, ...override };
  droppedSinceLog = 0;
  lastDropLogAt = Number.NEGATIVE_INFINITY;
}

/** @public Waits for every recording started so far (tests). */
export async function settleTlsRptRecordings(): Promise<void> {
  await Promise.all(pending);
}

/** Counts a recording dropped because {@link MAX_CONCURRENT_RECORDINGS} are running. */
function dropRecording(domain: string): void {
  recordTlsRptSession("dropped");
  droppedSinceLog++;
  const now = Date.now();
  if (now - lastDropLogAt < DROP_LOG_INTERVAL_MS) return;
  logger.debug("TLS-RPT session not recorded: too many recordings running", {
    domain,
    dropped: droppedSinceLog,
    maxConcurrent: MAX_CONCURRENT_RECORDINGS,
  });
  lastDropLogAt = now;
  droppedSinceLog = 0;
}

/** Records one observation of `target` in the background, or drops it when the semaphore is full. */
function recordInBackground(target: TlsRptDomain, observation: TlsRptObservation): void {
  if (pending.size >= MAX_CONCURRENT_RECORDINGS) {
    dropRecording(target.domain);
    return;
  }
  const run = (async (): Promise<void> => {
    try {
      if (!(await deps.publishes(target.domain))) return;
      const stored = await deps.record({
        domain: target.domain,
        policy: target.policy,
        observation,
        at: deps.now(),
      });
      if (stored === "dropped") {
        logger.debug("TLS-RPT session not counted: report at its policy cap", {
          domain: target.domain,
        });
        return;
      }
      recordTlsRptSession(observation.result === "success" ? "success" : "failure");
      logger.debug("TLS-RPT session recorded", {
        domain: target.domain,
        policyType: target.policy.type,
        result: observation.result,
      });
    } catch (error) {
      /** By name only: a drizzle error's message embeds its query parameters. */
      logger.warn("TLS-RPT session could not be recorded", {
        domain: target.domain,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  })();
  pending.add(run);
  void run.finally(() => pending.delete(run));
}

/** One domain of an MX session and the outcomes of its own transactions. */
export interface DomainSession {
  target: TlsRptDomain;
  outcomes: readonly SessionOutcome[];
}

/**
 * Records one MX session (#345) for each of its domains, from that
 * domain's own transactions only ({@link classifySession}): in a session
 * shared by several domains, a domain whose transaction never reached a
 * TLS decision is not counted. Sessions that are not reported (no
 * attempt, a failure that is not TLS) are skipped.
 */
export function observeMxSession(
  domains: readonly DomainSession[],
  at: { mxHost: string; address: string },
): void {
  if (domains.length === 0 || !deps.enabled()) return;
  for (const { target, outcomes } of domains) {
    const observation = classifySession(target.policy, { ...at, outcomes });
    if (observation !== null) recordInBackground(target, observation);
  }
}

/**
 * Records an attempt that connected to nothing because no MX host matches
 * the domain's enforce-mode MTA-STS policy (#345): a `validation-failure`.
 */
export function observeUnconnectedAttempt(target: TlsRptDomain): void {
  if (!deps.enabled()) return;
  recordInBackground(target, noMatchingMxObservation());
}

/**
 * Records an MX host skipped because a DNSSEC lookup of DANE failed (#345,
 * RFC 7672 section 2.1.2): a `dnssec-invalid` failure under the host's
 * `tlsa` policy, nothing connected to.
 */
export function observeDaneLookupFailure(domain: string, mxHost: string): void {
  if (!deps.enabled()) return;
  recordInBackground(
    { domain, policy: daneUnknownPolicyOf(mxHost) },
    dnssecInvalidObservation(mxHost),
  );
}
