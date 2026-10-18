import { index, pgTable, varchar, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { users } from "../../users/models/user.schema.ts";
import { apiKeys } from "../../api-keys/models/api-key.schema.ts";

/**
 * Email templates table: reusable email templates with Mustache-style
 * variable substitution ({{name}}, {{company}}, etc.).
 */
export const templates = pgTable(
  "templates",
  {
    id: varchar("id", { length: 36 }).primaryKey(),

    /** Which API key created this template */
    apiKeyId: varchar("api_key_id", { length: 36 })
      .notNull()
      .references(() => apiKeys.id),

    /** Human-readable name (e.g. "Welcome Email") */
    name: varchar("name", { length: 255 }).notNull(),

    /** Subject line template: supports {{variables}} */
    subject: varchar("subject", { length: 500 }).notNull(),

    /** HTML body template: supports {{variables}} */
    html: text("html"),

    /** Plain text body template: supports {{variables}} */
    textContent: text("text_content"),

    /** List of variable names used in this template (for documentation/validation) */
    variables: jsonb("variables").$type<string[]>().notNull().default([]),

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
    index("templates_created_by_user_id_idx").on(table.createdByUserId),
  ],
);
