import {
  boolean,
  date,
  integer,
  pgTable,
  primaryKey,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * TLS report deliveries per UTC day (#345), every replica together: the
 * counter behind `TLSRPT_MAX_REPORTS_PER_DAY`. A delivery to one reporting
 * address (mail or HTTPS) takes one slot before it is attempted, in one
 * atomic upsert that refuses past the cap, so replicas share one budget.
 * One row per day; rows older than the report retention are deleted.
 */
export const tlsRptDailySends = pgTable("tlsrpt_daily_sends", {
  /** The UTC day. */
  day: date("day").primaryKey(),

  /** Deliveries attempted that day (a skipped mail delivery gives its slot back). */
  sent: integer("sent").notNull().default(0),

  /** The day's "cap reached" warning was logged (by one replica, once). */
  capWarned: boolean("cap_warned").notNull().default(false),

  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * TLS reports per destination and UTC day (#345), every replica together:
 * the counter behind `TLSRPT_MAX_REPORTS_PER_DESTINATION_PER_DAY`. The
 * destination (a mail address, lower-cased, or an HTTPS origin) is stored
 * as a short SHA-256, never in clear: it comes from a third party's DNS and
 * may be a person's mailbox. Rows past the report retention are deleted.
 */
export const tlsRptDestinationSends = pgTable(
  "tlsrpt_destination_sends",
  {
    /** The UTC day. */
    day: date("day").notNull(),

    /** SHA-256 of the destination, 32 hex characters. */
    destinationHash: varchar("destination_hash", { length: 32 }).notNull(),

    /** Deliveries attempted to it that day. */
    sent: integer("sent").notNull().default(0),

    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.day, table.destinationHash] })],
);
