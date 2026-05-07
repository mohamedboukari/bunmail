import {
  pgTable,
  varchar,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { apiKeys } from "../../api-keys/models/api-key.schema.ts";
import { emails } from "../../emails/models/email.schema.ts";

/**
 * Suppression list — addresses we refuse to send to. Checked at the
 * `createEmail` gate before queuing; sends to suppressed recipients
 * are rejected with 422 and never reach the queue or the SMTP path.
 *
 * Scope: per `api_key_id`. Different API keys often represent different
 * customer environments (transactional / marketing / dev), so one key's
 * bounces should never gate another key's sends. Mirrors what
 * SES / SendGrid / Resend do.
 *
 * Auto-suppression on bounces is the responsibility of #24 (DSN
 * parsing); this module only provides the storage + lookup primitive
 * and a public `addFromBounce()` service method that the future bounce
 * handler will call.
 */
export const suppressions = pgTable(
  "suppressions",
  {
    /** Unique identifier, prefixed with `sup_` (e.g. sup_a1b2c3...) */
    id: varchar("id", { length: 36 }).primaryKey(),

    /**
     * Owning API key. Suppressions are per-tenant — see file header.
     * `ON DELETE CASCADE` so revoked keys also drop their suppression
     * lists; an inactive key shouldn't keep a suppression alive that
     * a different key has to step around.
     */
    apiKeyId: varchar("api_key_id", { length: 36 })
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),

    /** Recipient address that should never be sent to under this key. */
    email: varchar("email", { length: 255 }).notNull(),

    /**
     * Why the address is suppressed. Lower-cased free text for forward
     * compatibility — using a Postgres enum would force a migration on
     * every new reason. Validated to one of the known values via the
     * DTO at the API boundary; the DB stays open.
     *
     * Known values today: `bounce`, `complaint`, `manual`, `unsubscribe`.
     */
    reason: text("reason").notNull(),

    /**
     * For `reason = 'bounce'`, what kind. `hard` = permanent (mailbox
     * doesn't exist, domain doesn't exist), `soft` = transient (mailbox
     * full, recipient over quota). Null for non-bounce reasons.
     *
     * Populated by #24 (DSN parsing) when it lands.
     */
    bounceType: varchar("bounce_type", { length: 20 }),

    /**
     * Optional SMTP enhanced status code from the bounce DSN, e.g.
     * "5.1.1" (no such user) or "4.2.2" (mailbox full). Useful for
     * operators triaging deliverability without re-parsing the bounce.
     */
    diagnosticCode: text("diagnostic_code"),

    /**
     * The email row that triggered this suppression (the bounce came
     * back for this `msg_...` send). `ON DELETE SET NULL` so trash
     * purges don't break suppressions that should outlive them.
     * Null for manually-added entries.
     */
    sourceEmailId: varchar("source_email_id", { length: 36 }).references(
      () => emails.id,
      {
        onDelete: "set null",
      },
    ),

    /**
     * Optional expiry. Null = permanent (the default for hard bounces
     * and manual additions). Set for soft-bounce backoff entries that
     * should auto-expire after some retention window.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * One suppression per (api_key, email) — re-suppressing an address
     * upserts the existing row rather than piling up duplicates. The
     * service layer relies on this constraint for `ON CONFLICT DO UPDATE`.
     */
    uniqueIndex("suppressions_api_key_email_unique").on(table.apiKeyId, table.email),

    /**
     * Hot path — the `createEmail` gate runs `WHERE api_key_id = $1
     * AND email = $2` on every send. The unique index above also serves
     * this query, but Postgres composite uniques use a btree under the
     * hood so this is effectively the same shape; the explicit index is
     * documentation of intent.
     */
    index("suppressions_api_key_email_idx").on(table.apiKeyId, table.email),
  ],
);
