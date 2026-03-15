import { pgTable, varchar, boolean, timestamp, text, jsonb } from "drizzle-orm/pg-core";
import { apiKeys } from "../../api-keys/models/api-key.schema.ts";

/**
 * Webhooks table — stores endpoint URLs that receive event notifications.
 *
 * Each webhook is scoped to an API key and subscribes to specific event types.
 * Payloads are signed with HMAC-SHA256 using the webhook's secret so the
 * receiver can verify authenticity.
 */
export const webhooks = pgTable("webhooks", {
  id: varchar("id", { length: 36 }).primaryKey(),

  /** Which API key owns this webhook */
  apiKeyId: varchar("api_key_id", { length: 36 })
    .notNull()
    .references(() => apiKeys.id),

  /** HTTPS endpoint to POST events to */
  url: text("url").notNull(),

  /** Event types this webhook subscribes to (e.g. ["email.sent", "email.failed"]) */
  events: jsonb("events").$type<string[]>().notNull().default([]),

  /** HMAC-SHA256 signing secret — included in X-BunMail-Signature header */
  secret: varchar("secret", { length: 64 }).notNull(),

  /** Soft-disable flag */
  isActive: boolean("is_active").notNull().default(true),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
