import { eq, desc, and, sql } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { emails } from "../models/email.schema.ts";
import { generateId } from "../../../utils/id.ts";
import { logger } from "../../../utils/logger.ts";
import type { SendEmailInput, ListEmailsFilters, Email } from "../types/email.types.ts";

/**
 * Creates a new email record in the database with status `queued`.
 *
 * The queue processor will pick it up on its next poll cycle and
 * attempt SMTP delivery. The raw email data is stored as-is — no
 * transformation happens here.
 *
 * @param input - The email content (from, to, subject, html/text, etc.)
 * @param apiKeyId - The ID of the API key used to send this email
 * @returns The newly created email row
 */
export async function createEmail(input: SendEmailInput, apiKeyId: string): Promise<Email> {
  /** Generate a unique prefixed ID for this email */
  const id = generateId("msg");

  logger.info("Creating email", { id, from: input.from, to: input.to, apiKeyId });

  const [email] = await db
    .insert(emails)
    .values({
      id,
      apiKeyId,
      fromAddress: input.from,
      toAddress: input.to,
      cc: input.cc ?? null,
      bcc: input.bcc ?? null,
      subject: input.subject,
      html: input.html ?? null,
      textContent: input.text ?? null,
    })
    .returning();

  logger.debug("Email created and queued", { id, status: email!.status });

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
export async function getEmailById(id: string, apiKeyId: string): Promise<Email | undefined> {
  logger.debug("Fetching email by ID", { id, apiKeyId });

  const [email] = await db
    .select()
    .from(emails)
    .where(and(eq(emails.id, id), eq(emails.apiKeyId, apiKeyId)));

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
  filters: ListEmailsFilters
): Promise<{ data: Email[]; total: number }> {
  /** Calculate how many rows to skip based on page number */
  const offset = (filters.page - 1) * filters.limit;

  logger.debug("Listing emails", { apiKeyId, ...filters, offset });

  /** Build the WHERE clause — always filter by API key, optionally by status */
  const conditions = filters.status
    ? and(eq(emails.apiKeyId, apiKeyId), eq(emails.status, filters.status))
    : eq(emails.apiKeyId, apiKeyId);

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
  filters: ListEmailsFilters
): Promise<{ data: Email[]; total: number }> {
  const offset = (filters.page - 1) * filters.limit;

  logger.debug("Listing all emails (unscoped)", { ...filters, offset });

  /** Build WHERE clause — only filter by status if provided */
  const conditions = filters.status
    ? eq(emails.status, filters.status)
    : undefined;

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

  const [email] = await db
    .select()
    .from(emails)
    .where(eq(emails.id, id));

  if (!email) {
    logger.debug("Email not found (unscoped)", { id });
  }

  return email;
}
