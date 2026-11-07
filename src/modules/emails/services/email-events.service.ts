import { and, asc, count, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { logger } from "../../../utils/logger.ts";
import { emailEvents } from "../models/email-event.schema.ts";
import { emails } from "../models/email.schema.ts";

/**
 * Open and click events (#187): the list behind
 * `GET /api/v1/emails/:id/events` and the dashboard timeline, and the
 * retention purge. They are written by the tracking module
 * (`tracking-record.service.ts`).
 */

/** One stored event, as the list returns it. */
export type EmailEvent = typeof emailEvents.$inferSelect;

/**
 * The events of one email, oldest first (a timeline), `limit` per page.
 * Scoped like `getEmailById`: `null` when the email does not exist, is
 * another key's, or is in the trash (a 404 for the caller). Without an
 * `apiKeyId` (the dashboard, whose email page also shows trashed
 * emails) any email is read, trashed or not.
 */
export async function listEmailEvents(
  emailId: string,
  apiKeyId: string | null,
  page: { page: number; limit: number },
): Promise<{ data: EmailEvent[]; total: number } | null> {
  const [email] = await db
    .select({ id: emails.id })
    .from(emails)
    .where(
      and(
        eq(emails.id, emailId),
        apiKeyId === null ? undefined : isNull(emails.deletedAt),
        apiKeyId === null ? undefined : eq(emails.apiKeyId, apiKeyId),
      ),
    )
    .limit(1);
  if (!email) {
    logger.debug("Email events not listed: email not found", { emailId, apiKeyId });
    return null;
  }
  const offset = (page.page - 1) * page.limit;
  const [data, [counted]] = await Promise.all([
    db
      .select()
      .from(emailEvents)
      .where(eq(emailEvents.emailId, emailId))
      .orderBy(asc(emailEvents.occurredAt), asc(emailEvents.id))
      .limit(page.limit)
      .offset(offset),
    db.select({ n: count() }).from(emailEvents).where(eq(emailEvents.emailId, emailId)),
  ]);
  return { data, total: counted?.n ?? 0 };
}

/** Rows per retention delete, and how many batches one purge pass runs at most. */
const PURGE_BATCH_SIZE = 5000;
const PURGE_MAX_BATCHES = 100;

/**
 * Deletes open and click events older than `retentionDays` (#187,
 * `EMAIL_EVENTS_RETENTION_DAYS`), in batches of `batchSize`, at most
 * `PURGE_MAX_BATCHES` per call (the rest goes at the next pass). The
 * cutoff is computed on the database clock, like `occurred_at`. Events of
 * a deleted email are already gone with it (`ON DELETE CASCADE`).
 *
 * @returns how many events were deleted.
 */
export async function purgeOldEmailEvents(
  retentionDays: number,
  batchSize: number = PURGE_BATCH_SIZE,
): Promise<number> {
  /** A whole number of days from the config reader, inlined as an interval literal. */
  const cutoff = sql`now() - ${sql.raw(`interval '${Math.trunc(retentionDays)} days'`)}`;
  let deleted = 0;
  for (let batch = 0; batch < PURGE_MAX_BATCHES; batch += 1) {
    const expired = db
      .select({ id: emailEvents.id })
      .from(emailEvents)
      .where(lt(emailEvents.occurredAt, cutoff))
      .limit(batchSize);
    const rows = await db
      .delete(emailEvents)
      .where(inArray(emailEvents.id, expired))
      .returning({ id: emailEvents.id });
    deleted += rows.length;
    if (rows.length < batchSize) break;
  }
  return deleted;
}
