import { pgTable, varchar, text, timestamp, index } from "drizzle-orm/pg-core";
import { emails } from "../../emails/models/email.schema.ts";

/**
 * Inbound emails table: stores emails received by the SMTP server.
 *
 * When BunMail's built-in SMTP server receives a message, it parses it
 * with `mailparser` and inserts a row here. Registered webhooks are then
 * notified with the `email.received` event.
 */
export const inboundEmails = pgTable(
  "inbound_emails",
  {
    /** Unique identifier, prefixed with `inb_` */
    id: varchar("id", { length: 36 }).primaryKey(),

    /** Envelope sender (MAIL FROM) */
    fromAddress: varchar("from_address", { length: 255 }).notNull(),

    /** Envelope recipient (RCPT TO) */
    toAddress: varchar("to_address", { length: 255 }).notNull(),

    /** Parsed subject line */
    subject: varchar("subject", { length: 500 }),

    /** Parsed HTML body */
    html: text("html"),

    /** Parsed plain-text body */
    textContent: text("text_content"),

    /** Raw RFC 822 message source (for debugging / reprocessing) */
    rawMessage: text("raw_message"),

    /*
     * Threading identifiers (#192), read from the message's own headers at
     * receipt. Attacker-controlled, so only syntactically valid msg-ids are
     * kept (`<left@right>`, printable ASCII, at most 250 characters each),
     * deduplicated, in order, space-separated: see
     * `services/threading.ts`. Null when the header is missing or holds no
     * valid id, and on rows received before the columns existed (a reply
     * then recovers them once from `raw_message`).
     */

    /** The message's `Message-ID`, brackets included. */
    messageId: text("message_id"),

    /** The ids in its `In-Reply-To` (at most 20). */
    inReplyTo: text("in_reply_to"),

    /** The ids in its `References`, at most 20 (the first one is kept). */
    references: text("references"),

    /**
     * The email BunMail sent that this message replies to (#192): matched by
     * `In-Reply-To` / `References` against `emails.message_id`, only when
     * that email's sender domain is one of the domains this message was
     * received for. `SET NULL` when the email is deleted.
     */
    inReplyToEmailId: varchar("in_reply_to_email_id", { length: 36 }).references(
      () => emails.id,
      { onDelete: "set null" },
    ),

    /** When this email was received */
    receivedAt: timestamp("received_at").notNull().defaultNow(),

    /**
     * Soft-delete marker, when set, the inbound email is in "trash".
     * The trash purge service permanently removes rows where
     * `deleted_at < NOW() - TRASH_RETENTION_DAYS`.
     */
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    index("idx_inbound_received_at").on(table.receivedAt),
    /** Index for trash list and purge queries */
    index("idx_inbound_deleted_at").on(table.deletedAt),
    /** FK lookups when an email is deleted (`SET NULL`). */
    index("idx_inbound_in_reply_to_email_id").on(table.inReplyToEmailId),
  ],
);
