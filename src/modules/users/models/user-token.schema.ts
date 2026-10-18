import { sql } from "drizzle-orm";
import { check, index, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";
import { users } from "./user.schema.ts";
import {
  INVITE_ROLES,
  TOKEN_PURPOSES,
  USER_ROLES,
  literals,
} from "../types/user.types.ts";

/**
 * One-time tokens (#214): the owner setup link (#215), invitations (#217)
 * and password resets. Later purposes (email verification, magic links)
 * add a value to `TOKEN_PURPOSES` and nothing else.
 *
 * Only the SHA-256 hash of the token is stored. A token is spent by
 * setting `used_at`, withdrawn by setting `revoked_at`, and dead once
 * `expires_at` has passed.
 *
 * Invitations target an email address that has no user yet, so `user_id`
 * is nullable; the check below requires one of the two.
 */
export const userTokens = pgTable(
  "user_tokens",
  {
    /** Unique identifier, prefixed with `utk_` */
    id: varchar("id", { length: 36 }).primaryKey(),

    /** The user the token acts for (setup, reset). Deleting the user voids it. */
    userId: varchar("user_id", { length: 36 }).references(() => users.id, {
      onDelete: "cascade",
    }),

    /** The invited address (invites), lower-cased. */
    email: varchar("email", { length: 255 }),

    /** `owner_setup` | `invite` | `password_reset`; see `TOKEN_PURPOSES`. */
    purpose: varchar("purpose", { length: 20 }).notNull(),

    /** SHA-256 (hex) of the token in the link; the token itself is never stored. */
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),

    /** Role an invitation grants on acceptance. */
    role: varchar("role", { length: 10 }),

    /** Who sent an invitation, or who issued a password reset link (#277):
     *  for `password_reset` it means "issued by". Set to null if that user
     *  is deleted, so history survives (a reset link then stops working). */
    invitedBy: varchar("invited_by", { length: 36 }).references(() => users.id, {
      onDelete: "set null",
    }),

    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** Re-inviting an address replaces its pending invitation. */
    index("user_tokens_email_purpose_idx").on(table.email, table.purpose),

    check(
      "user_tokens_purpose_check",
      sql`${table.purpose} IN (${literals(TOKEN_PURPOSES)})`,
    ),

    check(
      "user_tokens_role_check",
      sql`${table.role} IS NULL OR ${table.role} IN (${literals(USER_ROLES)})`,
    ),

    /** A token acts for a user or targets an address; never neither. */
    check(
      "user_tokens_target_check",
      sql`${table.userId} IS NOT NULL OR ${table.email} IS NOT NULL`,
    ),

    check(
      "user_tokens_email_lowercase_check",
      sql`${table.email} IS NULL OR ${table.email} = lower(${table.email})`,
    ),

    /**
     * An invitation (#217) names the invited address and grants `admin`
     * or `member`, never `owner`: a bug or a hand-written row cannot mint
     * an ownership link. `role IS NOT NULL` is spelled out: a NULL role
     * makes `IN (...)` NULL, and a CHECK that evaluates to NULL passes.
     */
    check(
      "user_tokens_invite_check",
      sql`${table.purpose} <> 'invite' OR (${table.email} IS NOT NULL AND ${table.role} IS NOT NULL AND ${table.role} IN (${literals(INVITE_ROLES)}))`,
    ),
  ],
);
