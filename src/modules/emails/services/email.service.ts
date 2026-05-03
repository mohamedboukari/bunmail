import { eq, desc, and, sql, inArray, isNull, isNotNull } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { emails } from "../models/email.schema.ts";
import { domains } from "../../domains/models/domain.schema.ts";
import { templates } from "../../templates/models/template.schema.ts";
import { renderTemplate } from "../../templates/services/template.service.ts";
import { generateId } from "../../../utils/id.ts";
import { logger } from "../../../utils/logger.ts";
import { redactEmail } from "../../../utils/redact.ts";
import { config } from "../../../config.ts";
import type { SendEmailInput, ListEmailsFilters, Email } from "../types/email.types.ts";

/**
 * Creates a new email record in the database with status `queued`.
 *
 * Supports two modes:
 * 1. Direct content — subject, html, text provided inline.
 * 2. Template — templateId + variables resolved from the templates table.
 *
 * Also links the sender's domain for DKIM signing.
 */
export async function createEmail(
  input: SendEmailInput,
  apiKeyId: string,
): Promise<Email> {
  const id = generateId("msg");
  const senderDomain = input.from.split("@")[1];

  logger.info("Creating email", {
    id,
    from: redactEmail(input.from),
    to: redactEmail(input.to),
    apiKeyId,
  });

  let subject = input.subject ?? "";
  let htmlContent = input.html ?? null;
  let textContent = input.text ?? null;

  if (input.templateId) {
    const [tpl] = await db
      .select()
      .from(templates)
      .where(and(eq(templates.id, input.templateId), eq(templates.apiKeyId, apiKeyId)));

    if (!tpl) {
      throw new Error(`Template "${input.templateId}" not found`);
    }

    const vars = input.variables ?? {};
    subject = renderTemplate(tpl.subject, vars);
    htmlContent = tpl.html ? renderTemplate(tpl.html, vars) : null;
    textContent = tpl.textContent ? renderTemplate(tpl.textContent, vars) : null;
  }

  if (!subject) {
    throw new Error("Subject is required — provide it inline or via a template.");
  }

  let domainId: string | null = null;

  if (senderDomain) {
    const [domain] = await db
      .select({ id: domains.id, dkimVerified: domains.dkimVerified })
      .from(domains)
      .where(eq(domains.name, senderDomain));

    if (domain) {
      domainId = domain.id;
    } else if (config.env === "production") {
      throw new Error(
        `Domain "${senderDomain}" is not registered. Add it via the API or dashboard before sending.`,
      );
    }

    if (config.env === "production" && domain && !domain.dkimVerified) {
      logger.warn("Sending from unverified domain", { domain: senderDomain });
    }
  }

  const [email] = await db
    .insert(emails)
    .values({
      id,
      apiKeyId,
      domainId,
      fromAddress: input.from,
      toAddress: input.to,
      cc: input.cc ?? null,
      bcc: input.bcc ?? null,
      subject,
      html: htmlContent,
      textContent,
    })
    .returning();

  logger.debug("Email created and queued", { id, status: email!.status, domainId });

  return email!;
}

/**
 * Retrieves a single email by its ID, scoped to the requesting API key.
 *
 * The apiKeyId filter ensures users can only access emails they created —
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

  /** Excludes trashed rows — they're only accessible via the trash endpoints */
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

  logger.debug("Listing emails", { apiKeyId, ...filters, offset });

  /**
   * Build the WHERE clause — always filter by API key + exclude trashed,
   * optionally by status.
   */
  const conditions = filters.status
    ? and(
        eq(emails.apiKeyId, apiKeyId),
        isNull(emails.deletedAt),
        eq(emails.status, filters.status),
      )
    : and(eq(emails.apiKeyId, apiKeyId), isNull(emails.deletedAt));

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
 * Lists all emails without API key scoping — used by the dashboard.
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

  logger.debug("Listing all emails (unscoped)", { ...filters, offset });

  /** Build WHERE clause — exclude trashed; optionally filter by status */
  const conditions = filters.status
    ? and(isNull(emails.deletedAt), eq(emails.status, filters.status))
    : isNull(emails.deletedAt);

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
 * Retrieves a single email by its ID without API key scoping — used by the dashboard.
 *
 * Unlike `getEmailById`, this doesn't check ownership, giving dashboard
 * admins access to any email regardless of which API key sent it.
 *
 * @param id - The email ID (e.g. "msg_a1b2c3...")
 * @returns The email row, or undefined if not found
 */
export async function getEmailByIdUnscoped(id: string): Promise<Email | undefined> {
  logger.debug("Fetching email by ID (unscoped)", { id });

  /** Excludes trashed rows — dashboard hits separate trash endpoints */
  const [email] = await db
    .select()
    .from(emails)
    .where(and(eq(emails.id, id), isNull(emails.deletedAt)));

  if (!email) {
    logger.debug("Email not found (unscoped)", { id });
  }

  return email;
}

/* ─── Trash / Soft-Delete ─── */

/**
 * Moves an email to trash by setting `deletedAt = NOW()`. Scoped to apiKeyId
 * so users can only trash their own emails. Idempotent — calling twice is
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
 * Bulk-trash variant — moves many emails to trash in one query.
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
 * Restores a trashed email — clears `deletedAt`. Scoped to apiKeyId.
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
 * in trash — protects against accidentally bypassing the trash workflow.
 */
export async function permanentDeleteEmail(
  id: string,
  apiKeyId: string,
): Promise<Email | undefined> {
  logger.info("Permanently deleting email", { id, apiKeyId });

  const [email] = await db
    .delete(emails)
    .where(
      and(eq(emails.id, id), eq(emails.apiKeyId, apiKeyId), isNotNull(emails.deletedAt)),
    )
    .returning();

  return email;
}

/**
 * Empties the trash for a given API key — permanently deletes all
 * trashed emails for that key. Returns the count purged.
 */
export async function emptyEmailsTrash(apiKeyId: string): Promise<number> {
  logger.info("Emptying emails trash", { apiKeyId });

  const rows = await db
    .delete(emails)
    .where(and(eq(emails.apiKeyId, apiKeyId), isNotNull(emails.deletedAt)))
    .returning({ id: emails.id });

  return rows.length;
}

/* ─── Unscoped variants for the dashboard ─── */

/**
 * Lists trashed emails across all API keys — used by the dashboard trash view.
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
 * trashed rows — used to render the trashed email's detail view.
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

/** Dashboard: permanently delete a trashed email (no apiKey scoping). */
export async function permanentDeleteEmailUnscoped(
  id: string,
): Promise<Email | undefined> {
  logger.info("Permanently deleting email (unscoped)", { id });
  const [email] = await db
    .delete(emails)
    .where(and(eq(emails.id, id), isNotNull(emails.deletedAt)))
    .returning();
  return email;
}

/** Dashboard: empty trash across all API keys. */
export async function emptyEmailsTrashUnscoped(): Promise<number> {
  logger.info("Emptying emails trash (unscoped)");
  const rows = await db
    .delete(emails)
    .where(isNotNull(emails.deletedAt))
    .returning({ id: emails.id });
  return rows.length;
}
