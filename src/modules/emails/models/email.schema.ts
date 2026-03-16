import { pgTable, varchar, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { apiKeys } from "../../api-keys/models/api-key.schema.ts";
import { domains } from "../../domains/models/domain.schema.ts";

/**
 * Emails table — every email sent through BunMail gets a row here.
 *
 * Lifecycle: an email is inserted with status `queued`, picked up by the
 * queue processor which sets it to `sending`, and finally marked `sent`
 * or `failed` (after 3 retry attempts).
 *
 * Status flow: queued → sending → sent | failed
 *              sending → queued (on transient failure, retry)
 */
export const emails = pgTable(
  "emails",
  {
    /** Unique identifier, prefixed with `msg_` (e.g. msg_a1b2c3...) */
    id: varchar("id", { length: 36 }).primaryKey(),

    /** Which API key was used to send this email — FK to api_keys */
    apiKeyId: varchar("api_key_id", { length: 36 })
      .notNull()
      .references(() => apiKeys.id),

    /** Optional sender domain — FK to domains. Used for DKIM signing lookup */
    domainId: varchar("domain_id", { length: 36 }).references(() => domains.id),

    /** Sender email address (e.g. "hello@example.com") */
    fromAddress: varchar("from_address", { length: 255 }).notNull(),

    /** Recipient email address */
    toAddress: varchar("to_address", { length: 255 }).notNull(),

    /** Carbon copy recipients (comma-separated, nullable) */
    cc: text("cc"),

    /** Blind carbon copy recipients (comma-separated, nullable) */
    bcc: text("bcc"),

    /** Email subject line */
    subject: varchar("subject", { length: 500 }).notNull(),

    /** HTML body of the email (nullable — at least one of html/text required) */
    html: text("html"),

    /** Plain text body of the email (nullable — fallback for non-HTML clients) */
    textContent: text("text_content"),

    /**
     * Current delivery status:
     * - queued: waiting to be picked up by the queue processor
     * - sending: currently being sent via SMTP
     * - sent: successfully delivered to recipient's MX server
     * - failed: all retry attempts exhausted
     */
    status: varchar("status", { length: 20 }).notNull().default("queued"),

    /** Number of send attempts so far (max 3 before marking as failed) */
    attempts: integer("attempts").notNull().default(0),

    /** Last SMTP error message (stored on failure for debugging) */
    lastError: text("last_error"),

    /** SMTP Message-ID header returned by the recipient's mail server */
    messageId: varchar("message_id", { length: 255 }),

    /** When the email was successfully sent (null if still queued/failed) */
    sentAt: timestamp("sent_at"),

    /** When this email was first queued */
    createdAt: timestamp("created_at").notNull().defaultNow(),

    /** Last status change timestamp */
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    /** Composite index — the queue processor queries by status + created_at */
    index("idx_emails_status_created").on(table.status, table.createdAt),

    /** Index for filtering emails by API key (list emails endpoint) */
    index("idx_emails_api_key_id").on(table.apiKeyId),
  ],
);
