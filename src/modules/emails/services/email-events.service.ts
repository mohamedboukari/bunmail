import { inArray, lt, sql } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { emailEvents } from "../models/email-event.schema.ts";

/**
 * Open and click events (#187). Recording them comes with the tracking
 * endpoints; this file holds what the purge cycle needs now.
 */

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
