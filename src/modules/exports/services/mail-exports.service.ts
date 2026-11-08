import { and, isNotNull, isNull } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { emails, type EmailTags } from "../../emails/models/email.schema.ts";
import { emailTombstones } from "../../emails/models/email-tombstone.schema.ts";
import { inboundEmails } from "../../inbound/models/inbound-email.schema.ts";
import { allEmailsWhere } from "../../emails/services/email-query.service.ts";
import { allTombstonesWhere } from "../../emails/services/tombstone.service.ts";
import type { ListEmailsFilters } from "../../emails/types/email.types.ts";
import { defineExportSource, type KeysetOrder } from "./keyset.ts";
import type { ExportColumn, ExportSource, KeysetRow } from "../types/export.types.ts";

/**
 * CSV exports of the mail tables (#430): emails, emails trash,
 * tombstones, inbound, inbound trash.
 *
 * Each `SELECT` names its fields one by one, so a body (`html`,
 * `text_content`, `raw_message`), custom headers, attachments or the
 * delivery state never leave the database for an export. The column
 * lists below can only read what those selects return.
 */

/* ─── Emails and the emails trash ─── */

/** The fields an email export reads: metadata only. */
const EMAIL_FIELDS = {
  id: emails.id,
  createdAt: emails.createdAt,
  status: emails.status,
  source: emails.source,
  category: emails.category,
  apiKeyId: emails.apiKeyId,
  domainId: emails.domainId,
  fromAddress: emails.fromAddress,
  fromName: emails.fromName,
  toAddress: emails.toAddress,
  cc: emails.cc,
  bcc: emails.bcc,
  replyTo: emails.replyTo,
  subject: emails.subject,
  tags: emails.tags,
  messageId: emails.messageId,
  attempts: emails.attempts,
  lastError: emails.lastError,
  sentAt: emails.sentAt,
  firstOpenedAt: emails.firstOpenedAt,
  firstClickedAt: emails.firstClickedAt,
  deletedAt: emails.deletedAt,
};

/** One email as an export reads it. */
interface EmailExportRow extends KeysetRow {
  createdAt: Date;
  status: string;
  source: string;
  category: string | null;
  apiKeyId: string;
  domainId: string | null;
  fromAddress: string;
  fromName: string | null;
  toAddress: string;
  cc: string | null;
  bcc: string | null;
  replyTo: string | null;
  subject: string;
  tags: EmailTags | null;
  messageId: string | null;
  attempts: number;
  lastError: string | null;
  sentAt: Date | null;
  firstOpenedAt: Date | null;
  firstClickedAt: Date | null;
  deletedAt: Date | null;
}

/** Tags (#189) as `key=value; key=value`, in key order. */
function tagsCell(tags: EmailTags | null): string {
  if (!tags) return "";
  return Object.keys(tags)
    .toSorted()
    .map((key) => `${key}=${tags[key] ?? ""}`)
    .join("; ");
}

/** The columns of the emails export. */
const EMAIL_COLUMNS: readonly ExportColumn<EmailExportRow>[] = [
  { header: "id", value: (r) => r.id },
  { header: "created_at", value: (r) => r.createdAt },
  { header: "status", value: (r) => r.status },
  { header: "source", value: (r) => r.source },
  { header: "category", value: (r) => r.category },
  { header: "api_key_id", value: (r) => r.apiKeyId },
  { header: "domain_id", value: (r) => r.domainId },
  { header: "from_address", value: (r) => r.fromAddress },
  { header: "from_name", value: (r) => r.fromName },
  { header: "to_address", value: (r) => r.toAddress },
  { header: "cc", value: (r) => r.cc },
  { header: "bcc", value: (r) => r.bcc },
  { header: "reply_to", value: (r) => r.replyTo },
  { header: "subject", value: (r) => r.subject },
  { header: "tags", value: (r) => tagsCell(r.tags) },
  { header: "message_id", value: (r) => r.messageId },
  { header: "attempts", value: (r) => r.attempts },
  { header: "last_error", value: (r) => r.lastError },
  { header: "sent_at", value: (r) => r.sentAt },
  { header: "first_opened_at", value: (r) => r.firstOpenedAt },
  { header: "first_clicked_at", value: (r) => r.firstClickedAt },
];

/** The emails trash adds when each row was trashed. */
const TRASHED_EMAIL_COLUMNS: readonly ExportColumn<EmailExportRow>[] = [
  ...EMAIL_COLUMNS,
  { header: "deleted_at", value: (r) => r.deletedAt },
];

/** Newest first, like the email list. */
const EMAILS_ORDER: KeysetOrder = {
  at: emails.createdAt,
  id: emails.id,
  direction: "desc",
};

/** Most recently trashed first, like the trash page. */
const EMAILS_TRASH_ORDER: KeysetOrder = {
  at: emails.deletedAt,
  id: emails.id,
  direction: "desc",
};

/**
 * The emails export: every API key's emails (admins see all), not
 * trashed, with the email list's filters (status, source, API key, tags).
 */
export function emailsExport(
  filters: Omit<ListEmailsFilters, "page" | "limit">,
): ExportSource {
  return defineExportSource({
    table: "emails",
    order: EMAILS_ORDER,
    columns: EMAIL_COLUMNS,
    rows: (page) =>
      db
        .select({ ...EMAIL_FIELDS, cursorAt: page.cursorAt })
        .from(emails)
        .where(and(allEmailsWhere(filters), page.after))
        .orderBy(...page.orderBy)
        .limit(page.limit),
  });
}

/** The emails trash export: every trashed email, the trash page has no filter. */
export function emailsTrashExport(): ExportSource {
  return defineExportSource({
    table: "emails-trash",
    order: EMAILS_TRASH_ORDER,
    columns: TRASHED_EMAIL_COLUMNS,
    rows: (page) =>
      db
        .select({ ...EMAIL_FIELDS, cursorAt: page.cursorAt })
        .from(emails)
        .where(and(isNotNull(emails.deletedAt), page.after))
        .orderBy(...page.orderBy)
        .limit(page.limit),
  });
}

/* ─── Tombstones ─── */

/** One tombstone as an export reads it (never its attachment list). */
interface TombstoneExportRow extends KeysetRow {
  purgedAt: Date;
  apiKeyId: string;
  messageId: string | null;
  fromAddress: string;
  toAddress: string;
  subject: string | null;
  status: string;
  sentAt: Date | null;
  deletedAt: Date | null;
}

/** The columns of the tombstones export. */
const TOMBSTONE_COLUMNS: readonly ExportColumn<TombstoneExportRow>[] = [
  { header: "id", value: (r) => r.id },
  { header: "purged_at", value: (r) => r.purgedAt },
  { header: "api_key_id", value: (r) => r.apiKeyId },
  { header: "message_id", value: (r) => r.messageId },
  { header: "from_address", value: (r) => r.fromAddress },
  { header: "to_address", value: (r) => r.toAddress },
  { header: "subject", value: (r) => r.subject },
  { header: "status", value: (r) => r.status },
  { header: "sent_at", value: (r) => r.sentAt },
  { header: "deleted_at", value: (r) => r.deletedAt },
];

/** The tombstones export, with the page's optional Message-ID filter. */
export function tombstonesExport(messageId: string | undefined): ExportSource {
  return defineExportSource({
    table: "tombstones",
    order: { at: emailTombstones.purgedAt, id: emailTombstones.id, direction: "desc" },
    columns: TOMBSTONE_COLUMNS,
    rows: (page) =>
      db
        .select({
          id: emailTombstones.id,
          purgedAt: emailTombstones.purgedAt,
          apiKeyId: emailTombstones.apiKeyId,
          messageId: emailTombstones.messageId,
          fromAddress: emailTombstones.fromAddress,
          toAddress: emailTombstones.toAddress,
          subject: emailTombstones.subject,
          status: emailTombstones.status,
          sentAt: emailTombstones.sentAt,
          deletedAt: emailTombstones.deletedAt,
          cursorAt: page.cursorAt,
        })
        .from(emailTombstones)
        .where(and(allTombstonesWhere(messageId), page.after))
        .orderBy(...page.orderBy)
        .limit(page.limit),
  });
}

/* ─── Inbound and the inbound trash ─── */

/** The fields an inbound export reads: never the body or the raw message. */
const INBOUND_FIELDS = {
  id: inboundEmails.id,
  receivedAt: inboundEmails.receivedAt,
  fromAddress: inboundEmails.fromAddress,
  toAddress: inboundEmails.toAddress,
  subject: inboundEmails.subject,
  messageId: inboundEmails.messageId,
  inReplyTo: inboundEmails.inReplyTo,
  inReplyToEmailId: inboundEmails.inReplyToEmailId,
  deletedAt: inboundEmails.deletedAt,
};

/** One inbound email as an export reads it. */
interface InboundExportRow extends KeysetRow {
  receivedAt: Date;
  fromAddress: string;
  toAddress: string;
  subject: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  inReplyToEmailId: string | null;
  deletedAt: Date | null;
}

/** The columns of the inbound export. */
const INBOUND_COLUMNS: readonly ExportColumn<InboundExportRow>[] = [
  { header: "id", value: (r) => r.id },
  { header: "received_at", value: (r) => r.receivedAt },
  { header: "from_address", value: (r) => r.fromAddress },
  { header: "to_address", value: (r) => r.toAddress },
  { header: "subject", value: (r) => r.subject },
  { header: "message_id", value: (r) => r.messageId },
  { header: "in_reply_to", value: (r) => r.inReplyTo },
  { header: "in_reply_to_email_id", value: (r) => r.inReplyToEmailId },
];

/** The inbound trash adds when each row was trashed. */
const TRASHED_INBOUND_COLUMNS: readonly ExportColumn<InboundExportRow>[] = [
  ...INBOUND_COLUMNS,
  { header: "deleted_at", value: (r) => r.deletedAt },
];

/** The inbound export: every received email not trashed, newest first (no filter on the page). */
export function inboundExport(): ExportSource {
  return defineExportSource({
    table: "inbound",
    order: { at: inboundEmails.receivedAt, id: inboundEmails.id, direction: "desc" },
    columns: INBOUND_COLUMNS,
    rows: (page) =>
      db
        .select({ ...INBOUND_FIELDS, cursorAt: page.cursorAt })
        .from(inboundEmails)
        .where(and(isNull(inboundEmails.deletedAt), page.after))
        .orderBy(...page.orderBy)
        .limit(page.limit),
  });
}

/** The inbound trash export: every trashed inbound email, most recently trashed first. */
export function inboundTrashExport(): ExportSource {
  return defineExportSource({
    table: "inbound-trash",
    order: { at: inboundEmails.deletedAt, id: inboundEmails.id, direction: "desc" },
    columns: TRASHED_INBOUND_COLUMNS,
    rows: (page) =>
      db
        .select({ ...INBOUND_FIELDS, cursorAt: page.cursorAt })
        .from(inboundEmails)
        .where(and(isNotNull(inboundEmails.deletedAt), page.after))
        .orderBy(...page.orderBy)
        .limit(page.limit),
  });
}
