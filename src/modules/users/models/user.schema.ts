import { sql } from "drizzle-orm";
import { check, pgTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { USER_ROLES, literals } from "../types/user.types.ts";

/**
 * Dashboard user accounts (#214): the identity only. Credentials live in
 * `user_credentials`, so a user can hold a password now and a TOTP secret,
 * passkeys or OAuth links later without touching this table.
 *
 * Roles: exactly one `owner`, enforced by the partial unique index below,
 * plus admins and members (permission matrix in #218). The owner is
 * bootstrapped from `BUNMAIL_OWNER_EMAIL` (#215); everyone else arrives by
 * invitation only (#217).
 */
export const users = pgTable(
  "users",
  {
    /** Unique identifier, prefixed with `usr_` */
    id: varchar("id", { length: 36 }).primaryKey(),

    /** Login identity. Stored lower-cased (enforced below) and unique. */
    email: varchar("email", { length: 255 }).notNull().unique(),

    /**
     * When the address was confirmed: set by invite acceptance (#217) and
     * future email verification. Owner setup (#215) leaves it null: its
     * link arrives through server logs, which does not prove control of
     * the mailbox.
     */
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),

    /** Display name, set by the user. */
    name: varchar("name", { length: 100 }),

    /** `owner` | `admin` | `member`; see `USER_ROLES`. */
    role: varchar("role", { length: 10 }).notNull().default("member"),

    /** Set when the account is deactivated: no login, sessions revoked. */
    disabledAt: timestamp("disabled_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** Exactly one owner: every owner row has the same `role` value, so a
     *  unique index on it restricted to owners allows at most one. */
    uniqueIndex("users_single_owner")
      .on(table.role)
      .where(sql`role = 'owner'`),

    check("users_role_check", sql`${table.role} IN (${literals(USER_ROLES)})`),

    /** Lower-cased so uniqueness is case-insensitive without a functional index. */
    check("users_email_lowercase_check", sql`${table.email} = lower(${table.email})`),
  ],
);
