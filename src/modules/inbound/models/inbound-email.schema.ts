import { pgTable, varchar, text, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Inbound emails table — stores emails received by the SMTP server.
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

    /** When this email was received */
    receivedAt: timestamp("received_at").notNull().defaultNow(),
  },
  (table) => [index("idx_inbound_received_at").on(table.receivedAt)],
);
