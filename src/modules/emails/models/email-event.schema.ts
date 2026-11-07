import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { apiKeys } from "../../api-keys/models/api-key.schema.ts";
import { literals } from "../../users/types/user.types.ts";
import {
  EMAIL_EVENT_CLIENT_KINDS,
  EMAIL_EVENT_TYPES,
} from "../types/email-event.types.ts";
import { emails } from "./email.schema.ts";

/**
 * Open and click events of outbound emails (#187): one row per recorded
 * pixel fetch or tracked link click.
 *
 * Privacy by construction: no IP address and no user agent are stored,
 * only a coarse `client_kind` and a `machine` guess. A click's URL is
 * stored without its query string and fragment (they often carry tokens).
 * Events go with their email (`ON DELETE CASCADE`: trash purge and
 * permanent delete), and the purge cycle deletes any older than
 * `EMAIL_EVENTS_RETENTION_DAYS` (`email-events.service.ts`).
 *
 * In the emails module rather than a module of its own: every event
 * belongs to one email, cascades with it, and is read under
 * `/api/v1/emails/:id/events`.
 */
export const emailEvents = pgTable(
  "email_events",
  {
    /** Unique identifier, prefixed with `evt_`. */
    id: varchar("id", { length: 36 }).primaryKey(),

    /** The email the event belongs to; deleted with it. */
    emailId: varchar("email_id", { length: 36 })
      .notNull()
      .references(() => emails.id, { onDelete: "cascade" }),

    /**
     * The email's sending key, copied from the email so key-scoped lists
     * and webhooks need no join. `ON DELETE CASCADE` like the idempotency
     * keys: a deleted key's events mean nothing (keys are revoked, not
     * deleted, in normal operation).
     */
    apiKeyId: varchar("api_key_id", { length: 36 })
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),

    /** `open` or `click`; see `EMAIL_EVENT_TYPES`. */
    type: varchar("type", { length: 10 }).notNull(),

    /** A click: the position of the rewritten link in the HTML. Null for an open. */
    linkPosition: integer("link_position"),

    /** A click: the target without query string and fragment. Null for an open. */
    url: text("url"),

    /** `image_proxy` or `unknown`; see `EMAIL_EVENT_CLIENT_KINDS`. */
    clientKind: varchar("client_kind", { length: 16 }).notNull(),

    /**
     * A guess that no person caused the event (a known proxy, a link
     * scanner clicking right after delivery). Its accuracy is unknown.
     */
    machine: boolean("machine").notNull(),

    /** When the event happened, on the database clock. */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** An email's timeline, and the cascade from `emails`. */
    index("email_events_email_id_occurred_at_idx").on(table.emailId, table.occurredAt),

    /** Key-scoped lists and aggregates, newest first. */
    index("email_events_api_key_id_occurred_at_idx").on(
      table.apiKeyId,
      table.occurredAt.desc(),
    ),

    /** The retention sweep. */
    index("email_events_occurred_at_idx").on(table.occurredAt),

    check(
      "email_events_type_check",
      sql`${table.type} IN (${literals(EMAIL_EVENT_TYPES)})`,
    ),
    check(
      "email_events_client_kind_check",
      sql`${table.clientKind} IN (${literals(EMAIL_EVENT_CLIENT_KINDS)})`,
    ),
  ],
);
