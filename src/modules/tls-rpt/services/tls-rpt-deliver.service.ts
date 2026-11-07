import { createHash } from "crypto";
import { config } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";
import { redactEmail, redactUrl } from "../../../utils/redact.ts";
import { recordTlsRptReport } from "../../metrics/services/metrics.service.ts";
import type { TlsRptJobDeps, TlsRptRunSummary } from "../types/tls-rpt-job.types.ts";
import type { TlsRptRua } from "../types/tls-rpt.types.ts";
import {
  MAX_REPORT_BYTES,
  buildReport,
  encodeReport,
  reportFilename,
  reportTotals,
} from "./tls-rpt-report.ts";
import type { TlsRptReportRow } from "./tls-rpt-store.service.ts";

/**
 * One claimed TLS report, delivered to its reporting addresses (#345); the
 * run around it is `tls-rpt-job.service.ts`.
 *
 * 1. The domain's `_smtp._tls` record is looked up again (no cache): a
 *    domain that stopped publishing one gets no report, and the report is
 *    deleted. A failed lookup is retried like a failed send.
 * 2. One JSON report per domain and day, gzipped, refused past
 *    {@link MAX_REPORT_BYTES}.
 * 3. For each address that did not get it yet, in order:
 *    - the run's time budget: past it, the report is handed back at once
 *      (`releaseClaim`) for the next run or another replica;
 *    - a `mailto:` address on the suppression list (any API key) is
 *      skipped for good (`debug`, counted as `suppressed`);
 *    - a slot of the destination's and of the instance's daily caps
 *      (`reserve`, atomic, every replica together). The daily cap
 *      refused: the report is deferred to tomorrow and the run stops. The
 *      destination's cap refused: that address waits, and the report is
 *      deferred to tomorrow once the others are done;
 *    - the delivery: `mailto:` from `SYSTEM_MAIL_FROM` (skipped with a
 *      warning, its slots given back, when that sender is not usable),
 *      `https:` by a POST through the SSRF guard.
 * 4. Every address done: the report is deleted. A failed delivery: retried
 *    on {@link RETRY_BACKOFF_MINUTES} (within RFC 8460 section 5.5's day),
 *    dropped after {@link MAX_SEND_ATTEMPTS}.
 *
 * Each delivery logs one line with the domain, the scheme and the counts,
 * never a URL path or query, and a mail address only through `redactEmail`.
 */

/** Minutes to wait after failed attempt `n` (1-based) before the next. */
export const RETRY_BACKOFF_MINUTES: readonly number[] = [30, 60, 120, 240, 480];

/** Attempts per report before it is dropped: the first plus one per backoff step. */
export const MAX_SEND_ATTEMPTS = RETRY_BACKOFF_MINUTES.length + 1;

/** The short hash a delivered address is remembered by (no URL is stored), from its normalised form. */
export function ruaHash(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** A reporting address as it may be logged: a redacted mail address, or the URL's origin. */
function ruaForLog(rua: TlsRptRua): string {
  return rua.scheme === "mailto" ? redactEmail(rua.address) : redactUrl(rua.url);
}

/** The delivered-set of a report row. */
function deliveredOf(row: TlsRptReportRow): string[] {
  return row.deliveredRua === "" ? [] : row.deliveredRua.split("\n");
}

/** Reschedules after a failed attempt, or drops the report after the last one. */
async function retryOrDrop(
  row: TlsRptReportRow,
  delivered: readonly string[],
  deps: TlsRptJobDeps,
  reason: string,
): Promise<"retry" | "dropped"> {
  const backoff = RETRY_BACKOFF_MINUTES[row.attempts - 1];
  if (row.attempts >= MAX_SEND_ATTEMPTS || backoff === undefined) {
    await deps.remove(row.id);
    logger.warn("TLS report dropped after its last attempt", {
      policyDomain: row.policyDomain,
      day: row.day,
      attempts: row.attempts,
      reason,
    });
    return "dropped";
  }
  const next = new Date(deps.now().getTime() + backoff * 60_000);
  await deps.reschedule(row.id, next, delivered);
  return "retry";
}

/** How one report ended: handled, stopped by the daily cap, or handed back (time budget). */
export type ReportHandling = "done" | "capped" | "released";

/**
 * Handles one claimed report (see the module comment), adding to
 * `summary`. `deadlineAt` is the run's time budget (epoch ms). Throws only
 * when the database does; the caller counts it.
 */
export async function deliverReport(
  row: TlsRptReportRow,
  deps: TlsRptJobDeps,
  summary: TlsRptRunSummary,
  deadlineAt: number,
): Promise<ReportHandling> {
  const base = { policyDomain: row.policyDomain, day: row.day, attempt: row.attempts };
  const record = await deps.lookup(row.policyDomain);
  if (record.kind === "none") {
    await deps.remove(row.id);
    summary.finished++;
    logger.info(
      "TLS report not sent: the domain no longer publishes a TLS-RPT record",
      base,
    );
    return "done";
  }
  const delivered = deliveredOf(row);
  if (record.kind === "error") {
    const outcome = await retryOrDrop(row, delivered, deps, `TXT lookup ${record.code}`);
    if (outcome === "dropped") summary.finished++;
    logger.warn("TLS report not sent: TLS-RPT record lookup failed", {
      ...base,
      code: record.code,
      next: outcome,
    });
    return "done";
  }

  const results = await deps.loadResults(row.id);
  const tlsRpt = config.tlsRpt;
  if (results.length === 0 || tlsRpt.contactEmail === null) {
    await deps.remove(row.id);
    summary.finished++;
    return "done";
  }
  const report = buildReport({
    organizationName: tlsRpt.organizationName,
    contactEmail: tlsRpt.contactEmail,
    rfcReportId: row.rfcReportId,
    day: row.day,
    policyDomain: row.policyDomain,
    results,
    sendingIps: config.mail.publicIps,
  });
  const body = encodeReport(report);
  const totals = reportTotals(report);
  if (body.byteLength > MAX_REPORT_BYTES) {
    await deps.remove(row.id);
    summary.finished++;
    logger.warn("TLS report dropped: larger than the size cap", {
      ...base,
      bytes: body.byteLength,
      maxBytes: MAX_REPORT_BYTES,
    });
    return "done";
  }
  const filename = reportFilename(tlsRpt.submitter, row.policyDomain, row.day);

  const done = new Set(delivered);
  let failures = 0;
  let waiting = 0;
  let lastReason = "";
  for (const rua of record.rua) {
    const hash = ruaHash(rua.key);
    if (done.has(hash)) continue;
    const line = {
      ...base,
      scheme: rua.scheme,
      rua: ruaForLog(rua),
      ...totals,
      bytes: body.byteLength,
    };
    if (deps.now().getTime() >= deadlineAt) {
      await deps.releaseClaim(row.id, [...done]);
      summary.released++;
      logger.debug("TLS report handed back: the run's time budget ran out", base);
      return "released";
    }
    if (rua.scheme === "mailto" && (await deps.isSuppressed(rua.address))) {
      done.add(hash);
      summary.suppressed++;
      recordTlsRptReport(rua.scheme, "suppressed");
      logger.debug("TLS report not mailed: the address is suppressed", line);
      continue;
    }
    const slot = await deps.reserve(rua.destination);
    if (slot === "daily-cap") {
      /** Deferred to tomorrow by the daily cap: counted like the ones `deferAll` moves. */
      await deps.defer(row.id, [...done]);
      summary.capped++;
      recordTlsRptReport("any", "capped");
      return "capped";
    }
    if (slot === "destination-cap") {
      waiting++;
      summary.destinationCapped++;
      recordTlsRptReport(rua.scheme, "capped");
      logger.debug("TLS report held back: the destination's daily cap is reached", line);
      continue;
    }
    const outcome =
      rua.scheme === "mailto"
        ? await deps.mail({
            to: rua.address,
            policyDomain: row.policyDomain,
            submitter: tlsRpt.submitter,
            organizationName: tlsRpt.organizationName,
            contactEmail: tlsRpt.contactEmail,
            rfcReportId: row.rfcReportId,
            day: row.day,
            filename,
            body,
          })
        : await deps.post(rua.url, body);
    if (outcome.kind === "failed") {
      failures++;
      lastReason = outcome.reason;
      summary.failed++;
      logger.warn("TLS report not delivered", { ...line, reason: outcome.reason });
      continue;
    }
    done.add(hash);
    if (outcome.kind === "skipped") {
      /** Nothing went out: both slots are given back. */
      await deps.release(rua.destination);
      summary.skipped++;
      recordTlsRptReport(rua.scheme, "skipped");
      logger.warn("TLS report skipped", { ...line, reason: outcome.reason });
    } else {
      summary.sent++;
      recordTlsRptReport(rua.scheme, "sent");
      logger.info("TLS report sent", line);
    }
  }

  if (failures > 0) {
    const next = await retryOrDrop(row, [...done], deps, lastReason);
    if (next === "dropped") summary.finished++;
    for (const rua of record.rua) {
      if (!done.has(ruaHash(rua.key))) recordTlsRptReport(rua.scheme, next);
    }
    return "done";
  }
  if (waiting > 0) {
    /** Only destination caps held it back: tomorrow, for the addresses still owed. */
    await deps.defer(row.id, [...done]);
    return "done";
  }
  await deps.remove(row.id);
  summary.finished++;
  return "done";
}
