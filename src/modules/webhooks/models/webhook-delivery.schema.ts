import {
  pgTable,
  varchar,
  text,
  timestamp,
  integer,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { webhooks } from "./webhook.schema.ts";

/**
 * Persisted record of every webhook delivery attempt (#30).
 *
 * The dispatcher used to retry in-memory (1s/2s/4s) — a server restart
 * mid-retry would lose the event silently and a consumer outage longer
 * than ~7s would burn through all retries before the consumer came
 * back. This table durably queues every dispatch so the worker can
 * pick up where it left off on reboot, retry over hours instead of
 * seconds, and give operators a way to inspect / replay failures.
 *
 * Lifecycle:
 *
 *   pending  → worker claims via FOR UPDATE SKIP LOCKED, attempts POST
 *     ├─ 2xx response  → delivered (terminal)
 *     ├─ non-2xx / network error / timeout
 *     │    ├─ attempts < MAX_DELIVERY_ATTEMPTS → reschedule (next_attempt_at advanced per backoff schedule)
 *     │    └─ attempts == MAX                  → failed (terminal)
 *
 * Operators can flip a `failed` row back to `pending` via the replay
 * endpoint / dashboard button; the worker picks it up on the next poll.
 *
 * `payload` stores the body BYTES (the JSON.stringify output that's
 * actually POSTed), not the deserialised event data. The signature is
 * NOT stored — re-signed per attempt with a fresh timestamp so a long
 * retry chain doesn't ship a 6-hour-old signature that the consumer's
 * freshness window (typically 5 min) would reject.
 */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: varchar("id", { length: 36 }).primaryKey(),

    /** The webhook this delivery is destined for. CASCADE so deleting a
     *  webhook also reaps its pending/historical deliveries. */
    webhookId: varchar("webhook_id", { length: 36 })
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),

    /** Event vocabulary mirrors the union in webhook.types.ts.
     *  Stored as text for forward-compat; valid values gated at
     *  `dispatchEvent` time. */
    event: varchar("event", { length: 50 }).notNull(),

    /** The body bytes (JSON.stringify of the WebhookPayload envelope).
     *  Re-signed per attempt at delivery time; the signature itself is
     *  NOT stored. */
    payload: text("payload").notNull(),

    /** pending | delivered | failed. Workers only claim `pending` rows
     *  whose `next_attempt_at <= now()`. */
    status: varchar("status", { length: 20 }).notNull().default("pending"),

    /** 0 at enqueue; incremented on every claimed attempt regardless of
     *  outcome. `attempts == MAX_DELIVERY_ATTEMPTS` after a non-2xx
     *  flips status to `failed`. */
    attempts: integer("attempts").notNull().default(0),

    /** Last error message (network error, timeout, or non-2xx body
     *  preview). Truncated by the worker to a sane limit. */
    lastError: text("last_error"),

    /** HTTP status code from the most recent attempt. Null if the
     *  attempt didn't reach an HTTP response (network error / timeout). */
    lastResponseStatus: integer("last_response_status"),

    /** When the worker is allowed to claim this row. The hot-path index
     *  is on this column (filtered to `status='pending'`). */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    /** Set when status flips to `delivered`. Used by retention cleanup. */
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),

    /** Optional response shape — small JSON capturing useful detail
     *  from the last attempt (truncated body preview, headers we care
     *  about). Kept so operators can debug without re-running the
     *  request. Null when the attempt didn't yield a structured response. */
    lastResponseBody: jsonb("last_response_body").$type<{
      bodyPreview?: string;
      headers?: Record<string, string>;
    } | null>(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** Worker hot path — partial index on the only rows the poll loop
     *  will ever scan. Keeps it tiny even when `delivered` rows
     *  accumulate. */
    duePendingIdx: index("webhook_deliveries_due_pending_idx")
      .on(table.nextAttemptAt)
      .where(sql`status = 'pending'`),

    /** Inspection page hot path — "show me the latest deliveries for
     *  webhook X" sorted newest first. */
    perWebhookIdx: index("webhook_deliveries_per_webhook_idx").on(
      table.webhookId,
      table.createdAt,
    ),
  }),
);

export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type NewWebhookDelivery = typeof webhookDeliveries.$inferInsert;
