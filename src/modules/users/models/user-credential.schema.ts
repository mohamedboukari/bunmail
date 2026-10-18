import { sql } from "drizzle-orm";
import {
  check,
  bigint,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./user.schema.ts";
import { CREDENTIAL_TYPES, literals } from "../types/user.types.ts";

/**
 * One row per login method a user holds (#214). Only `password` is used
 * today; the other types and the provider / public-key columns exist so
 * TOTP (#220), passkeys (#223) and OAuth/SSO (#224) plug in without a
 * schema change.
 *
 * | type       | secret_hash             | provider / provider_account_id | public_key / counter |
 * |------------|-------------------------|--------------------------------|----------------------|
 * | password   | argon2id hash           |                                |                      |
 * | totp       | encrypted TOTP secret   |                                |                      |
 * | passkey    |                         | credential id                  | COSE key, sign count |
 * | oauth      |                         | `google`, `oidc:<issuer>`, id  |                      |
 */
/*
 * A `metadata` jsonb column was in the #214 design and is deliberately
 * deferred: everything the planned types need has an explicit column. If
 * a later type needs free-form data, add it with the `jsonb` column type
 * from `src/db/jsonb.ts`, which stores real JSON (#261).
 */
export const userCredentials = pgTable(
  "user_credentials",
  {
    /** Unique identifier, prefixed with `crd_` */
    id: varchar("id", { length: 36 }).primaryKey(),

    /** Owning user. Deleting the user deletes every credential. */
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    /** `password` | `totp` | `passkey` | `oauth`; see `CREDENTIAL_TYPES`. */
    type: varchar("type", { length: 16 }).notNull(),

    /** External identity provider, or the passkey authenticator, if any. */
    provider: varchar("provider", { length: 100 }),

    /** The user's id at that provider, or the passkey credential id. */
    /** `text`: WebAuthn credential ids may be up to 1023 bytes (base64url). */
    providerAccountId: text("provider_account_id"),

    /** User-chosen label for a passkey or linked account, shown on the profile page. */
    name: varchar("name", { length: 100 }),

    /** Password hash (argon2id, from `Bun.password`) or encrypted TOTP secret. */
    secretHash: text("secret_hash"),

    /** Passkey public key (COSE, base64url). */
    publicKey: text("public_key"),

    /** Passkey signature counter, for clone detection. */
    /** `bigint`: the WebAuthn signature counter is an unsigned 32-bit value. */
    counter: bigint("counter", { mode: "number" }),

    /** Last successful use, for the profile page and stale-credential cleanup. */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** An external account links to one user only. */
    uniqueIndex("user_credentials_provider_account_unique")
      .on(table.provider, table.providerAccountId)
      .where(sql`provider IS NOT NULL`),

    /** One password per user: a change replaces the row's hash. */
    uniqueIndex("user_credentials_one_password_per_user")
      .on(table.userId)
      .where(sql`type = 'password'`),

    check(
      "user_credentials_type_check",
      sql`${table.type} IN (${literals(CREDENTIAL_TYPES)})`,
    ),
  ],
);
