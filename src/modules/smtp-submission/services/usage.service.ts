import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { smtpSubmissionUsage } from "../models/smtp-submission-usage.schema.ts";
import { generateId } from "../../../utils/id.ts";

/**
 * Usage tracking for the SMTP submission server (#123).
 *
 * Maintains one `smtp_submission_usage` row per (API key, UTC day) with
 * `accepted` / `rejected` counters. Used for the per-key daily quota and
 * the stats endpoint. See the schema file for the design rationale.
 */

/** Outcome recorded for a post-auth submission attempt. */
export type SubmissionOutcome = "accepted" | "rejected";

/** A single day's counters, as returned by the stats query. */
export interface DailyUsage {
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  accepted: number;
  rejected: number;
}

/** Aggregated stats for an API key over a window. */
export interface UsageStats {
  /** Number of days requested (the window width). */
  days: number;
  totals: { accepted: number; rejected: number };
  /** Per-day rows, oldest first. Days with no activity are omitted. */
  daily: DailyUsage[];
}

/** Today's UTC date as `YYYY-MM-DD` (the quota / bucketing key). */
function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Records one submission outcome for an API key on the current UTC day.
 * Upserts the day's row and increments the matching counter atomically
 * (`ON CONFLICT (api_key_id, day) DO UPDATE`), so concurrent submissions
 * for the same key don't lose increments.
 */
export async function recordOutcome(
  apiKeyId: string,
  outcome: SubmissionOutcome,
): Promise<void> {
  const day = utcDay();
  const acceptedInc = outcome === "accepted" ? 1 : 0;
  const rejectedInc = outcome === "rejected" ? 1 : 0;

  await db
    .insert(smtpSubmissionUsage)
    .values({
      id: generateId("smu"),
      apiKeyId,
      day,
      accepted: acceptedInc,
      rejected: rejectedInc,
    })
    .onConflictDoUpdate({
      target: [smtpSubmissionUsage.apiKeyId, smtpSubmissionUsage.day],
      set: {
        accepted: sql`${smtpSubmissionUsage.accepted} + ${acceptedInc}`,
        rejected: sql`${smtpSubmissionUsage.rejected} + ${rejectedInc}`,
        updatedAt: new Date(),
      },
    });
}

/**
 * Returns how many messages the key has had accepted so far today (UTC).
 * Used for the daily-quota check. Returns 0 when there's no row yet.
 */
export async function getAcceptedToday(apiKeyId: string): Promise<number> {
  const [row] = await db
    .select({ accepted: smtpSubmissionUsage.accepted })
    .from(smtpSubmissionUsage)
    .where(
      and(
        eq(smtpSubmissionUsage.apiKeyId, apiKeyId),
        eq(smtpSubmissionUsage.day, utcDay()),
      ),
    );
  return row?.accepted ?? 0;
}

/**
 * Takes one message from the key's daily quota, atomically (#190).
 *
 * One statement: insert today's row with `accepted = 1`, or increment
 * `accepted` only while it is below `dailyQuota`. Postgres locks the row
 * for the conflict update, so concurrent sessions (and replicas) queue on
 * it and exactly `dailyQuota` reservations succeed per day; reading the
 * count first and recording after the send let every concurrent session
 * pass. `dailyQuota` must be at least 1 (0 means no quota: don't call).
 *
 * @returns the UTC day the reservation was counted on, to hand back to
 *   {@link releaseReservation}, or `null` when the quota is used up.
 */
export async function reserveAccepted(
  apiKeyId: string,
  dailyQuota: number,
): Promise<string | null> {
  const day = utcDay();
  const reserved = await db
    .insert(smtpSubmissionUsage)
    .values({ id: generateId("smu"), apiKeyId, day, accepted: 1, rejected: 0 })
    .onConflictDoUpdate({
      target: [smtpSubmissionUsage.apiKeyId, smtpSubmissionUsage.day],
      set: { accepted: sql`${smtpSubmissionUsage.accepted} + 1`, updatedAt: new Date() },
      setWhere: sql`${smtpSubmissionUsage.accepted} < ${dailyQuota}`,
    })
    .returning({ id: smtpSubmissionUsage.id });
  return reserved.length > 0 ? day : null;
}

/**
 * Hands back a reservation whose message was then rejected (#190): moves
 * one count from `accepted` to `rejected` on the day it was taken, in one
 * statement, so the quota slot is free again and the rejection is still
 * recorded.
 */
export async function releaseReservation(apiKeyId: string, day: string): Promise<void> {
  await db
    .update(smtpSubmissionUsage)
    .set({
      accepted: sql`GREATEST(${smtpSubmissionUsage.accepted} - 1, 0)`,
      rejected: sql`${smtpSubmissionUsage.rejected} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(eq(smtpSubmissionUsage.apiKeyId, apiKeyId), eq(smtpSubmissionUsage.day, day)),
    );
}

/**
 * Aggregates usage for an API key over the last `days` UTC days (inclusive
 * of today). Returns per-day rows (oldest first) plus window totals.
 */
export async function getStats(apiKeyId: string, days: number): Promise<UsageStats> {
  /** Window start = today minus (days - 1), as a UTC YYYY-MM-DD string. */
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const startDay = utcDay(start);

  const rows = await db
    .select({
      day: smtpSubmissionUsage.day,
      accepted: smtpSubmissionUsage.accepted,
      rejected: smtpSubmissionUsage.rejected,
    })
    .from(smtpSubmissionUsage)
    .where(
      and(
        eq(smtpSubmissionUsage.apiKeyId, apiKeyId),
        gte(smtpSubmissionUsage.day, startDay),
      ),
    )
    .orderBy(smtpSubmissionUsage.day);

  const daily: DailyUsage[] = rows.map((r) => ({
    day: r.day,
    accepted: r.accepted,
    rejected: r.rejected,
  }));

  const totals = daily.reduce(
    (acc, r) => ({
      accepted: acc.accepted + r.accepted,
      rejected: acc.rejected + r.rejected,
    }),
    { accepted: 0, rejected: 0 },
  );

  return { days, totals, daily };
}
