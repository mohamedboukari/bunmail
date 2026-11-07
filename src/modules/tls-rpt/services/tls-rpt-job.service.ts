import { config } from "../../../config.ts";
import { generateId } from "../../../utils/id.ts";
import { runWithLogContext } from "../../../utils/log-context.ts";
import { logger } from "../../../utils/logger.ts";
import { recordTlsRptReport } from "../../metrics/services/metrics.service.ts";
import { isSuppressedForAnyKey } from "../../suppressions/services/suppression-check.service.ts";
import type { TlsRptJobDeps, TlsRptRunSummary } from "../types/tls-rpt-job.types.ts";
import { deliverReport, type ReportHandling } from "./tls-rpt-deliver.service.ts";
import { postReport } from "./tls-rpt-https.service.ts";
import { mailReport } from "./tls-rpt-mailto.service.ts";
import { lookupTlsRptRecord } from "./tls-rpt-record.ts";
import {
  claimDailyCapWarning,
  claimDueReports,
  dailySendCapReached,
  deferReport,
  deferUnsentReports,
  deleteExpiredReports,
  deleteReport,
  loadReportResults,
  releaseReport,
  releaseSend,
  rescheduleReport,
  reserveSend,
} from "./tls-rpt-store.service.ts";

/**
 * The daily TLS report job (RFC 8460, #345).
 *
 * Wakes every {@link WAKE_INTERVAL_MS} (jittered) and sends the reports
 * that are due: their UTC day is over and their own jittered due time
 * (one to five hours after midnight, `reportDueAt`) has passed. Each
 * report is delivered by `deliverReport` (`tls-rpt-deliver.service.ts`).
 *
 * **One report at a time per worker:** {@link SEND_CONCURRENCY} workers
 * each claim one report (`FOR UPDATE SKIP LOCKED`, a 3 h lease), deliver
 * it, then claim the next, so a lease never outlives the send it covers
 * (a report takes minutes at most: mail deliveries are capped at
 * {@link REPORT_MAIL_LIMITS}, HTTPS ones at 30 s).
 *
 * **Time budget:** a run stops claiming after {@link RUN_BUDGET_MS}; a
 * report still being delivered then is handed back (due now, its claim's
 * attempt given back, its delivered addresses kept) for the next run or
 * another replica. Hostile MX hosts or slow receivers cannot hold the job.
 *
 * **Daily caps** (every replica together, atomic counters in the
 * database): `TLSRPT_MAX_REPORTS_PER_DAY` deliveries in all and
 * `TLSRPT_MAX_REPORTS_PER_DESTINATION_PER_DAY` per destination (a mail
 * address or an HTTPS origin). Once the daily cap is reached, the job
 * stops for the rest of the UTC day and defers every past day's report
 * still to send to tomorrow (`deferUnsentReports`), where that day's cap
 * applies: nothing goes out in a burst, nothing is lost before the
 * retention. One replica logs `TLS report daily cap reached` once that day.
 *
 * Reports older than {@link RETENTION_DAYS} are deleted, sent or not.
 * Each run has its own log context (`job: "tlsrpt-report"`).
 */

/** How often the job wakes, before jitter. */
const WAKE_INTERVAL_MS = 15 * 60_000;

/** Delay of the first run after boot, before jitter. */
const FIRST_RUN_DELAY_MS = 2 * 60_000;

/** A run's wall-clock budget: past it, nothing more is claimed and a report in progress is handed back. */
export const RUN_BUDGET_MS = 10 * 60_000;

/** Reports delivered at once by one run. */
export const SEND_CONCURRENCY = 3;

/** Most reports one run claims; the next run goes on. */
const MAX_REPORTS_PER_RUN = 200;

/**
 * Limits of a report sent by mail: the whole attempt's session time and
 * the MX hosts tried. A hostile domain's tarpitting MX hosts cost the job
 * two minutes at most, never the 20 of an ordinary send.
 */
export const REPORT_MAIL_LIMITS = { deadlineMs: 2 * 60_000, maxMxHosts: 2 } as const;

/** Days a report is kept, sent or not; older ones are deleted. */
export const RETENTION_DAYS = 7;

const realDeps: TlsRptJobDeps = {
  now: () => new Date(),
  claimOne: async () => (await claimDueReports(1))[0] ?? null,
  loadResults: loadReportResults,
  lookup: (domain) => lookupTlsRptRecord(domain),
  mail: (report) => mailReport(report, undefined, REPORT_MAIL_LIMITS),
  post: (url, body) => postReport(url, body),
  reschedule: rescheduleReport,
  remove: deleteReport,
  deleteExpired: (days) => deleteExpiredReports(days),
  reserve: (destination) =>
    reserveSend(destination, {
      perDay: config.tlsRpt.maxReportsPerDay,
      perDestination: config.tlsRpt.maxReportsPerDestination,
    }),
  release: releaseSend,
  capReached: () => dailySendCapReached(config.tlsRpt.maxReportsPerDay),
  deferAll: () => deferUnsentReports(),
  defer: deferReport,
  releaseClaim: releaseReport,
  claimCapWarning: () => claimDailyCapWarning(),
  isSuppressed: isSuppressedForAnyKey,
};

/**
 * The daily cap is reached (#345): defers every past day's report still to
 * send to tomorrow, counts them, and logs the day's warning once (one
 * replica). `reportsLeft` is every report this run deferred: the ones cut
 * short by the cap (`deliverReport`) and the ones moved here.
 */
async function onDailyCap(deps: TlsRptJobDeps, summary: TlsRptRunSummary): Promise<void> {
  const deferred = await deps.deferAll();
  summary.capped += deferred;
  if (deferred > 0) recordTlsRptReport("any", "capped", deferred);
  if (await deps.claimCapWarning()) {
    logger.warn("TLS report daily cap reached", {
      cap: config.tlsRpt.maxReportsPerDay,
      reportsLeft: summary.capped,
    });
  }
}

/** A fresh, all-zero run summary. */
function emptySummary(): TlsRptRunSummary {
  return {
    reports: 0,
    sent: 0,
    skipped: 0,
    suppressed: 0,
    failed: 0,
    destinationCapped: 0,
    finished: 0,
    expired: 0,
    capped: 0,
    released: 0,
    errors: 0,
    durationMs: 0,
  };
}

/**
 * The run's workers: each claims one report, delivers it, and claims the
 * next, until none is due, the run's report count or time budget is used,
 * or a delivery hit the daily cap. Returns whether the daily cap stopped it.
 */
async function deliverDue(
  deps: TlsRptJobDeps,
  summary: TlsRptRunSummary,
  deadlineAt: number,
): Promise<boolean> {
  let claimed = 0;
  let halted = false;
  let capped = false;
  async function worker(): Promise<void> {
    while (
      !halted &&
      claimed < MAX_REPORTS_PER_RUN &&
      deps.now().getTime() < deadlineAt
    ) {
      claimed++;
      const row = await deps.claimOne();
      if (row === null) {
        halted = true;
        return;
      }
      summary.reports++;
      let handled: ReportHandling = "done";
      try {
        handled = await deliverReport(row, deps, summary, deadlineAt);
      } catch (error) {
        summary.errors++;
        /** By name only: a drizzle error's message embeds its query parameters. */
        logger.error("TLS report handling failed", {
          policyDomain: row.policyDomain,
          day: row.day,
          errorName: error instanceof Error ? error.name : typeof error,
        });
      }
      if (handled === "capped") capped = true;
      if (handled !== "done") halted = true;
    }
  }
  await Promise.all(Array.from({ length: SEND_CONCURRENCY }, () => worker()));
  return capped;
}

/**
 * One run: deletes expired reports, then delivers due reports (see the
 * module comment). Runs in its own log context and logs one outcome line
 * when it did anything. Does nothing while `TLSRPT_ENABLED=false`. Never
 * rejects.
 */
export function runTlsRptCycle(
  deps: TlsRptJobDeps = realDeps,
): Promise<TlsRptRunSummary> {
  return runWithLogContext(
    { job: "tlsrpt-report", jobId: generateId("trj") },
    async () => {
      const startedAt = Date.now();
      const summary = emptySummary();
      if (!config.tlsRpt.enabled) return summary;
      const deadlineAt = deps.now().getTime() + RUN_BUDGET_MS;

      try {
        summary.expired = await deps.deleteExpired(RETENTION_DAYS);
        /** The cap was reached earlier today: nothing is claimed until tomorrow. */
        const capped =
          (await deps.capReached()) || (await deliverDue(deps, summary, deadlineAt));
        if (capped) await onDailyCap(deps, summary);
      } catch (error) {
        summary.errors++;
        logger.error("TLS report claim failed", {
          errorName: error instanceof Error ? error.name : typeof error,
        });
      }

      summary.durationMs = Date.now() - startedAt;
      if (
        summary.reports > 0 ||
        summary.expired > 0 ||
        summary.capped > 0 ||
        summary.errors > 0
      ) {
        logger.info("TLS report run completed", { ...summary });
      } else {
        logger.debug("TLS report run: nothing due", { durationMs: summary.durationMs });
      }
      return summary;
    },
  );
}

/* ─── Scheduling ─── */

/** True between `start()` and `stop()`. */
let running = false;
/** True while a run is in progress; it schedules the next one when it ends. */
let inRun = false;
/** The next scheduled run, or null while a run is in progress or once stopped. */
let timer: ReturnType<typeof setTimeout> | null = null;

/** `ms` plus or minus 20%, so replicas do not wake in lockstep. */
function withJitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

/** Schedules the next run after `delayMs`, unless the job was stopped. */
function scheduleRun(delayMs: number): void {
  if (!running) return;
  timer = setTimeout(() => {
    timer = null;
    inRun = true;
    void runTlsRptCycle().finally(() => {
      inRun = false;
      scheduleRun(withJitter(WAKE_INTERVAL_MS));
    });
  }, delayMs);
}

/**
 * Starts the job: the first run about two minutes after boot, then one
 * about every 15 minutes, each scheduled when the previous one ends.
 * Idempotent. Does nothing while `TLSRPT_ENABLED=false`.
 */
export function start(): void {
  if (running) return;
  if (!config.tlsRpt.enabled) {
    logger.info(
      "TLS reporting (TLS-RPT) disabled: set TLSRPT_ENABLED=true to send reports",
    );
    return;
  }
  running = true;
  logger.info("Starting TLS report job", {
    wakeIntervalMs: WAKE_INTERVAL_MS,
    submitter: config.tlsRpt.submitter,
    mailtoSender: config.systemMailFrom === null ? "none" : "SYSTEM_MAIL_FROM",
  });
  if (!inRun) scheduleRun(withJitter(FIRST_RUN_DELAY_MS));
}

/** Stops the job. Called from the SIGINT/SIGTERM shutdown path. */
export function stop(): void {
  if (!running) return;
  running = false;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  logger.info("TLS report job stopped");
}

/** @public Whether the job is running (tests). */
export function isRunning(): boolean {
  return running;
}
