import { index, pgTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { users } from "./user.schema.ts";
import { userCredentials } from "./user-credential.schema.ts";

/**
 * TOTP recovery codes (#220): ten single-use codes issued when an account
 * confirms its authenticator app, for signing in when the phone is lost.
 *
 * A table of their own rather than `user_credentials` rows: a recovery
 * code is not a way to log in on its own (it stands in for the second
 * factor only), there are ten per account, and each is spent separately
 * (`used_at`), which a credential row has no column for. Adding a
 * credential type would also widen `sessions.auth_method`.
 *
 * Only the SHA-256 of each code is stored. A code carries 80 random bits
 * (16 base32 characters), so a fast hash is enough: nobody can try 2^80
 * candidates against a stolen hash, unlike a human-chosen password.
 *
 * Every code belongs to the `totp` credential it was issued with
 * (`credential_id`, ON DELETE CASCADE): disabling 2FA, or a password
 * reset removing it, deletes the codes in the same statement.
 */
export const userRecoveryCodes = pgTable(
  "user_recovery_codes",
  {
    /** Unique identifier, prefixed with `rcv_` */
    id: varchar("id", { length: 36 }).primaryKey(),

    /** Owning user. Deleting the user deletes every code. */
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    /** The `totp` credential the code was issued with; the codes go with it. */
    credentialId: varchar("credential_id", { length: 36 })
      .notNull()
      .references(() => userCredentials.id, { onDelete: "cascade" }),

    /** SHA-256 (hex) of the normalized code (16 upper-case base32 characters). */
    codeHash: varchar("code_hash", { length: 64 }).notNull(),

    /** When the code was spent; null while unused. A code works once. */
    usedAt: timestamp("used_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** The sign-in lookup (account and hash), and no duplicate code per account. */
    uniqueIndex("user_recovery_codes_user_id_code_hash_idx").on(
      table.userId,
      table.codeHash,
    ),

    /** The cascade from a removed `totp` credential. */
    index("user_recovery_codes_credential_id_idx").on(table.credentialId),
  ],
);
