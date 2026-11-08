import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { suppressions } from "../models/suppression.schema.ts";
import { logger } from "../../../utils/logger.ts";
import type { Suppression } from "../types/suppression.types.ts";

/**
 * Unscoped suppression reads and deletes for the dashboard (#89), across
 * every API key. Split out of `suppression.service.ts` (the key-scoped
 * CRUD, the send gate and the automatic writers) to keep each file to one
 * concern. Only the dashboard, behind its session and role guards, calls
 * these: the REST API stays key-scoped.
 */

/**
 * Paginated list across **all** API keys: admin-scoped view used by
 * `/dashboard/suppressions`. The scoped `listSuppressions` (`suppression.service.ts`) is
 * useless to the dashboard operator: auto-suppressions get filed
 * under whichever key the failing send happened to use, and the
 * operator's Bearer token usually isn't that key. Without this
 * unscoped read, recovering from a bad bounce means SSHing into the
 * DB. (#89)
 *
 * Filters:
 *   - `email`: case-insensitive *substring* match. The scoped variant
 *     uses exact match (it serves the hot-path send gate). The dashboard
 *     wants "find anything containing 'gmail.com'" UX, so we use ILIKE.
 *   - `apiKeyId`: exact match. Lets the operator drill into a single
 *     key's suppressions after spotting them in the global view.
 */
export async function listAllSuppressions(filters: {
  page: number;
  limit: number;
  email?: string;
  apiKeyId?: string;
}): Promise<{ data: Suppression[]; total: number }> {
  const offset = (filters.page - 1) * filters.limit;

  logger.debug("Listing all suppressions (unscoped)", { ...filters, offset });

  const conditions = [];
  if (filters.email) {
    /** ILIKE for case-insensitive substring search: matches the
     *  dashboard's "find anything with gmail.com" expectation. */
    conditions.push(
      sql`${suppressions.email} ILIKE ${"%" + filters.email.toLowerCase() + "%"}`,
    );
  }
  if (filters.apiKeyId) {
    conditions.push(eq(suppressions.apiKeyId, filters.apiKeyId));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [data, [countRow]] = await Promise.all([
    db
      .select()
      .from(suppressions)
      .where(where)
      .orderBy(desc(suppressions.createdAt))
      .limit(filters.limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(suppressions)
      .where(where),
  ]);

  return { data, total: countRow?.count ?? 0 };
}

/**
 * Hard delete by ID, no api-key check. The dashboard caller already
 * authenticated against the dashboard session: we trust the operator
 * to delete any suppression they can see. Returns the deleted row
 * (for logging / serialisation) or `undefined` when nothing matched.
 */
export async function deleteSuppressionByIdUnscoped(
  id: string,
): Promise<Suppression | undefined> {
  logger.info("Deleting suppression (unscoped)", { id });
  const [row] = await db.delete(suppressions).where(eq(suppressions.id, id)).returning();
  return row;
}
