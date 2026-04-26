import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { inboundEmails } from "../models/inbound-email.schema.ts";
import { logger } from "../../../utils/logger.ts";
import type { InboundEmail } from "../types/inbound.types.ts";

/**
 * Pagination filters used by inbound list endpoints.
 */
export interface ListInboundFilters {
  page: number;
  limit: number;
}

/* ─── Reads (exclude trashed by default) ─── */

/**
 * Lists non-trashed inbound emails, newest first.
 */
export async function listInboundEmails(
  filters: ListInboundFilters,
): Promise<{ data: InboundEmail[]; total: number }> {
  const offset = (filters.page - 1) * filters.limit;
  logger.debug("Listing inbound emails", { ...filters, offset });

  const conditions = isNull(inboundEmails.deletedAt);

  const [data, [countRow]] = await Promise.all([
    db
      .select()
      .from(inboundEmails)
      .where(conditions)
      .orderBy(desc(inboundEmails.receivedAt))
      .limit(filters.limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(inboundEmails)
      .where(conditions),
  ]);

  return { data, total: countRow?.count ?? 0 };
}

/**
 * Returns a single inbound email by id, excluding trashed rows.
 */
export async function getInboundEmailById(id: string): Promise<InboundEmail | undefined> {
  const [email] = await db
    .select()
    .from(inboundEmails)
    .where(and(eq(inboundEmails.id, id), isNull(inboundEmails.deletedAt)));
  return email;
}

/* ─── Trash / Soft-Delete ─── */

/**
 * Moves an inbound email to trash. Idempotent.
 */
export async function trashInboundEmail(id: string): Promise<InboundEmail | undefined> {
  logger.info("Trashing inbound email", { id });
  const [email] = await db
    .update(inboundEmails)
    .set({ deletedAt: new Date() })
    .where(and(eq(inboundEmails.id, id), isNull(inboundEmails.deletedAt)))
    .returning();
  return email;
}

/**
 * Bulk-trash inbound emails. Returns count actually trashed.
 */
export async function trashInboundEmails(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  logger.info("Bulk-trashing inbound emails", { count: ids.length });
  const rows = await db
    .update(inboundEmails)
    .set({ deletedAt: new Date() })
    .where(and(inArray(inboundEmails.id, ids), isNull(inboundEmails.deletedAt)))
    .returning({ id: inboundEmails.id });
  return rows.length;
}

/**
 * Lists trashed inbound emails (deleted_at IS NOT NULL), newest-trashed first.
 */
export async function listTrashedInboundEmails(
  filters: ListInboundFilters,
): Promise<{ data: InboundEmail[]; total: number }> {
  const offset = (filters.page - 1) * filters.limit;
  const conditions = isNotNull(inboundEmails.deletedAt);

  const [data, [countRow]] = await Promise.all([
    db
      .select()
      .from(inboundEmails)
      .where(conditions)
      .orderBy(desc(inboundEmails.deletedAt))
      .limit(filters.limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(inboundEmails)
      .where(conditions),
  ]);

  return { data, total: countRow?.count ?? 0 };
}

/**
 * Returns a trashed inbound email by id (deleted_at IS NOT NULL).
 */
export async function getTrashedInboundEmailById(
  id: string,
): Promise<InboundEmail | undefined> {
  const [email] = await db
    .select()
    .from(inboundEmails)
    .where(and(eq(inboundEmails.id, id), isNotNull(inboundEmails.deletedAt)));
  return email;
}

/**
 * Restores a trashed inbound email — clears deleted_at.
 */
export async function restoreInboundEmail(id: string): Promise<InboundEmail | undefined> {
  logger.info("Restoring inbound email", { id });
  const [email] = await db
    .update(inboundEmails)
    .set({ deletedAt: null })
    .where(and(eq(inboundEmails.id, id), isNotNull(inboundEmails.deletedAt)))
    .returning();
  return email;
}

/**
 * Permanently deletes a trashed inbound email. Only works on already-trashed
 * rows — protects against bypassing the trash workflow.
 */
export async function permanentDeleteInboundEmail(
  id: string,
): Promise<InboundEmail | undefined> {
  logger.info("Permanently deleting inbound email", { id });
  const [email] = await db
    .delete(inboundEmails)
    .where(and(eq(inboundEmails.id, id), isNotNull(inboundEmails.deletedAt)))
    .returning();
  return email;
}

/**
 * Empties the inbound trash — permanently deletes all trashed inbound rows.
 * Returns count purged.
 */
export async function emptyInboundTrash(): Promise<number> {
  logger.info("Emptying inbound trash");
  const rows = await db
    .delete(inboundEmails)
    .where(isNotNull(inboundEmails.deletedAt))
    .returning({ id: inboundEmails.id });
  return rows.length;
}
