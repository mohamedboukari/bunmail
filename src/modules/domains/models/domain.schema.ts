import { pgTable, varchar, boolean, timestamp, text } from "drizzle-orm/pg-core";

/**
 * Domains table — tracks sender domains and their email authentication status.
 *
 * Each domain can have DKIM keys generated for it. The user must add DNS records
 * (SPF, DKIM TXT, DMARC) and then trigger verification. Emails sent from a
 * verified domain get signed with DKIM for better deliverability.
 */
export const domains = pgTable("domains", {
  /** Unique identifier, prefixed with `dom_` (e.g. dom_a1b2c3...) */
  id: varchar("id", { length: 36 }).primaryKey(),

  /** The domain name (e.g. "example.com") — must be unique */
  name: varchar("name", { length: 255 }).notNull().unique(),

  /** RSA 2048-bit private key for DKIM signing (PEM format, stored in DB) */
  dkimPrivateKey: text("dkim_private_key"),

  /** Corresponding public key — provided to the user for DNS TXT record setup */
  dkimPublicKey: text("dkim_public_key"),

  /** DKIM selector (subdomain prefix for the TXT record, default "bunmail") */
  dkimSelector: varchar("dkim_selector", { length: 63 }).notNull().default("bunmail"),

  /** Whether the SPF DNS record has been verified for this domain */
  spfVerified: boolean("spf_verified").notNull().default(false),

  /** Whether the DKIM DNS record has been verified for this domain */
  dkimVerified: boolean("dkim_verified").notNull().default(false),

  /** Whether the DMARC DNS record has been verified for this domain */
  dmarcVerified: boolean("dmarc_verified").notNull().default(false),

  /** When DNS verification last succeeded (null if never verified) */
  verifiedAt: timestamp("verified_at"),

  /**
   * Mailbox that receives `List-Unsubscribe` mailto requests for messages
   * sent from this domain. When null the mailer defaults to
   * `unsubscribe@<domain>` so a `List-Unsubscribe` header is always
   * emitted (Gmail/Yahoo Feb-2024 sender requirements). Operators
   * override this when they don't operate the default mailbox.
   */
  unsubscribeEmail: varchar("unsubscribe_email", { length: 255 }),

  /**
   * One-click HTTPS unsubscribe endpoint per RFC 8058. When set, the
   * mailer emits `List-Unsubscribe: <mailto:...>, <https://...>` plus
   * `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, which Gmail
   * requires for high-volume bulk senders. Leave null for transactional
   * mail — the mailto-only form is enough.
   */
  unsubscribeUrl: text("unsubscribe_url"),

  /** When this domain was added */
  createdAt: timestamp("created_at").notNull().defaultNow(),

  /** Last modification timestamp */
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
