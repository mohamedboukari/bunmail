import {
  pgTable,
  varchar,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { jsonb } from "../../../db/jsonb.ts";
import { apiKeys } from "../../api-keys/models/api-key.schema.ts";
import { emails } from "./email.schema.ts";
import type { JsonObject } from "../types/email.types.ts";

/**
 * Idempotency keys on `POST /api/v1/emails/send` (#188): one row per
 * (API key, `Idempotency-Key` header value) seen in the last
 * `IDEMPOTENCY_KEY_TTL_HOURS`.
 *
 * A table of its own rather than a column on `emails`: the TTL (an
 * expired key is reusable) cannot be expressed by a unique index on
 * `emails`, and a key must not follow its email through trash and purge.
 *
 * The row is inserted first in the transaction that creates the email
 * and completed (`email_id`, `response_status`, `response_body`) before
 * that transaction commits, so a committed row is always complete: the
 * unique index makes a concurrent send with the same key wait for the
 * first one to commit or roll back. See `email.service.ts`
 * (`createEmailIdempotent`).
 */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    /** Surrogate id, prefixed `idk_`; lets the purge delete in batches. */
    id: varchar("id", { length: 36 }).primaryKey(),

    /**
     * The calling API key: keys are scoped to it, so two tenants never
     * collide or see each other's responses. `ON DELETE CASCADE`: a
     * deleted key's idempotency rows mean nothing.
     */
    apiKeyId: varchar("api_key_id", { length: 36 })
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),

    /** The `Idempotency-Key` header value: 1 to 255 printable ASCII characters. */
    key: text("key").notNull(),

    /**
     * SHA-256 hex of the canonical JSON of the validated request body
     * (object keys sorted), so a retry with the same key but another body
     * is refused instead of replayed.
     */
    requestHash: text("request_hash").notNull(),

    /**
     * The email the first request created. `ON DELETE SET NULL`: a purged
     * email does not break the row, which still replays its snapshot.
     */
    emailId: varchar("email_id", { length: 36 }).references(() => emails.id, {
      onDelete: "set null",
    }),

    /** HTTP status of the first response. Null only inside the creating transaction. */
    responseStatus: integer("response_status"),

    /**
     * Body of the first response without message content: the serialized
     * email minus `subject`, `html`, `text` and `headers`, plus its
     * warnings. A replay fills those four from the live email, or answers
     * them `null` once it is trashed or purged. Null only inside the
     * creating transaction.
     */
    responseBody: jsonb<JsonObject | null>("response_body"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    /** When the key becomes reusable: `created_at` plus the TTL. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    /** One live row per (API key, key): the target of the claiming upsert. */
    uniqueIndex("idempotency_keys_api_key_key_unique").on(table.apiKeyId, table.key),
    /** The purge's range scan over expired rows. */
    index("idempotency_keys_expires_at_idx").on(table.expiresAt),
    /**
     * Backs the `email_id` foreign key: without it every email delete
     * (trash purge, permanent delete) would scan this table for the
     * `SET NULL`.
     */
    index("idempotency_keys_email_id_idx").on(table.emailId),
  ],
);
