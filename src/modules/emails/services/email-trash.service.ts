import { eq, desc, and, sql, inArray, isNull, isNotNull } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { emails } from "../models/email.schema.ts";
import { deleteEmailsWithTombstones } from "./tombstone.service.ts";
import { logger } from "../../../utils/logger.ts";
import type { ListEmailsFilters, Email } from "../types/email.types.ts";

/* ─── Trash / Soft-Delete ─── */

/**
 * Moves an email to trash by setting `deletedAt = NOW()`. Scoped to apiKeyId
 * so users can only trash their own emails. Idempotent: calling twice is
 * harmless (deleted_at is just overwritten with NOW()).
 *
 * @returns The updated email row, or undefined if not found / wrong owner.
 */
export async function trashEmail(
  id: string,
  apiKeyId: string,
): Promise<Email | undefined> {
  logger.info("Trashing email", { id, apiKeyId });

  const [email] = await db
    .update(emails)
    .set({ deletedAt: new Date() })
    .where(
      and(eq(emails.id, id), eq(emails.apiKeyId, apiKeyId), isNull(emails.deletedAt)),
    )
    .returning();

  return email;
}

/**
 * Bulk-trash variant: moves many emails to trash in one query.
 * Returns the count of rows actually trashed (already-trashed and
 * not-owned rows are silently ignored).
 */
export async function trashEmails(ids: string[], apiKeyId: string): Promise<number> {
  if (ids.length === 0) return 0;
  logger.info("Bulk-trashing emails", { count: ids.length, apiKeyId });

  const rows = await db
    .update(emails)
    .set({ deletedAt: new Date() })
    .where(
      and(
        inArray(emails.id, ids),
        eq(emails.apiKeyId, apiKeyId),
        isNull(emails.deletedAt),
      ),
    )
    .returning({ id: emails.id });

  return rows.length;
}

/**
 * Lists trashed emails (deleted_at IS NOT NULL), scoped to apiKeyId.
 * Newest-trashed first.
 */
export async function listTrashedEmails(
  apiKeyId: string,
  filters: ListEmailsFilters,
): Promise<{ data: Email[]; total: number }> {
  const offset = (filters.page - 1) * filters.limit;

  const conditions = and(eq(emails.apiKeyId, apiKeyId), isNotNull(emails.deletedAt));

  const [data, [countRow]] = await Promise.all([
    db
      .select()
      .from(emails)
      .where(conditions)
      .orderBy(desc(emails.deletedAt))
      .limit(filters.limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(emails)
      .where(conditions),
  ]);

  return { data, total: countRow?.count ?? 0 };
}

/**
 * Restores a trashed email: clears `deletedAt`. Scoped to apiKeyId.
 */
export async function restoreEmail(
  id: string,
  apiKeyId: string,
): Promise<Email | undefined> {
  logger.info("Restoring email", { id, apiKeyId });

  const [email] = await db
    .update(emails)
    .set({ deletedAt: null })
    .where(
      and(eq(emails.id, id), eq(emails.apiKeyId, apiKeyId), isNotNull(emails.deletedAt)),
    )
    .returning();

  return email;
}

/**
 * Permanently deletes a trashed email. Only works on rows that are already
 * in trash: protects against accidentally bypassing the trash workflow.
 *
 * Routes through {@link deleteEmailsWithTombstones} (#34) so a snapshot
 * of identifiers + status is preserved past the hard-delete for late
 * complaint / bounce trace-back. Returns the deleted email's `id` only;
 * the rest of the row is gone, exactly as before, but `id` matches the
 * tombstone's id so callers can immediately fetch the snapshot if they
 * want to.
 */
export async function permanentDeleteEmail(
  id: string,
  apiKeyId: string,
): Promise<{ id: string } | undefined> {
  logger.info("Permanently deleting email", { id, apiKeyId });

  const rows = await deleteEmailsWithTombstones(
    and(eq(emails.id, id), eq(emails.apiKeyId, apiKeyId), isNotNull(emails.deletedAt)),
  );

  return rows[0];
}

/**
 * Empties the trash for a given API key: permanently deletes all
 * trashed emails for that key. Returns the count purged. Tombstones
 * are written for every deleted row (#34).
 */
export async function emptyEmailsTrash(apiKeyId: string): Promise<number> {
  logger.info("Emptying emails trash", { apiKeyId });

  const rows = await deleteEmailsWithTombstones(
    and(eq(emails.apiKeyId, apiKeyId), isNotNull(emails.deletedAt)),
  );

  return rows.length;
}

/* ─── Unscoped variants for the dashboard ─── */

/**
 * Lists trashed emails across all API keys: used by the dashboard trash view.
 */
export async function listTrashedEmailsUnscoped(
  filters: ListEmailsFilters,
): Promise<{ data: Email[]; total: number }> {
  const offset = (filters.page - 1) * filters.limit;
  const conditions = isNotNull(emails.deletedAt);

  const [data, [countRow]] = await Promise.all([
    db
      .select()
      .from(emails)
      .where(conditions)
      .orderBy(desc(emails.deletedAt))
      .limit(filters.limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(emails)
      .where(conditions),
  ]);

  return { data, total: countRow?.count ?? 0 };
}

/**
 * Dashboard variant of getEmailByIdUnscoped that explicitly returns
 * trashed rows: used to render the trashed email's detail view.
 */
export async function getTrashedEmailByIdUnscoped(
  id: string,
): Promise<Email | undefined> {
  const [email] = await db
    .select()
    .from(emails)
    .where(and(eq(emails.id, id), isNotNull(emails.deletedAt)));
  return email;
}

/** Dashboard: trash an email by id (no apiKey scoping). */
export async function trashEmailUnscoped(id: string): Promise<Email | undefined> {
  logger.info("Trashing email (unscoped)", { id });
  const [email] = await db
    .update(emails)
    .set({ deletedAt: new Date() })
    .where(and(eq(emails.id, id), isNull(emails.deletedAt)))
    .returning();
  return email;
}

/** Dashboard: bulk trash many ids (no apiKey scoping). */
export async function trashEmailsUnscoped(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  logger.info("Bulk-trashing emails (unscoped)", { count: ids.length });
  const rows = await db
    .update(emails)
    .set({ deletedAt: new Date() })
    .where(and(inArray(emails.id, ids), isNull(emails.deletedAt)))
    .returning({ id: emails.id });
  return rows.length;
}

/** Dashboard: restore a trashed email (no apiKey scoping). */
export async function restoreEmailUnscoped(id: string): Promise<Email | undefined> {
  logger.info("Restoring email (unscoped)", { id });
  const [email] = await db
    .update(emails)
    .set({ deletedAt: null })
    .where(and(eq(emails.id, id), isNotNull(emails.deletedAt)))
    .returning();
  return email;
}

/** Dashboard: permanently delete a trashed email (no apiKey scoping).
 *  Tombstone is recorded under the original email's apiKey via
 *  {@link deleteEmailsWithTombstones} (#34). */
export async function permanentDeleteEmailUnscoped(
  id: string,
): Promise<{ id: string } | undefined> {
  logger.info("Permanently deleting email (unscoped)", { id });
  const rows = await deleteEmailsWithTombstones(
    and(eq(emails.id, id), isNotNull(emails.deletedAt)),
  );
  return rows[0];
}

/** Dashboard: empty trash across all API keys. Tombstones recorded for
 *  every deleted row (#34). */
export async function emptyEmailsTrashUnscoped(): Promise<number> {
  logger.info("Emptying emails trash (unscoped)");
  const rows = await deleteEmailsWithTombstones(isNotNull(emails.deletedAt));
  return rows.length;
}
