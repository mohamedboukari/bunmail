import {
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * One SMTP TLS report to send (RFC 8460, #345): a recipient domain that
 * publishes a `_smtp._tls` record, and one UTC day of BunMail's sessions to
 * it. Its counters are `tlsrpt_results` rows (deleted with it).
 *
 * The row is created by the first session of the day to that domain, and
 * holds the report's send state: when it is due (after the day ends, with
 * jitter), how many attempts were made, and which reporting addresses
 * already got it. It is deleted once every address got the report, after
 * the last attempt, or past the retention period. Never message content,
 * never a recipient address.
 */
export const tlsRptReports = pgTable(
  "tlsrpt_reports",
  {
    /** Surrogate id, prefixed `trp_`. */
    id: varchar("id", { length: 36 }).primaryKey(),

    /** The UTC day the report covers. */
    day: date("day").notNull(),

    /** The recipient domain (`policy-domain`), lower-case, without a trailing dot. */
    policyDomain: varchar("policy_domain", { length: 253 }).notNull(),

    /** The report's `report-id` (a UUID), the same on every attempt and every address. */
    rfcReportId: varchar("rfc_report_id", { length: 64 }).notNull(),

    /**
     * When the job may next pick the report up: after the day ends plus a
     * jittered delay at first, then the retry backoff; pushed forward by a
     * lease while a replica sends it.
     */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull(),

    /** Send attempts started (counted when claimed, so a crash still counts). */
    attempts: integer("attempts").notNull().default(0),

    /**
     * The reporting addresses that already got the report, as short
     * SHA-256 hashes of their URI joined by `\n`: a retry goes only to the
     * others. Hashes, so no reporting URL (which may carry a token) is
     * stored.
     */
    deliveredRua: text("delivered_rua").notNull().default(""),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** One report per domain and day: the recording upsert's conflict target. */
    uniqueIndex("tlsrpt_reports_day_domain_unique").on(table.day, table.policyDomain),
    /** The job's due scan. */
    index("tlsrpt_reports_next_attempt_at_idx").on(table.nextAttemptAt),
  ],
);
