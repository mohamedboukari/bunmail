import { sql } from "drizzle-orm";
import { check, index, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";
import { users } from "./user.schema.ts";
import { userCredentials } from "./user-credential.schema.ts";
import { CREDENTIAL_TYPES, SESSION_ASSURANCES, literals } from "../types/user.types.ts";

/**
 * Dashboard sessions (#214), replacing the stateless HMAC cookie (#216).
 * The cookie carries an opaque random token; only its SHA-256 hash is
 * stored, so a database leak does not yield usable sessions. Logout,
 * password change and deactivation delete rows, which revokes them for
 * real; so does replacing the credential a session was opened with
 * (`credential_id`, #277). Rows live in Postgres, so they work across replicas (#185).
 *
 * The token rotates (#216): at most once a minute an active session gets
 * a fresh token, the old hash moves to `previous_token_hash` and stays
 * accepted for a short grace period (racing requests of the same
 * browser). Presenting the previous token after the grace period means
 * two parties hold the session, so every session of the user is revoked.
 * Older generations live in `session_token_history`, so they are caught
 * too, however old.
 */
export const sessions = pgTable(
  "sessions",
  {
    /** Unique identifier, prefixed with `ses_` */
    id: varchar("id", { length: 36 }).primaryKey(),

    /** Owning user. Deleting the user revokes every session. */
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    /** SHA-256 (hex) of the cookie token; the token itself is never stored. */
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),

    /**
     * SHA-256 (hex) of the token this one replaced at the last rotation
     * (#216), or null before the first rotation. Accepted for a short
     * grace period, then treated as a stolen token (reuse detection).
     */
    previousTokenHash: varchar("previous_token_hash", { length: 64 }),

    /** When the token last rotated; null until the first rotation. */
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),

    /**
     * `pending` (first factor passed, second required) | `password` |
     * `mfa`; see `SESSION_ASSURANCES`. The auth guard (#222) can require a
     * minimum level per route, so adding 2FA later touches no routes.
     */
    assurance: varchar("assurance", { length: 10 }).notNull().default("password"),

    /** Which credential type started the session (`password`, `passkey`, ...). */
    authMethod: varchar("auth_method", { length: 16 }).notNull().default("password"),

    /**
     * The credential the session was opened with (#277). Replacing a
     * password deletes the old credential row, which deletes every session
     * bound to it, and a login that verified the old password while a
     * reset replaced it cannot insert its session (foreign-key violation).
     * Null for sessions opened before this column existed.
     */
    credentialId: varchar("credential_id", { length: 36 }).references(
      () => userCredentials.id,
      { onDelete: "cascade" },
    ),

    /** Hard expiry; sliding refresh updates it along with `last_seen_at`. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),

    /** Client address and agent at login, for the sessions list and audit log (#221). */
    ip: varchar("ip", { length: 45 }),
    userAgent: varchar("user_agent", { length: 255 }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** "Revoke all sessions of user X" and the sessions list. */
    index("sessions_user_id_idx").on(table.userId),

    /** Expired-session purge. */
    index("sessions_expires_at_idx").on(table.expiresAt),

    /** The guard looks a presented token up by either hash (#216). */
    index("sessions_previous_token_hash_idx").on(table.previousTokenHash),

    /** The cascade from a replaced credential (#277). */
    index("sessions_credential_id_idx").on(table.credentialId),

    check(
      "sessions_assurance_check",
      sql`${table.assurance} IN (${literals(SESSION_ASSURANCES)})`,
    ),

    /** The session started with one of the credential types. */
    check(
      "sessions_auth_method_check",
      sql`${table.authMethod} IN (${literals(CREDENTIAL_TYPES)})`,
    ),
  ],
);
