import {
  pgTable,
  varchar,
  integer,
  date,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { apiKeys } from "../../api-keys/models/api-key.schema.ts";

/**
 * Per-(API key, UTC day) submission usage counters (#123).
 *
 * Powers two features of the SMTP submission server (#120):
 * 1. **Per-key daily quota** — `getAcceptedToday` reads today's `accepted`
 *    count and the submission path rejects once it reaches the configured
 *    `SMTP_SUBMISSION_DAILY_QUOTA`.
 * 2. **Stats endpoint** — `GET /api/v1/smtp-submission/stats` aggregates
 *    these rows for the calling key.
 *
 * One row per key per day keeps the table tiny (no per-message event log)
 * and makes both the quota read and the stats query index-friendly.
 * Auth *failures* are deliberately NOT recorded here — a failed AUTH has
 * no known API key to attribute to, and is already throttled per-IP.
 */
export const smtpSubmissionUsage = pgTable(
  "smtp_submission_usage",
  {
    /** Surrogate id, prefixed `smu_` (e.g. smu_a1b2c3...). */
    id: varchar("id", { length: 36 }).primaryKey(),

    /**
     * Owning API key. `ON DELETE CASCADE` — usage rows are meaningless
     * once the key is gone (mirrors the suppressions table).
     */
    apiKeyId: varchar("api_key_id", { length: 36 })
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),

    /** UTC day bucket (YYYY-MM-DD). The quota window is a UTC calendar day. */
    day: date("day").notNull(),

    /** Messages accepted (queued) for this key on this day. */
    accepted: integer("accepted").notNull().default(0),

    /**
     * Messages rejected *after* authentication for this key on this day
     * (quota exceeded, suppressed recipient, unregistered sender domain,
     * parse/validation failure). Pre-auth failures are not counted here.
     */
    rejected: integer("rejected").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * One row per (key, day). The usage service relies on this for
     * `ON CONFLICT (api_key_id, day) DO UPDATE` upserts, and it doubles
     * as the index for the quota read and the stats range scan.
     */
    uniqueIndex("smtp_submission_usage_key_day_unique").on(table.apiKeyId, table.day),
  ],
);
