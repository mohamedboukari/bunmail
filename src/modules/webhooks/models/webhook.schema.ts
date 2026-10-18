import {
  index,
  pgTable,
  varchar,
  boolean,
  timestamp,
  text,
  jsonb,
} from "drizzle-orm/pg-core";
import { users } from "../../users/models/user.schema.ts";
import { apiKeys } from "../../api-keys/models/api-key.schema.ts";

/**
 * Webhooks table: stores endpoint URLs that receive event notifications.
 *
 * Each webhook is scoped to an API key and subscribes to specific event types.
 * Payloads are signed with HMAC-SHA256 using the webhook's secret so the
 * receiver can verify authenticity.
 */
export const webhooks = pgTable(
  "webhooks",
  {
    id: varchar("id", { length: 36 }).primaryKey(),

    /** Which API key owns this webhook */
    apiKeyId: varchar("api_key_id", { length: 36 })
      .notNull()
      .references(() => apiKeys.id),

    /** HTTPS endpoint to POST events to */
    url: text("url").notNull(),

    /** Event types this webhook subscribes to (e.g. ["email.sent", "email.failed"]) */
    events: jsonb("events").$type<string[]>().notNull().default([]),

    /**
     * HMAC-SHA256 signing secret, encrypted at rest with
     * `DKIM_ENCRYPTION_KEY` (#259, `v1:` AES-256-GCM, see
     * `src/utils/crypto.ts`). Rows from before #259 hold the 64-character
     * plaintext until the boot pass (`src/db/encrypt-webhook-secrets.ts`)
     * encrypts them.
     */
    secret: varchar("secret", { length: 255 }).notNull(),

    /** Soft-disable flag */
    isActive: boolean("is_active").notNull().default(true),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),

    /**
     * The dashboard user who created it (#219), or, through the REST API,
     * the creator of the calling key. Null means the owner (legacy rows are
     * assigned to the owner at boot; a removed user's rows become null).
     */
    createdByUserId: varchar("created_by_user_id", { length: 36 }).references(
      () => users.id,
      { onDelete: "set null" },
    ),
  },
  (table) => [
    /** Ownership transfer and the boot backfill update by creator. */
    index("webhooks_created_by_user_id_idx").on(table.createdByUserId),
  ],
);
