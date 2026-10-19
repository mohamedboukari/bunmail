import { pgTable, varchar, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { bytea } from "../../../db/bytea.ts";
import { emails } from "./email.schema.ts";

/**
 * Attachments of an outbound email (#181), one row per file, in the
 * order the send listed them.
 *
 * The bytes (`content`) live here and nowhere else: never in `emails`,
 * the idempotency snapshot or a tombstone. They are kept only while the
 * email can still be sent: the outcome transaction that moves the email
 * to `sent`, `failed` or `bounced` sets `content` to `NULL` and keeps the
 * metadata, and deleting the email removes the rows (`ON DELETE
 * CASCADE`). Every read that is not the mailer's send or the dashboard's
 * download selects the metadata columns only, so a list, a detail or the
 * queue claim never loads a file. Accessed through
 * `services/attachment-storage.ts`.
 */
export const emailAttachments = pgTable(
  "email_attachments",
  {
    /** Unique identifier, prefixed with `att_`. */
    id: varchar("id", { length: 36 }).primaryKey(),

    /** The email the file belongs to; its rows go with it. */
    emailId: varchar("email_id", { length: 36 })
      .notNull()
      .references(() => emails.id, { onDelete: "cascade" }),

    /** 0-based index in the send's `attachments` list. */
    position: integer("position").notNull(),

    /** Filename as checked by `services/attachments.ts` (trimmed, 1 to 255 characters). */
    filename: varchar("filename", { length: 255 }).notNull(),

    /** Content-Type the file is sent with: derived from the bytes, never the declared one. */
    contentType: varchar("content_type", { length: 255 }).notNull(),

    /** Decoded size in bytes. */
    sizeBytes: integer("size_bytes").notNull(),

    /** Content-ID for inline `cid:` references, without brackets; null for a plain attachment. */
    contentId: varchar("content_id", { length: 128 }),

    /** Hex SHA-256 of the content, for dedup and debugging; not a security control. */
    sha256: varchar("sha256", { length: 64 }).notNull(),

    /** The raw bytes (not base64); `NULL` once the email reached a final state. */
    content: bytea("content"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    /**
     * One row per position of an email. Also the `email_id` index: every
     * read is by email (and position), and the FK cascade looks rows up
     * by it.
     */
    uniqueIndex("uq_email_attachments_email_position").on(table.emailId, table.position),
  ],
);
