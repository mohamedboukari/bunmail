import type { ReportSendOutcome } from "../services/tls-rpt-https.service.ts";
import type { MailedReport } from "../services/tls-rpt-mailto.service.ts";
import type { TlsRptLookup } from "../services/tls-rpt-record.ts";
import type {
  ReserveOutcome,
  TlsRptReportRow,
} from "../services/tls-rpt-store.service.ts";
import type { TlsRptResultRow } from "./tls-rpt.types.ts";

/** What a TLS report run did (#345), logged once as its outcome line. */
export interface TlsRptRunSummary {
  /** Reports claimed. */
  reports: number;
  /** Deliveries to one address that succeeded. */
  sent: number;
  /** Deliveries skipped (no usable mail sender). */
  skipped: number;
  /** Mail deliveries not made: the address is on the suppression list. */
  suppressed: number;
  /** Deliveries that failed, to be retried or dropped. */
  failed: number;
  /** Deliveries held back by the destination's daily cap (the report is deferred). */
  destinationCapped: number;
  /** Reports deleted: done, dropped, or no longer wanted. */
  finished: number;
  /** Reports past the retention period, deleted. */
  expired: number;
  /** Reports deferred to tomorrow because the daily cap was reached. */
  capped: number;
  /** Reports handed back because the run's time budget ran out. */
  released: number;
  /** Reports whose handling threw. */
  errors: number;
  durationMs: number;
}

/** The job's steps, replaceable in tests. */
export interface TlsRptJobDeps {
  now: () => Date;
  /** Claims one due report, or `null` when none is due. */
  claimOne: () => Promise<TlsRptReportRow | null>;
  loadResults: (reportId: string) => Promise<TlsRptResultRow[]>;
  lookup: (domain: string) => Promise<TlsRptLookup>;
  mail: (report: MailedReport) => Promise<ReportSendOutcome>;
  post: (url: string, body: Uint8Array) => Promise<ReportSendOutcome>;
  reschedule: (
    id: string,
    nextAttemptAt: Date,
    delivered: readonly string[],
  ) => Promise<void>;
  remove: (id: string) => Promise<void>;
  deleteExpired: (retentionDays: number) => Promise<number>;
  /** Takes a slot of the daily and the destination's caps for one delivery. */
  reserve: (destination: string) => Promise<ReserveOutcome>;
  /** Gives back both slots of a delivery that did not go out. */
  release: (destination: string) => Promise<void>;
  /** Whether today's deliveries already reached the daily cap. */
  capReached: () => Promise<boolean>;
  /** Defers every past day's report still to send to tomorrow; how many. */
  deferAll: () => Promise<number>;
  /** Defers one claimed report to tomorrow, keeping its delivered set. */
  defer: (id: string, delivered: readonly string[]) => Promise<void>;
  /** Hands one claimed report back at once, keeping its delivered set. */
  releaseClaim: (id: string, delivered: readonly string[]) => Promise<void>;
  /** `true` once per day, for the replica that logs the cap warning. */
  claimCapWarning: () => Promise<boolean>;
  /** Whether a mail address is on the suppression list (any API key). */
  isSuppressed: (address: string) => Promise<boolean>;
}
