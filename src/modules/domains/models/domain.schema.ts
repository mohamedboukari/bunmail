import { index, pgTable, varchar, boolean, timestamp, text } from "drizzle-orm/pg-core";
import { users } from "../../users/models/user.schema.ts";

/**
 * Domains table: tracks sender domains and their email authentication status.
 *
 * Each domain can have DKIM keys generated for it. The user must add DNS records
 * (SPF, DKIM TXT, DMARC) and then trigger verification. Emails sent from a
 * verified domain get signed with DKIM for better deliverability.
 */
export const domains = pgTable(
  "domains",
  {
    /** Unique identifier, prefixed with `dom_` (e.g. dom_a1b2c3...) */
    id: varchar("id", { length: 36 }).primaryKey(),

    /** The domain name (e.g. "example.com"), must be unique */
    name: varchar("name", { length: 255 }).notNull().unique(),

    /** RSA 2048-bit private key for DKIM signing (PEM format, stored in DB) */
    dkimPrivateKey: text("dkim_private_key"),

    /** Corresponding public key: provided to the user for DNS TXT record setup */
    dkimPublicKey: text("dkim_public_key"),

    /**
     * DKIM selector of the active key (subdomain prefix for the TXT record):
     * "bunmail" by default, or a DNS label chosen on create (#250). A
     * completed rotation replaces it with the rotation's dated selector.
     */
    dkimSelector: varchar("dkim_selector", { length: 63 }).notNull().default("bunmail"),

    /**
     * Key rotation in progress (#250): the selector, encrypted private key
     * and public key of the next DKIM key, and when the rotation started.
     * All null when no rotation is pending. Mail is never signed with the
     * pending key: completing the rotation (once its TXT record is
     * published) moves it into the active columns above.
     */
    dkimPendingSelector: varchar("dkim_pending_selector", { length: 63 }),

    /** Pending private key (PEM), AES-256-GCM encrypted like `dkimPrivateKey`. */
    dkimPendingPrivateKey: text("dkim_pending_private_key"),

    /** Pending public key (PEM), the value of the pending TXT record. */
    dkimPendingPublicKey: text("dkim_pending_public_key"),

    /** When the pending rotation started. */
    dkimPendingCreatedAt: timestamp("dkim_pending_created_at"),

    /**
     * The selector (and public key) that was active before the last
     * completed rotation (#250). Informational only: BunMail never signs
     * with it (its private key is dropped), it tells the operator which
     * TXT record to keep published for a while, then remove.
     */
    dkimPreviousSelector: varchar("dkim_previous_selector", { length: 63 }),

    /** Public key (PEM) of the previous selector. */
    dkimPreviousPublicKey: text("dkim_previous_public_key"),

    /** When the last rotation switched to the current key. */
    dkimRotatedAt: timestamp("dkim_rotated_at"),

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
     * mail: the mailto-only form is enough.
     */
    unsubscribeUrl: text("unsubscribe_url"),

    /**
     * Address notified when inbound mail is received for this domain (#106).
     * When set, every message accepted by the SMTP receiver for a recipient
     * on this domain triggers a "you have new mail" summary email, sent from
     * `<INBOUND_NOTIFY_FROM_LOCAL>@<name>` and DKIM-signed with this domain's
     * own key. Null disables inbound notifications for the domain (the
     * default). Point this at an EXTERNAL mailbox: an address on a domain
     * BunMail itself receives for would loop (and is skipped by the
     * sender-domain loop guard).
     */
    notifyEmail: varchar("notify_email", { length: 255 }),

    /** When this domain was added */
    createdAt: timestamp("created_at").notNull().defaultNow(),

    /** Last modification timestamp */
    updatedAt: timestamp("updated_at").notNull().defaultNow(),

    /**
     * The dashboard user who created it (#219), or, through the REST API,
     * the creator of the calling key. Null means the owner (legacy rows are
     * assigned to the owner at boot; a removed user's rows become null).
     */
    createdByUserId: varchar("created_by_user_id", { length: 36 }).references(
      () => users.id,
      { onDelete: "set null" },
    ),
  },
  (table) => [
    /** Ownership transfer and the boot backfill update by creator. */
    index("domains_created_by_user_id_idx").on(table.createdByUserId),
  ],
);
