import { and, inArray, lt } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { webhookDeliveries } from "../models/webhook-delivery.schema.ts";

/* ─── Retention cleanup ─── */

/** Rows per retention delete, and how many batches one cleanup pass runs at most. */
const PURGE_BATCH_SIZE = 5000;
const PURGE_MAX_BATCHES = 100;

/**
 * Deletes finished deliveries (`delivered` and `failed`) whose last change
 * (`updated_at`: delivery, final failure) is older than `olderThan`, in
 * batches of `batchSize`, at most {@link PURGE_MAX_BATCHES} batches per
 * call (the rest goes at the next pass). `pending` rows, including the
 * ones in flight, are never deleted, whatever their age.
 *
 * `failed` rows used to be kept forever (#258): one key whose receiver
 * stayed down could grow the table without bound. They now age out with
 * `WEBHOOK_DELIVERY_RETENTION_DAYS` like delivered ones. A replayed row is
 * `pending` again and its clock restarts when it finishes.
 *
 * Run from the worker's hourly cleanup (see `runCleanupCycle`).
 */
export async function purgeOldDeliveries(opts: {
  olderThan: Date;
  batchSize?: number;
}): Promise<{ deleted: number }> {
  const batchSize = opts.batchSize ?? PURGE_BATCH_SIZE;
  const finishedBefore = and(
    inArray(webhookDeliveries.status, ["delivered", "failed"]),
    lt(webhookDeliveries.updatedAt, opts.olderThan),
  );
  let deleted = 0;
  for (let batch = 0; batch < PURGE_MAX_BATCHES; batch += 1) {
    const expired = db
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(finishedBefore)
      .limit(batchSize);
    const rows = await db
      .delete(webhookDeliveries)
      /** Re-checked on the row itself: a replay between the two reads keeps it. */
      .where(and(inArray(webhookDeliveries.id, expired), finishedBefore))
      .returning({ id: webhookDeliveries.id });
    deleted += rows.length;
    if (rows.length < batchSize) break;
  }
  return { deleted };
}
