import { getTableName, sql, type AnyColumn, type SQL } from "drizzle-orm";
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
import { CREDENTIAL_TYPES, SECOND_FACTOR_TYPES, literals } from "../types/user.types.ts";

/**
 * One row per login method a user holds (#214). `password`, `totp` (the
 * second factor, #220) and `passkey` (WebAuthn, a first or second factor,
 * #223) are used; `oauth` and the provider columns exist so OAuth/SSO
 * (#224) plugs in without a schema change.
 *
 * | type       | secret_hash             | provider / provider_account_id | public_key / counter         |
 * |------------|-------------------------|--------------------------------|------------------------------|
 * | password   | argon2id hash           |                                |                              |
 * | totp       | encrypted TOTP secret   |                                | last accepted step           |
 * | passkey    |                         | (none) / credential id         | COSE key, signature counter  |
 * | oauth      |                         | `google`, `oidc:<issuer>`, id  |                              |
 *
 * A `totp` row exists only once confirmed (#220): an enrolment in
 * progress keeps its secret on the session that started it
 * (`sessions.totp_pending_secret`), so "has a `totp` row" always means
 * "has a working second factor". A `passkey` row exists only once its
 * registration verified (#223); the challenge of a registration in
 * progress lives in memory (`passkey-challenge.service.ts`).
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

    /** External identity provider, if any. Null for a passkey (#223). */
    provider: varchar("provider", { length: 100 }),

    /** The user's id at that provider, or the passkey credential id (base64url, #223). */
    /** `text`: WebAuthn credential ids may be up to 1023 bytes (base64url). */
    providerAccountId: text("provider_account_id"),

    /** User-chosen label for a passkey (1 to 64 characters, #223) or linked account. */
    name: varchar("name", { length: 100 }),

    /**
     * Password hash (argon2id, from `Bun.password`), or the TOTP secret
     * (#220): its base32 text encrypted with `encryptSecret` under
     * `DKIM_ENCRYPTION_KEY` (AES-256-GCM, `v1:` format). The TOTP secret
     * must be readable to check a code, so it cannot be hashed.
     */
    secretHash: text("secret_hash"),

    /**
     * Passkey public key (#223): the COSE key from the registration,
     * base64url. Not a secret, but never logged.
     */
    publicKey: text("public_key"),

    /**
     * Passkey transports the authenticator reported at registration (#223),
     * comma-separated (`internal,hybrid`), only known values; a hint for the
     * browser, never trusted. Null when none were reported.
     */
    transports: varchar("transports", { length: 255 }),

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

    /** A WebAuthn credential id belongs to one passkey row, of one user (#223). */
    uniqueIndex("user_credentials_passkey_id_unique")
      .on(table.providerAccountId)
      .where(sql`type = 'passkey'`),

    check(
      "user_credentials_type_check",
      sql`${table.type} IN (${literals(CREDENTIAL_TYPES)})`,
    ),
  ],
);

/**
 * `EXISTS` a second factor for the user in `userId`: a `totp` credential
 * (#220) or a passkey (#223), see `SECOND_FACTOR_TYPES`. A SQL fragment,
 * so the login step and the session guard read it in the query they
 * already run (the guard stays at one query per request). The alias keeps
 * it apart from a `user_credentials` join in the outer query. The one
 * place "has a second factor" is decided: the password step's `pending`
 * assurance, the guard's `password`-session rule and `REQUIRE_2FA` all
 * read it.
 *
 * The outer column is written table-qualified on purpose: in the select
 * list of a single-table query drizzle renders a column bare (`"id"`),
 * which inside this subquery would bind to `second_factor.id` instead.
 */
export function hasSecondFactor(userId: AnyColumn): SQL<boolean> {
  const outer = sql`${sql.identifier(getTableName(userId.table))}.${sql.identifier(userId.name)}`;
  return sql<boolean>`EXISTS (SELECT 1 FROM "user_credentials" AS "second_factor" WHERE "second_factor"."user_id" = ${outer} AND "second_factor"."type" IN (${literals(SECOND_FACTOR_TYPES)}))`;
}
