import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { jsonb } from "../../../db/jsonb.ts";
import { literals } from "../../users/types/user.types.ts";
import { AUDIT_ACTOR_TYPES, AUDIT_OUTCOMES } from "../types/audit.types.ts";

/**
 * The audit log (#221): one row per security-relevant action (sign-ins,
 * account and invitation changes, two-factor changes, API key, domain,
 * webhook and suppression changes).
 *
 * **Append-only.** The application inserts rows and, for retention only,
 * deletes old ones (`purgeOldAuditEvents`); it never updates one. The
 * migration adds a statement-level trigger that raises on any `UPDATE` of
 * this table, so a bug or an injected query cannot rewrite history
 * through the application's own connection either. `DELETE` stays allowed
 * for the retention purge.
 *
 * **No foreign keys.** Actor and target are snapshots (id, plus the
 * email or name at the time as a label): deleting a user, a key or a
 * domain never deletes, blocks or rewrites its history.
 *
 * `action` is a code-level string union (`AuditAction`), deliberately not
 * a CHECK constraint: new actions then need no migration. `actor_type`
 * and `outcome` are small, stable sets and are checked.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    /** Unique identifier, prefixed with `aud_` */
    id: varchar("id", { length: 36 }).primaryKey(),

    /** When the action happened, on the database clock. */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),

    /** `user` | `api_key` | `system`; see `AUDIT_ACTOR_TYPES`. */
    actorType: varchar("actor_type", { length: 10 }).notNull(),

    /** `usr_` or `key_` id; null for BunMail itself and unidentified sign-in attempts. */
    actorId: text("actor_id"),

    /** The actor's email or key name at the time (or what ran, for `system`). */
    actorLabel: text("actor_label"),

    /** What happened, e.g. `auth.login.succeeded`; see `AuditAction`. */
    action: varchar("action", { length: 64 }).notNull(),

    /** `success` | `failure`. */
    outcome: varchar("outcome", { length: 10 }).notNull(),

    /** What it acted on (`user`, `api_key`, `domain`, ...), its id and a label snapshot. */
    targetType: varchar("target_type", { length: 32 }),
    targetId: text("target_id"),
    targetLabel: text("target_label"),

    /** Client IP (an IP literal only) and `User-Agent` (cut to 256 characters). */
    ip: text("ip"),
    userAgent: text("user_agent"),

    /** Small per-action details (`AuditMetadataByAction`); never secrets or content. */
    metadata: jsonb<Record<string, unknown> | null>("metadata"),
  },
  (table) => [
    /** The page's default listing, newest first, and the retention purge. */
    index("audit_events_occurred_at_idx").on(table.occurredAt.desc(), table.id.desc()),

    /** Filter by action. */
    index("audit_events_action_idx").on(table.action, table.occurredAt.desc()),

    /** Filter by actor. */
    index("audit_events_actor_idx").on(table.actorId, table.occurredAt.desc()),

    check(
      "audit_events_actor_type_check",
      sql`${table.actorType} IN (${literals(AUDIT_ACTOR_TYPES)})`,
    ),
    check(
      "audit_events_outcome_check",
      sql`${table.outcome} IN (${literals(AUDIT_OUTCOMES)})`,
    ),
  ],
);
