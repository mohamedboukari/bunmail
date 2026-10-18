import { index, pgTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { users } from "./user.schema.ts";

/**
 * Browsers an account has signed in from (#282), for the new-device
 * sign-in alert.
 *
 * A browser is recognized by the `bm_device` cookie: a long-lived random
 * value set at every password sign-in. It is not a credential (it opens
 * nothing); it only answers "has this browser signed in to this account
 * before". Only its SHA-256 is stored, like session tokens, and one
 * cookie value gives one row per account that signed in with it.
 *
 * Rows go with the account (`ON DELETE CASCADE`) and are deleted by the
 * purge worker once not seen for 400 days (`DEVICE_RETENTION_DAYS`).
 */
export const userDevices = pgTable(
  "user_devices",
  {
    /** Unique identifier, prefixed with `udv_` */
    id: varchar("id", { length: 36 }).primaryKey(),

    /** The account that signed in from this browser. */
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    /** SHA-256 (hex) of the `bm_device` cookie value; the value itself is never stored. */
    deviceHash: varchar("device_hash", { length: 64 }).notNull(),

    /** The device label at the last sign-in ("Chrome on macOS"), from fixed strings only. */
    userAgent: varchar("user_agent", { length: 64 }),

    /** Client address at the last sign-in: a valid IPv4/IPv6 literal, or null. */
    ip: varchar("ip", { length: 45 }),

    /** Approximate location of `ip` (#281), when GeoIP is configured and answered in time. */
    location: varchar("location", { length: 128 }),

    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    /** Moved forward at every sign-in from this browser; drives the 30-day rule and retention. */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** One row per account and browser; the sign-in upsert targets it. */
    uniqueIndex("user_devices_user_id_device_hash_idx").on(
      table.userId,
      table.deviceHash,
    ),

    /** "Has this account any device" and the cascade from `users`. */
    index("user_devices_user_id_idx").on(table.userId),

    /** The retention sweep. */
    index("user_devices_last_seen_at_idx").on(table.lastSeenAt),
  ],
);
