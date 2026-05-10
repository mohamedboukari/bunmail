/**
 * Email tombstone service (#34).
 *
 * Owns the post-purge audit trail. Three concerns:
 *
 *   1. **Record + delete in one transaction.** Every hard-delete path
 *      in the codebase (the trash purge sweep, per-row API delete, bulk
 *      `empty trash`, and dashboard equivalents) routes through
 *      {@link deleteEmailsWithTombstones}. The transaction wraps the
 *      tombstone INSERTs and the email DELETEs so a partial failure
 *      can never leave orphaned tombstones or undeleted-but-tombstoned
 *      emails.
 *   2. **Read API.** {@link listTombstones} / {@link getTombstoneById}
 *      let operators trace late complaints + bounces back to a sent
 *      message after the original row has been hard-deleted. The hot
 *      path is "find the tombstone by `messageId`" — indexed on
 *      `(message_id)` for that.
 *   3. **Retention.** {@link purgeOldTombstones} deletes tombstones
 *      older than `TOMBSTONE_RETENTION_DAYS` (default 90). Called from
 *      the existing trash purge poll loop — same cadence, different
 *      cutoff.
 *
 * Tombstones do NOT preserve body / html / text — the whole point is
 * to drop sensitive payload past the trash retention window. Only
 * identifiers stay.
 */

import { and, desc, eq, lt, sql, type SQL } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { emails } from "../models/email.schema.ts";
import {
  emailTombstones,
  type EmailTombstone,
} from "../models/email-tombstone.schema.ts";
import { logger } from "../../../utils/logger.ts";

/**
 * Atomically writes tombstones for the email rows matching `where`,
 * then hard-deletes those same rows. Single Postgres transaction —
 * either both succeed or neither does.
 *
 * Returns the deleted email ids so callers can mirror the existing
 * `.returning({ id })` shape from before this PR. The five hard-delete
 * paths in the repo each call this and previously returned a `{ id }[]`
 * — by keeping the same shape we get a no-op refactor at the call sites.
 */
export async function deleteEmailsWithTombstones(
  /** Drizzle WHERE clause for both the tombstone snapshot SELECT and
   *  the subsequent DELETE. Must be an `and(...)` / `eq(...)` / etc;
   *  pass `undefined` to operate on the whole table (only used by
   *  test helpers — production paths always scope). */
  where: SQL | undefined,
): Promise<Array<{ id: string }>> {
  return db.transaction(async (tx) => {
    /** Snapshot the rows we're about to delete. We need every column
     *  that the tombstone schema mirrors — pull them in one round trip. */
    const rows = await tx
      .select({
        id: emails.id,
        apiKeyId: emails.apiKeyId,
        messageId: emails.messageId,
        fromAddress: emails.fromAddress,
        toAddress: emails.toAddress,
        subject: emails.subject,
        status: emails.status,
        sentAt: emails.sentAt,
        deletedAt: emails.deletedAt,
      })
      .from(emails)
      .where(where);

    if (rows.length === 0) return [];

    /** Bulk insert tombstones. The id matches the original email's id
     *  by design — operators look up post-purge by the same id. */
    await tx.insert(emailTombstones).values(
      rows.map((r) => ({
        id: r.id,
        apiKeyId: r.apiKeyId,
        messageId: r.messageId,
        fromAddress: r.fromAddress,
        toAddress: r.toAddress,
        subject: r.subject,
        status: r.status,
        sentAt: r.sentAt,
        deletedAt: r.deletedAt,
      })),
    );

    /** And the actual hard-delete. */
    const deleted = await tx.delete(emails).where(where).returning({ id: emails.id });

    logger.debug("Recorded email tombstones + hard-deleted", {
      count: deleted.length,
    });

    return deleted;
  });
}

/* ─── Read-side queries ─── */

/**
 * Paginated list of tombstones for an api key. Optional `messageId`
 * filter is the operator's hot path: "I got a complaint mentioning
 * `<abc@x>` — did we send it?".
 */
export async function listTombstones(opts: {
  apiKeyId: string;
  messageId?: string;
  page: number;
  limit: number;
}): Promise<{ data: EmailTombstone[]; total: number }> {
  const filters: SQL[] = [eq(emailTombstones.apiKeyId, opts.apiKeyId)];
  if (opts.messageId) {
    /** SMTP Message-IDs sometimes ship wrapped in angle brackets.
     *  Match with-and-without to be forgiving — operators paste from
     *  whatever they got. */
    const wrapped = `<${opts.messageId.replace(/^<|>$/g, "")}>`;
    const unwrapped = opts.messageId.replace(/^<|>$/g, "");
    filters.push(
      sql`(${emailTombstones.messageId} = ${wrapped} OR ${emailTombstones.messageId} = ${unwrapped})`,
    );
  }
  const condition = and(...filters);
  const offset = (opts.page - 1) * opts.limit;

  const [data, totalRows] = await Promise.all([
    db
      .select()
      .from(emailTombstones)
      .where(condition)
      .orderBy(desc(emailTombstones.purgedAt))
      .limit(opts.limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(emailTombstones)
      .where(condition),
  ]);
  return { data, total: totalRows[0]?.count ?? 0 };
}

/**
 * Single tombstone lookup, scoped to the calling api key.
 */
export async function getTombstoneById(opts: {
  id: string;
  apiKeyId: string;
}): Promise<EmailTombstone | undefined> {
  const [row] = await db
    .select()
    .from(emailTombstones)
    .where(
      and(eq(emailTombstones.id, opts.id), eq(emailTombstones.apiKeyId, opts.apiKeyId)),
    )
    .limit(1);
  return row;
}

/** Dashboard read — unscoped (admin sees all api keys). */
export async function listAllTombstones(opts: {
  messageId?: string;
  page: number;
  limit: number;
}): Promise<{ data: EmailTombstone[]; total: number }> {
  const filters: SQL[] = [];
  if (opts.messageId) {
    const wrapped = `<${opts.messageId.replace(/^<|>$/g, "")}>`;
    const unwrapped = opts.messageId.replace(/^<|>$/g, "");
    filters.push(
      sql`(${emailTombstones.messageId} = ${wrapped} OR ${emailTombstones.messageId} = ${unwrapped})`,
    );
  }
  const condition = filters.length > 0 ? and(...filters) : undefined;
  const offset = (opts.page - 1) * opts.limit;

  const [data, totalRows] = await Promise.all([
    db
      .select()
      .from(emailTombstones)
      .where(condition)
      .orderBy(desc(emailTombstones.purgedAt))
      .limit(opts.limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(emailTombstones)
      .where(condition),
  ]);
  return { data, total: totalRows[0]?.count ?? 0 };
}

/* ─── Retention cleanup ─── */

/**
 * Deletes tombstones whose `purged_at` is older than the cutoff. Called
 * from the existing trash purge loop — same 6h cadence, different
 * retention window (90d default vs 7d for trash).
 */
export async function purgeOldTombstones(opts: {
  olderThan: Date;
}): Promise<{ deleted: number }> {
  const result = await db
    .delete(emailTombstones)
    .where(lt(emailTombstones.purgedAt, opts.olderThan))
    .returning({ id: emailTombstones.id });
  return { deleted: result.length };
}
