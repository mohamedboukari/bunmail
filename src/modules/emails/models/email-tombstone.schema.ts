import { pgTable, varchar, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Post-purge audit trail for hard-deleted emails (#34).
 *
 * The trash purge service (and per-row / bulk-empty hard-delete paths)
 * used to `DELETE FROM emails` and lose the row forever. When a
 * complaint, late bounce, or compliance audit arrived weeks later
 * referring to a Message-ID, operators had no way to answer "did we
 * send this?" — the row was gone.
 *
 * Tombstones are a forensic-only snapshot taken **immediately before**
 * each hard-delete. They preserve identifiers (id, message_id, to,
 * subject, status) but **deliberately drop body content** — that's
 * exactly what we're trying not to retain past the trash retention
 * window. A tombstone is enough to confirm "yes we sent msg_abc to X
 * on Y date with subject Z and it was bounced" without keeping the
 * sensitive payload.
 *
 * Snapshot semantics — NO foreign keys:
 *
 *   - `apiKeyId` is a denormalised snapshot, not a FK. If the api key
 *     is later revoked + cascade-deleted, the tombstone must SURVIVE
 *     the cascade (the whole point is post-deletion forensics).
 *   - Same for `domainId` (which we don't bother keeping; the from
 *     address is sufficient).
 *
 * Retention: kept for `TOMBSTONE_RETENTION_DAYS` days (default 90),
 * then the trash purge loop sweeps them out. `failed` / `bounced`
 * tombstones are kept on the same schedule as `sent` ones — the
 * forensic value is the same.
 *
 * Tombstones use the **original** email id (`msg_…`) — that's how
 * operators look them up. There is no separate `tomb_` prefix.
 */
export const emailTombstones = pgTable(
  "email_tombstones",
  {
    /** The original email's id, verbatim (`msg_…`). Tombstones live
     *  in their own table so this primary key doesn't collide with
     *  the still-live emails table. */
    id: varchar("id", { length: 36 }).primaryKey(),

    /** Snapshot of the api key that owned the email — used for the
     *  per-tenant read API. NOT a FK; snapshot survives api key delete. */
    apiKeyId: varchar("api_key_id", { length: 36 }).notNull(),

    /** SMTP Message-ID returned by the recipient's mail server. The
     *  primary lookup key for "this complaint references <abc@x>; did
     *  we send it?". Indexed for that hot path. Nullable because the
     *  email might have been hard-deleted before it ever sent. */
    messageId: varchar("message_id", { length: 255 }),

    fromAddress: varchar("from_address", { length: 255 }).notNull(),
    toAddress: varchar("to_address", { length: 255 }).notNull(),

    /** Subject line — null when the original was somehow null at delete
     *  time, otherwise the human-readable handle for "I'm looking for
     *  the welcome email I sent on Tuesday". */
    subject: varchar("subject", { length: 500 }),

    /** Final status at the moment of hard-delete (sent / bounced /
     *  failed / queued). Useful for filtering "show me only failed
     *  deliveries we purged". */
    status: varchar("status", { length: 20 }).notNull(),

    /** When the original email was sent (or null if it never sent). */
    sentAt: timestamp("sent_at", { withTimezone: true }),

    /** When the original was soft-deleted to trash (or null if it was
     *  hard-deleted directly without going through trash first). */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),

    /** When this tombstone was created — i.e. when the original was
     *  hard-deleted. The `TOMBSTONE_RETENTION_DAYS` retention window
     *  starts from this timestamp. */
    purgedAt: timestamp("purged_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** Bounce / complaint trace hot path — operators paste a
     *  `Message-ID` from an inbound DSN or FBL report and need an
     *  immediate answer. */
    index("idx_email_tombstones_message_id").on(table.messageId),

    /** Dashboard list hot path — "show me the last week of tombstones
     *  for this api key", newest first. */
    index("idx_email_tombstones_api_key_purged").on(table.apiKeyId, table.purgedAt),
  ],
);

export type EmailTombstone = typeof emailTombstones.$inferSelect;
export type NewEmailTombstone = typeof emailTombstones.$inferInsert;
