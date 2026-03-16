import { eq, desc, and, sql } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { emails } from "../models/email.schema.ts";
import { domains } from "../../domains/models/domain.schema.ts";
import { templates } from "../../templates/models/template.schema.ts";
import { renderTemplate } from "../../templates/services/template.service.ts";
import { generateId } from "../../../utils/id.ts";
import { logger } from "../../../utils/logger.ts";
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

  logger.info("Creating email", { id, from: input.from, to: input.to, apiKeyId });

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
  filters: ListEmailsFilters,
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
  filters: ListEmailsFilters,
): Promise<{ data: Email[]; total: number }> {
  const offset = (filters.page - 1) * filters.limit;

  logger.debug("Listing all emails (unscoped)", { ...filters, offset });

  /** Build WHERE clause — only filter by status if provided */
  const conditions = filters.status ? eq(emails.status, filters.status) : undefined;

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

  const [email] = await db.select().from(emails).where(eq(emails.id, id));

  if (!email) {
    logger.debug("Email not found (unscoped)", { id });
  }

  return email;
}
