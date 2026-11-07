import { createHash, randomUUID } from "crypto";
import { eq, lt, sql } from "drizzle-orm";
import { db, type DbExecutor } from "../../../db/index.ts";
import { generateId } from "../../../utils/id.ts";
import {
  tlsRptDailySends,
  tlsRptDestinationSends,
} from "../models/tls-rpt-daily-send.schema.ts";
import { tlsRptReports } from "../models/tls-rpt-report.schema.ts";
import { tlsRptResults } from "../models/tls-rpt-result.schema.ts";
import {
  TLSRPT_FAILURE_TYPES,
  type TlsRptObservation,
  type TlsRptPolicy,
  type TlsRptPolicyType,
  type TlsRptResultRow,
  type TlsRptResultType,
} from "../types/tls-rpt.types.ts";
import {
  joinBounded,
  reportDueAt,
  resultKeyFor,
  resultKeyOf,
  utcDay,
  type ResultKey,
} from "./tls-rpt-aggregate.ts";

/**
 * The TLS-RPT tables (#345): recording a session on its report, and what
 * the report job needs (claim, read, reschedule, delete, the daily cap).
 * The only module that touches `tlsrpt_reports`, `tlsrpt_results` and
 * `tlsrpt_daily_sends`.
 */

/** A report row as the job sees it. */
export type TlsRptReportRow = typeof tlsRptReports.$inferSelect;

/**
 * How long a claimed report stays invisible to other claims. Far longer
 * than one report can take (at most 5 addresses, a mail delivery capped
 * at 2 minutes and 2 MX hosts, an HTTPS one at 30 s), and reports are
 * claimed one at a time, so a lease never expires under a live send.
 */
const CLAIM_LEASE_MINUTES = 180;

function isPolicyType(value: string): value is TlsRptPolicyType {
  return value === "tlsa" || value === "sts" || value === "no-policy-found";
}

function isResultType(value: string): value is TlsRptResultType {
  return value === "success" || TLSRPT_FAILURE_TYPES.some((type) => type === value);
}

/**
 * Counts one session (`observation`) of `domain` under `policy` on the
 * report of `at`'s UTC day, creating the report (due after the day ends,
 * with jitter) on the day's first session. One transaction: the report
 * row is upserted first, which locks it, so the counters of one report are
 * capped ({@link resultKeyFor}) without a race. Returns whether the
 * session was counted (`dropped`: past the policy cap).
 */
export async function recordObservation(args: {
  domain: string;
  policy: TlsRptPolicy;
  observation: TlsRptObservation;
  at: Date;
  random?: () => number;
}): Promise<"recorded" | "dropped"> {
  const day = utcDay(args.at);
  const random = args.random ?? Math.random;
  const candidate = resultKeyOf(args.policy, args.observation);
  return db.transaction(async (tx) => {
    const [report] = await tx
      .insert(tlsRptReports)
      .values({
        id: generateId("trp"),
        day,
        policyDomain: args.domain,
        rfcReportId: randomUUID(),
        nextAttemptAt: reportDueAt(day, random()),
      })
      .onConflictDoUpdate({
        target: [tlsRptReports.day, tlsRptReports.policyDomain],
        set: { updatedAt: new Date() },
      })
      .returning({ id: tlsRptReports.id });
    if (!report) return "dropped";

    const existing = await readKeys(tx, report.id);
    const key = resultKeyFor(existing, candidate);
    if (key === null) return "dropped";
    await tx
      .insert(tlsRptResults)
      .values({
        id: generateId("trr"),
        reportId: report.id,
        ...key,
        policyString: joinBounded(args.policy.policyString),
        mxHost: joinBounded(args.policy.mxHost),
        sessionCount: 1,
      })
      .onConflictDoUpdate({
        target: [
          tlsRptResults.reportId,
          tlsRptResults.policyType,
          tlsRptResults.policyHash,
          tlsRptResults.resultType,
          tlsRptResults.receivingMxHostname,
          tlsRptResults.receivingIp,
          tlsRptResults.failureReasonCode,
        ],
        set: {
          sessionCount: sql`${tlsRptResults.sessionCount} + 1`,
          updatedAt: new Date(),
        },
      });
    return "recorded";
  });
}

/** The counter keys of a report (at most a few hundred, see the caps). */
async function readKeys(executor: DbExecutor, reportId: string): Promise<ResultKey[]> {
  const rows = await executor
    .select({
      policyType: tlsRptResults.policyType,
      policyHash: tlsRptResults.policyHash,
      resultType: tlsRptResults.resultType,
      receivingMxHostname: tlsRptResults.receivingMxHostname,
      receivingIp: tlsRptResults.receivingIp,
      failureReasonCode: tlsRptResults.failureReasonCode,
    })
    .from(tlsRptResults)
    .where(eq(tlsRptResults.reportId, reportId));
  const keys: ResultKey[] = [];
  for (const row of rows) {
    if (!isPolicyType(row.policyType) || !isResultType(row.resultType)) continue;
    keys.push({ ...row, policyType: row.policyType, resultType: row.resultType });
  }
  return keys;
}

/**
 * Claims up to `limit` due reports: their day is over (UTC) and their
 * `next_attempt_at` has passed. In one statement, `next_attempt_at` is
 * pushed forward by a lease and `attempts` counted, so two replicas never
 * send the same report and a replica that dies mid-send releases it when
 * the lease ends. A row another claim has locked is skipped.
 */
export async function claimDueReports(
  limit: number,
  executor: DbExecutor = db,
): Promise<TlsRptReportRow[]> {
  return executor
    .update(tlsRptReports)
    .set({
      nextAttemptAt: sql`NOW() + interval ${sql.raw(`'${CLAIM_LEASE_MINUTES} minutes'`)}`,
      attempts: sql`${tlsRptReports.attempts} + 1`,
      updatedAt: new Date(),
    })
    .where(
      sql`${tlsRptReports.id} IN (
        SELECT ${tlsRptReports.id} FROM ${tlsRptReports}
        WHERE ${tlsRptReports.nextAttemptAt} <= NOW()
          AND ${tlsRptReports.day} < (NOW() AT TIME ZONE 'UTC')::date
        ORDER BY ${tlsRptReports.nextAttemptAt} ASC, ${tlsRptReports.id}
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )`,
    )
    .returning();
}

/** Every counter of a report. Rows with an unknown type (a manual edit) are skipped. */
export async function loadReportResults(reportId: string): Promise<TlsRptResultRow[]> {
  const rows = await db
    .select({
      policyType: tlsRptResults.policyType,
      policyHash: tlsRptResults.policyHash,
      policyString: tlsRptResults.policyString,
      mxHost: tlsRptResults.mxHost,
      resultType: tlsRptResults.resultType,
      receivingMxHostname: tlsRptResults.receivingMxHostname,
      receivingIp: tlsRptResults.receivingIp,
      failureReasonCode: tlsRptResults.failureReasonCode,
      sessionCount: tlsRptResults.sessionCount,
    })
    .from(tlsRptResults)
    .where(eq(tlsRptResults.reportId, reportId));
  const results: TlsRptResultRow[] = [];
  for (const row of rows) {
    if (!isPolicyType(row.policyType) || !isResultType(row.resultType)) continue;
    results.push({ ...row, policyType: row.policyType, resultType: row.resultType });
  }
  return results;
}

/** Sets a report's next attempt and the addresses that already got it. */
export async function rescheduleReport(
  id: string,
  nextAttemptAt: Date,
  deliveredRua: readonly string[],
): Promise<void> {
  await db
    .update(tlsRptReports)
    .set({ nextAttemptAt, deliveredRua: deliveredRua.join("\n"), updatedAt: new Date() })
    .where(eq(tlsRptReports.id, id));
}

/** Deletes a report and its counters (sent, dropped, or no longer wanted). */
export async function deleteReport(id: string): Promise<void> {
  await db.delete(tlsRptReports).where(eq(tlsRptReports.id, id));
}

/** Today's UTC day, as the database sees it (one clock for every replica). */
const TODAY_UTC = sql`(NOW() AT TIME ZONE 'UTC')::date`;

/** Midnight UTC starting tomorrow, as a timestamptz. */
const TOMORROW_UTC = sql`(((NOW() AT TIME ZONE 'UTC')::date + 1)::timestamp AT TIME ZONE 'UTC')`;

/**
 * When a deferred report is next due: tomorrow (UTC), one to five hours
 * after midnight, random per row, so deferred reports spread out.
 */
const TOMORROW_WITH_JITTER = sql`${TOMORROW_UTC} + interval '1 hour' + random() * interval '4 hours'`;

/** The stored form of a destination: a short SHA-256, never the address or URL. */
export function destinationHash(destination: string): string {
  return createHash("sha256").update(destination).digest("hex").slice(0, 32);
}

/** Why {@link reserveSend} refused a delivery. */
export type ReserveOutcome = "reserved" | "daily-cap" | "destination-cap";

/**
 * Takes one of today's delivery slots (#345), every replica together,
 * for a delivery to `destination`: one of its
 * `caps.perDestination` and one of the instance's `caps.perDay`, in one
 * transaction. Each counter is an upsert that increments only while under
 * its cap, so concurrent callers can never exceed either. The destination
 * slot is taken first; when the daily cap then refuses, it is given back
 * in the same transaction.
 */
export async function reserveSend(
  destination: string,
  caps: { perDay: number; perDestination: number },
): Promise<ReserveOutcome> {
  const hash = destinationHash(destination);
  return db.transaction(async (tx) => {
    const forDestination = await tx
      .insert(tlsRptDestinationSends)
      .values({ day: TODAY_UTC, destinationHash: hash, sent: 1 })
      .onConflictDoUpdate({
        target: [tlsRptDestinationSends.day, tlsRptDestinationSends.destinationHash],
        set: { sent: sql`${tlsRptDestinationSends.sent} + 1`, updatedAt: new Date() },
        setWhere: sql`${tlsRptDestinationSends.sent} < ${caps.perDestination}`,
      })
      .returning({ sent: tlsRptDestinationSends.sent });
    if (forDestination.length === 0) return "destination-cap";
    const forDay = await tx
      .insert(tlsRptDailySends)
      .values({ day: TODAY_UTC, sent: 1 })
      .onConflictDoUpdate({
        target: tlsRptDailySends.day,
        set: { sent: sql`${tlsRptDailySends.sent} + 1`, updatedAt: new Date() },
        setWhere: sql`${tlsRptDailySends.sent} < ${caps.perDay}`,
      })
      .returning({ sent: tlsRptDailySends.sent });
    if (forDay.length > 0) return "reserved";
    await releaseDestination(tx, hash);
    return "daily-cap";
  });
}

/** Gives back one of today's slots of a destination. */
async function releaseDestination(executor: DbExecutor, hash: string): Promise<void> {
  await executor
    .update(tlsRptDestinationSends)
    .set({
      sent: sql`GREATEST(${tlsRptDestinationSends.sent} - 1, 0)`,
      updatedAt: new Date(),
    })
    .where(
      sql`${tlsRptDestinationSends.day} = ${TODAY_UTC} AND ${tlsRptDestinationSends.destinationHash} = ${hash}`,
    );
}

/**
 * Gives back both slots {@link reserveSend} took for a delivery that did
 * not go out (a mail delivery skipped for want of a usable sender).
 */
export async function releaseSend(destination: string): Promise<void> {
  await db.transaction(async (tx) => {
    await releaseDestination(tx, destinationHash(destination));
    await tx
      .update(tlsRptDailySends)
      .set({
        sent: sql`GREATEST(${tlsRptDailySends.sent} - 1, 0)`,
        updatedAt: new Date(),
      })
      .where(eq(tlsRptDailySends.day, TODAY_UTC));
  });
}

/** Whether today's deliveries already reached `cap`. */
export async function dailySendCapReached(
  cap: number,
  executor: DbExecutor = db,
): Promise<boolean> {
  const [row] = await executor
    .select({ sent: tlsRptDailySends.sent })
    .from(tlsRptDailySends)
    .where(eq(tlsRptDailySends.day, TODAY_UTC));
  return (row?.sent ?? 0) >= cap;
}

/**
 * Once the daily cap is reached: defers every report of a past day that
 * would otherwise be claimed today to tomorrow (one to five hours after
 * midnight UTC, random per report), where that day's cap applies to it.
 * Nothing is lost for good: the 7-day retention still bounds how long a
 * report waits. Returns how many were deferred now.
 */
export async function deferUnsentReports(executor: DbExecutor = db): Promise<number> {
  const deferred = await executor
    .update(tlsRptReports)
    .set({ nextAttemptAt: TOMORROW_WITH_JITTER, updatedAt: new Date() })
    .where(
      sql`${tlsRptReports.day} < ${TODAY_UTC} AND ${tlsRptReports.nextAttemptAt} < ${TOMORROW_UTC}`,
    )
    .returning({ id: tlsRptReports.id });
  return deferred.length;
}

/**
 * Defers one claimed report to tomorrow (a cap stopped it): keeps the
 * addresses that already got it and gives back the attempt its claim
 * counted, since a cap is not a failed attempt.
 */
export async function deferReport(
  id: string,
  deliveredRua: readonly string[],
): Promise<void> {
  await db
    .update(tlsRptReports)
    .set({
      nextAttemptAt: TOMORROW_WITH_JITTER,
      attempts: sql`GREATEST(${tlsRptReports.attempts} - 1, 0)`,
      deliveredRua: deliveredRua.join("\n"),
      updatedAt: new Date(),
    })
    .where(eq(tlsRptReports.id, id));
}

/**
 * Hands a claimed report back at once (the run's time budget ran out):
 * due now, so the next run or another replica goes on with it, with the
 * addresses that already got it kept and the claim's attempt given back.
 */
export async function releaseReport(
  id: string,
  deliveredRua: readonly string[],
): Promise<void> {
  await db
    .update(tlsRptReports)
    .set({
      nextAttemptAt: sql`NOW()`,
      attempts: sql`GREATEST(${tlsRptReports.attempts} - 1, 0)`,
      deliveredRua: deliveredRua.join("\n"),
      updatedAt: new Date(),
    })
    .where(eq(tlsRptReports.id, id));
}

/**
 * `true` for exactly one caller per day (every replica together): the one
 * that logs the day's "cap reached" warning.
 */
export async function claimDailyCapWarning(executor: DbExecutor = db): Promise<boolean> {
  const claimed = await executor
    .update(tlsRptDailySends)
    .set({ capWarned: true, updatedAt: new Date() })
    .where(
      sql`${tlsRptDailySends.day} = ${TODAY_UTC} AND ${tlsRptDailySends.capWarned} = false`,
    )
    .returning({ day: tlsRptDailySends.day });
  return claimed.length > 0;
}

/**
 * Deletes the reports of days more than `retentionDays` before today
 * (UTC), sent or not, with their counters, and the delivery counters of
 * those days. Returns how many reports went.
 */
export async function deleteExpiredReports(
  retentionDays: number,
  executor: DbExecutor = db,
): Promise<number> {
  const cutoff = sql`(NOW() AT TIME ZONE 'UTC')::date - ${sql.raw(String(Math.trunc(retentionDays)))}`;
  const deleted = await executor
    .delete(tlsRptReports)
    .where(lt(tlsRptReports.day, cutoff))
    .returning({ id: tlsRptReports.id });
  await executor.delete(tlsRptDailySends).where(lt(tlsRptDailySends.day, cutoff));
  await executor
    .delete(tlsRptDestinationSends)
    .where(lt(tlsRptDestinationSends.day, cutoff));
  return deleted.length;
}
