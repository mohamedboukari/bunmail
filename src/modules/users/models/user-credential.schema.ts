import { sql, type AnyColumn, type SQL } from "drizzle-orm";
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
 * One row per login method a user holds (#214). `password` and `totp`
 * (the second factor, #220) are used; the other types and the provider /
 * public-key columns exist so passkeys (#223) and OAuth/SSO (#224) plug in
 * without a schema change.
 *
 * | type       | secret_hash             | provider / provider_account_id | public_key / counter |
 * |------------|-------------------------|--------------------------------|----------------------|
 * | password   | argon2id hash           |                                |                      |
 * | totp       | encrypted TOTP secret   |                                | last accepted step   |
 * | passkey    |                         | credential id                  | COSE key, sign count |
 * | oauth      |                         | `google`, `oidc:<issuer>`, id  |                      |
 *
 * A `totp` row exists only once confirmed (#220): an enrolment in
 * progress keeps its secret on the session that started it
 * (`sessions.totp_pending_secret`), so "has a `totp` row" always means
 * "has a working second factor".
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

    /**
     * Password hash (argon2id, from `Bun.password`), or the TOTP secret
     * (#220): its base32 text encrypted with `encryptSecret` under
     * `DKIM_ENCRYPTION_KEY` (AES-256-GCM, `v1:` format). The TOTP secret
     * must be readable to check a code, so it cannot be hashed.
     */
    secretHash: text("secret_hash"),

    /** Passkey public key (COSE, base64url). */
    publicKey: text("public_key"),

    /**
     * Passkey signature counter, for clone detection; for `totp` (#220) the
     * last accepted time step (Unix time / 30 s), so a code is accepted at
     * most once (replay protection, a compare-and-swap on this column).
     */
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

    /** One TOTP second factor per user (#220): two racing confirmations cannot both win. */
    uniqueIndex("user_credentials_one_totp_per_user")
      .on(table.userId)
      .where(sql`type = 'totp'`),

    check(
      "user_credentials_type_check",
      sql`${table.type} IN (${literals(CREDENTIAL_TYPES)})`,
    ),
  ],
);

/**
 * `EXISTS` a `totp` credential for the user in `userId` (#220): whether
 * the account has a second factor. A SQL fragment, so the login step and
 * the session guard read it in the query they already run (the guard
 * stays at one query per request). The alias keeps it apart from a
 * `user_credentials` join in the outer query.
 */
export function hasTotpCredential(userId: AnyColumn): SQL<boolean> {
  return sql<boolean>`EXISTS (SELECT 1 FROM "user_credentials" AS "totp_credential" WHERE "totp_credential"."user_id" = ${userId} AND "totp_credential"."type" = 'totp')`;
}
