import { index, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";
import { sessions } from "./session.schema.ts";

/**
 * Every token a session has rotated away from (#216), kept until the
 * session ends.
 *
 * `previous_token_hash` on `sessions` only remembers the last generation,
 * which a thief who keeps a stolen session active can outrun: after two
 * rotations the victim's copy matches nothing and would just be rejected.
 * With the full history, any superseded token presented later, however
 * old, is recognized as reuse and every session of the user is revoked.
 *
 * One row per rotation (at most one a minute per active session), deleted
 * with its session (`ON DELETE CASCADE`), so logout, revocation and the
 * expired-session sweep clean it up.
 */
export const sessionTokenHistory = pgTable(
  "session_token_history",
  {
    /** SHA-256 hex of the superseded token. Hashes of random tokens never collide. */
    tokenHash: varchar("token_hash", { length: 64 }).primaryKey(),

    /** The session that used this token. */
    sessionId: varchar("session_id", { length: 36 })
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),

    /** When the token was replaced. */
    supersededAt: timestamp("superseded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /** The `ON DELETE CASCADE` from `sessions` looks rows up by session. */
    index("session_token_history_session_id_idx").on(table.sessionId),
  ],
);
