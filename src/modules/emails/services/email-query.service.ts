import { eq, desc, and, sql, isNull } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { emails } from "../models/email.schema.ts";
import { describeTagProblem, parseTagFilters, type TagFilter } from "./tags.ts";
import { InvalidTagError } from "../errors.ts";
import {
  attachmentStorage,
  listAttachmentMeta,
  type AttachmentMeta,
  type LoadedAttachment,
} from "./attachment-storage.ts";
import { logger } from "../../../utils/logger.ts";
import type { ListEmailsFilters, Email } from "../types/email.types.ts";

/**
 * Attachment metadata of these emails (#181), by email id, for
 * serializing them: one query, never reading the bytes. An email without
 * attachments is absent from the map.
 */
export async function attachmentsFor(
  emailIds: readonly string[],
): Promise<Map<string, AttachmentMeta[]>> {
  return listAttachmentMeta(db, emailIds);
}

/**
 * One attachment of an email, with its bytes (`null` once dropped), for
 * the dashboard download (#181); undefined when the email has no
 * attachment at that position. Unscoped, like the dashboard's email page;
 * an email in trash still has its attachments.
 */
export async function findAttachmentForDownload(
  emailId: string,
  position: number,
): Promise<LoadedAttachment | undefined> {
  const [found] = await attachmentStorage.loadAttachments(db, emailId, position);
  return found;
}

/**
 * Retrieves a single email by its ID, scoped to the requesting API key.
 *
 * The apiKeyId filter ensures users can only access emails they created:
 * prevents cross-tenant data leakage.
 *
 * @param id - The email ID (e.g. "msg_a1b2c3...")
 * @param apiKeyId - The authenticated API key ID (scope filter)
 * @returns The email row, or undefined if not found or not owned by this key
 */
export async function getEmailById(
  id: string,
  apiKeyId: string,
): Promise<Email | undefined> {
  logger.debug("Fetching email by ID", { id, apiKeyId });

  /** Excludes trashed rows: they're only accessible via the trash endpoints */
  const [email] = await db
    .select()
    .from(emails)
    .where(
      and(eq(emails.id, id), eq(emails.apiKeyId, apiKeyId), isNull(emails.deletedAt)),
    );

  if (!email) {
    logger.debug("Email not found", { id, apiKeyId });
  }

  return email;
}

/**
 * One containment condition per tag filter (#189), so an email must carry
 * them all (AND). The jsonb value is built in SQL from two text
 * parameters: a stringified `::jsonb` parameter would be bound as a jsonb
 * string by bun-sql and match nothing (#261). `@>` is what the GIN index
 * `idx_emails_tags` (`jsonb_path_ops`) serves.
 */
function tagClauses(filters: TagFilter[] | undefined) {
  return (filters ?? []).map(
    ({ key, value }) =>
      sql`${emails.tags} @> jsonb_build_object(${key}::text, ${value}::text)`,
  );
}

/** List filters as logged: tag keys only, never values (#189). */
function loggableFilters(filters: ListEmailsFilters) {
  const { tags, ...rest } = filters;
  return { ...rest, tagKeys: tags?.map((t) => t.key) };
}

/**
 * Checks the raw `tag` filters of a list request (#189) and returns them,
 * or logs the refusal (key and rule only) and throws `InvalidTagError`
 * (`422 VALIDATION_ERROR`, path `/tag`).
 */
export function checkTagFilters(raws: readonly string[], apiKeyId: string): TagFilter[] {
  const parsed = parseTagFilters(raws);
  if (parsed.ok) return parsed.filters;
  logger.warn("Email list refused: invalid tag filter", {
    apiKeyId,
    tag: parsed.key,
    problem: parsed.problem,
  });
  throw new InvalidTagError(
    parsed.problem,
    "/tag",
    describeTagProblem(parsed, "tag filter"),
  );
}

/**
 * Lists emails for a given API key with pagination and optional status filter.
 *
 * Returns the matching emails (newest first) plus a total count for
 * building pagination UI.
 *
 * @param apiKeyId - Only show emails created with this API key
 * @param filters - Pagination (page, limit) and optional status filter
 * @returns Object with `data` (email rows) and `total` (count for pagination)
 */
export async function listEmails(
  apiKeyId: string,
  filters: ListEmailsFilters,
): Promise<{ data: Email[]; total: number }> {
  /** Calculate how many rows to skip based on page number */
  const offset = (filters.page - 1) * filters.limit;

  logger.debug("Listing emails", { apiKeyId, ...loggableFilters(filters), offset });

  /**
   * Build the WHERE clause: always filter by API key + exclude trashed,
   * optionally by status and/or source (#137). The `apiKeyId` *filter*
   * doesn't apply here: this list is already scoped to the calling key.
   */
  const clauses = [eq(emails.apiKeyId, apiKeyId), isNull(emails.deletedAt)];
  if (filters.status) clauses.push(eq(emails.status, filters.status));
  if (filters.source) clauses.push(eq(emails.source, filters.source));
  clauses.push(...tagClauses(filters.tags));
  const conditions = and(...clauses);

  /** Run data query and count query in parallel for better performance */
  const [data, [countRow]] = await Promise.all([
    db
      .select()
      .from(emails)
      .where(conditions)
      .orderBy(desc(emails.createdAt))
      .limit(filters.limit)
      .offset(offset),

    db
      .select({ count: sql<number>`count(*)::int` })
      .from(emails)
      .where(conditions),
  ]);

  const total = countRow?.count ?? 0;

  logger.debug("Emails listed", { apiKeyId, returned: data.length, total });

  return { data, total };
}

/**
 * Lists all emails without API key scoping: used by the dashboard.
 *
 * Same as `listEmails` but doesn't filter by apiKeyId, giving a global
 * view of all emails across all API keys.
 *
 * @param filters - Pagination (page, limit) and optional status filter
 * @returns Object with `data` (email rows) and `total` (count for pagination)
 */
export async function listAllEmails(
  filters: ListEmailsFilters,
): Promise<{ data: Email[]; total: number }> {
  const offset = (filters.page - 1) * filters.limit;

  logger.debug("Listing all emails (unscoped)", { ...loggableFilters(filters), offset });

  /**
   * Build WHERE clause: exclude trashed; optionally filter by status,
   * source, and (dashboard-only) the sending API key (#137).
   */
  const clauses = [isNull(emails.deletedAt)];
  if (filters.status) clauses.push(eq(emails.status, filters.status));
  if (filters.source) clauses.push(eq(emails.source, filters.source));
  if (filters.apiKeyId) clauses.push(eq(emails.apiKeyId, filters.apiKeyId));
  clauses.push(...tagClauses(filters.tags));
  const conditions = and(...clauses);

  const [data, [countRow]] = await Promise.all([
    db
      .select()
      .from(emails)
      .where(conditions)
      .orderBy(desc(emails.createdAt))
      .limit(filters.limit)
      .offset(offset),

    db
      .select({ count: sql<number>`count(*)::int` })
      .from(emails)
      .where(conditions),
  ]);

  const total = countRow?.count ?? 0;

  logger.debug("All emails listed", { returned: data.length, total });

  return { data, total };
}

/**
 * Retrieves a single email by its ID without API key scoping: used by the dashboard.
 *
 * Unlike `getEmailById`, this doesn't check ownership, giving dashboard
 * admins access to any email regardless of which API key sent it.
 *
 * @param id - The email ID (e.g. "msg_a1b2c3...")
 * @returns The email row, or undefined if not found
 */
export async function getEmailByIdUnscoped(id: string): Promise<Email | undefined> {
  logger.debug("Fetching email by ID (unscoped)", { id });

  /** Excludes trashed rows: dashboard hits separate trash endpoints */
  const [email] = await db
    .select()
    .from(emails)
    .where(and(eq(emails.id, id), isNull(emails.deletedAt)));

  if (!email) {
    logger.debug("Email not found (unscoped)", { id });
  }

  return email;
}
