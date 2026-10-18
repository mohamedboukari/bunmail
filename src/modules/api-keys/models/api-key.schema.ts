import { sql } from "drizzle-orm";
import {
  pgTable,
  varchar,
  boolean,
  timestamp,
  jsonb,
  index,
  check,
} from "drizzle-orm/pg-core";
import { users } from "../../users/models/user.schema.ts";
import { literals } from "../../users/types/user.types.ts";
import { API_KEY_DISABLED_REASONS } from "../types/api-key.types.ts";

/**
 * API Keys table: stores hashed API keys used to authenticate API requests.
 *
 * The raw key (e.g. `bm_live_abc123...`) is shown to the user once at creation.
 * Only the SHA-256 hash is persisted. On each request, the incoming bearer token
 * is hashed and matched against `key_hash`.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    /** Unique identifier, prefixed with `key_` (e.g. key_a1b2c3...) */
    id: varchar("id", { length: 36 }).primaryKey(),

    /** Human-readable label chosen by the user (e.g. "Production Key") */
    name: varchar("name", { length: 100 }).notNull(),

    /** SHA-256 hash of the raw API key: used for auth lookup */
    keyHash: varchar("key_hash", { length: 255 }).notNull().unique(),

    /** First 8 chars of the raw key: helps users identify which key is which */
    keyPrefix: varchar("key_prefix", { length: 12 }).notNull(),

    /** Soft-disable flag, when false, the key is rejected at auth middleware */
    isActive: boolean("is_active").notNull().default(true),

    /**
     * Admin flag (#130). Admin keys may call the management plane
     * (api-keys, domains, inbound); restricted keys (the default for
     * API-created keys) are send-only + own-data. This is a privilege
     * boundary, so it is settable **only from the operator dashboard**:
     * never via the REST API (it appears in no request DTO). Existing keys
     * were migrated to `true` to preserve pre-#130 behaviour; new
     * API-created keys default to `false`.
     */
    isAdmin: boolean("is_admin").notNull().default(false),

    /**
     * Allowlist of `From` addresses this key may send from (#126). Empty
     * array (the default) means unrestricted: the key can send from any
     * registered domain, preserving pre-#126 behaviour. When non-empty, the
     * `createEmail` gate rejects any send whose `From` isn't in this list,
     * which stops a key from spoofing arbitrary identities (e.g. a dev key
     * for `noreply@` sending as `ceo@`). Enforced for both the REST send
     * API and the SMTP submission server, since both go through
     * `createEmail`. Addresses are stored lower-cased.
     */
    allowedSenders: jsonb("allowed_senders").$type<string[]>().notNull().default([]),

    /** Updated on every successful API request: useful for auditing */
    lastUsedAt: timestamp("last_used_at"),

    /** When this key was created */
    createdAt: timestamp("created_at").notNull().defaultNow(),

    /**
     * The dashboard user the key belongs to (#219): whoever created it in
     * the dashboard, or, for a key created through the REST API, the
     * creator of the key that made the call. A member sees and manages only
     * the keys that carry their id. Null means the owner: rows from before
     * accounts existed are assigned to the owner at boot
     * (`bootstrapOwner`), and removing a user sets their rows to null after
     * their keys were disabled.
     */
    createdByUserId: varchar("created_by_user_id", { length: 36 }).references(
      () => users.id,
      { onDelete: "set null" },
    ),

    /**
     * Why the key is inactive (#219), shown on the API keys page:
     * `revoked` (someone revoked it), `creator_deactivated` or
     * `creator_removed` (its user was deactivated or removed, which disables
     * every key they created). Null on an active key, and on keys revoked
     * before this column existed (shown as revoked). Reactivating a user
     * does not re-enable their keys.
     */
    disabledReason: varchar("disabled_reason", { length: 20 }),
  },
  (table) => [
    /** A member's key list, and the disable/move/backfill updates by creator. */
    index("api_keys_created_by_user_id_idx").on(table.createdByUserId),

    check(
      "api_keys_disabled_reason_check",
      sql`${table.disabledReason} IS NULL OR ${table.disabledReason} IN (${literals(API_KEY_DISABLED_REASONS)})`,
    ),
  ],
);
