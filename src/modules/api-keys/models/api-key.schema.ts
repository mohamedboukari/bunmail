import { pgTable, varchar, boolean, timestamp } from "drizzle-orm/pg-core";

/**
 * API Keys table — stores hashed API keys used to authenticate API requests.
 *
 * The raw key (e.g. `bm_live_abc123...`) is shown to the user once at creation.
 * Only the SHA-256 hash is persisted. On each request, the incoming bearer token
 * is hashed and matched against `key_hash`.
 */
export const apiKeys = pgTable("api_keys", {
  /** Unique identifier, prefixed with `key_` (e.g. key_a1b2c3...) */
  id: varchar("id", { length: 36 }).primaryKey(),

  /** Human-readable label chosen by the user (e.g. "Production Key") */
  name: varchar("name", { length: 100 }).notNull(),

  /** SHA-256 hash of the raw API key — used for auth lookup */
  keyHash: varchar("key_hash", { length: 255 }).notNull().unique(),

  /** First 8 chars of the raw key — helps users identify which key is which */
  keyPrefix: varchar("key_prefix", { length: 12 }).notNull(),

  /** Soft-disable flag — when false, the key is rejected at auth middleware */
  isActive: boolean("is_active").notNull().default(true),

  /** Updated on every successful API request — useful for auditing */
  lastUsedAt: timestamp("last_used_at"),

  /** When this key was created */
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
