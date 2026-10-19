import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  sql,
  type SQL,
} from "drizzle-orm";
import type { PgInsertValue } from "drizzle-orm/pg-core";
import { db } from "../../../db/index.ts";
import { generateId } from "../../../utils/id.ts";
import { logger } from "../../../utils/logger.ts";
import { apiKeys } from "../../api-keys/models/api-key.schema.ts";
import { domains } from "../../domains/models/domain.schema.ts";
import { users } from "../../users/models/user.schema.ts";
import { sessionIp } from "../../users/services/session-policy.service.ts";
import type { Tx } from "../../users/types/user.types.ts";
import { toAuditStoreError } from "../errors.ts";
import { auditEvents } from "../models/audit-event.schema.ts";
import type {
  AuditAction,
  AuditActor,
  AuditActorOption,
  AuditEvent,
  AuditEventFilters,
  AuditEventInput,
  AuditOutcome,
  AuditTarget,
} from "../types/audit.types.ts";

/**
 * What a row is built from: `AuditEventInput` with the per-action
 * metadata typing erased (the public signature keeps it).
 */
interface AuditRowInput {
  action: AuditAction;
  outcome?: AuditOutcome;
  actor: AuditActor;
  ip?: string | null;
  userAgent?: string | null;
  target?: AuditTarget;
  metadata?: object | null;
}

/**
 * The audit log (#221): records security-relevant actions and reads them
 * back for the dashboard's Audit log page. The only module that touches
 * `audit_events`.
 *
 * **Writes.** `recordAuditEvent(input, tx?)`:
 *
 * - with `tx`, the row is inserted in the caller's transaction, so the
 *   change and its record commit (or roll back) together; a failed insert
 *   throws (`AuditStoreError`) and takes the change down with it;
 * - without, the row is inserted on its own right after the outcome is
 *   known; a failure is logged at `error` (action, actor and target ids,
 *   SQLSTATE) and never reaches the caller, so a broken audit write never
 *   breaks a user's request.
 *
 * **Append-only.** Nothing here updates a row, and the only delete is the
 * retention purge (`purgeOldAuditEvents`). The database refuses any
 * `UPDATE` of the table (trigger in migration 0028).
 *
 * **What is stored.** The IP only when it is an IP literal, the user
 * agent cut to 256 characters, labels as snapshots, and per-action
 * metadata (`AuditMetadataByAction`) with any secret-looking key dropped.
 * Never logs a label or a user agent: they are PII or attacker-chosen.
 */

/** Longest `User-Agent` stored, in characters (code points). */
const USER_AGENT_MAX_LENGTH = 256;

/**
 * Metadata keys that must never be stored: the typed metadata cannot
 * carry them, this is the last line of defence against a future
 * `metadata` built from a wider object.
 */
const SECRET_KEY_RE = /password|secret|token|hash|cookie|credential|private|^code$/i;

/** Rows per retention delete, and how many batches one purge pass runs at most. */
const PURGE_BATCH_SIZE = 5000;
const PURGE_MAX_BATCHES = 100;

/** Most actors the page's actor filter lists. */
const ACTOR_OPTION_LIMIT = 500;

/** The user agent to store: cut to 256 code points (never splitting a pair), or null. */
function clampUserAgent(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  return Array.from(userAgent).slice(0, USER_AGENT_MAX_LENGTH).join("");
}

/** The metadata to store, with every secret-looking key dropped (and logged by name). */
function safeMetadata(
  action: AuditAction,
  metadata: object | null | undefined,
): Record<string, unknown> | null {
  if (!metadata) return null;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (SECRET_KEY_RE.test(key)) {
      logger.warn("Audit metadata key dropped: looks like a secret", { action, key });
      continue;
    }
    kept[key] = value;
  }
  return Object.keys(kept).length > 0 ? kept : null;
}

/**
 * The actor's id and label. A label left `undefined` is read from the
 * live row in the same statement (and so the same transaction): the
 * user's email, the key's name.
 */
function actorColumns(actor: AuditActor): {
  actorId: string | null;
  actorLabel: string | null | SQL;
} {
  if (actor.type === "system") return { actorId: null, actorLabel: actor.label };
  const { id } = actor;
  if (actor.label !== undefined || id === null) {
    return { actorId: id, actorLabel: actor.label ?? null };
  }
  return {
    actorId: id,
    actorLabel:
      actor.type === "user"
        ? sql`(SELECT ${users.email} FROM ${users} WHERE ${users.id} = ${id})`
        : sql`(SELECT ${apiKeys.name} FROM ${apiKeys} WHERE ${apiKeys.id} = ${id})`,
  };
}

/**
 * The target's label: the given one, or for a user, an API key or a
 * domain, read from the live row in the same statement. Read before a
 * delete, or pass it: a deleted row has none.
 */
function targetLabel(target: AuditTarget): string | null | SQL {
  if (target.label !== undefined || target.id === null) return target.label ?? null;
  const { id } = target;
  switch (target.type) {
    case "user":
      return sql`(SELECT ${users.email} FROM ${users} WHERE ${users.id} = ${id})`;
    case "api_key":
      return sql`(SELECT ${apiKeys.name} FROM ${apiKeys} WHERE ${apiKeys.id} = ${id})`;
    case "domain":
      return sql`(SELECT ${domains.name} FROM ${domains} WHERE ${domains.id} = ${id})`;
    default:
      return null;
  }
}

/** The row an input becomes. */
function toRow(input: AuditRowInput): PgInsertValue<typeof auditEvents> {
  return {
    id: generateId("aud"),
    actorType: input.actor.type,
    ...actorColumns(input.actor),
    action: input.action,
    outcome: input.outcome ?? "success",
    targetType: input.target?.type ?? null,
    targetId: input.target?.id ?? null,
    targetLabel: input.target ? targetLabel(input.target) : null,
    ip: sessionIp(input.ip),
    userAgent: clampUserAgent(input.userAgent),
    metadata: safeMetadata(input.action, input.metadata),
  };
}

/** IDs of an event, for a log line about it. Never a label or a user agent. */
function eventIds(input: AuditRowInput): Record<string, string | null> {
  return {
    action: input.action,
    outcome: input.outcome ?? "success",
    actorType: input.actor.type,
    actorId: input.actor.type === "system" ? null : input.actor.id,
    targetType: input.target?.type ?? null,
    targetId: input.target?.id ?? null,
  };
}

/**
 * Records one audit event. With `tx`, inside the caller's transaction
 * (throws `AuditStoreError` on failure, rolling the change back with it);
 * without, on its own, and a failure is logged at `error` and swallowed.
 */
export async function recordAuditEvent<A extends AuditAction>(
  input: AuditEventInput<A>,
  tx?: Tx,
): Promise<void> {
  const row = toRow(input);
  if (tx) {
    try {
      await tx.insert(auditEvents).values(row);
    } catch (error: unknown) {
      throw toAuditStoreError(error);
    }
    return;
  }
  try {
    await db.insert(auditEvents).values(row);
  } catch (error: unknown) {
    const { sqlState } = toAuditStoreError(error);
    logger.error("Audit event not recorded", { ...eventIds(input), sqlState });
  }
}

/** The `WHERE` clause of the page's filters. */
function filterClause(filters: AuditEventFilters): SQL | undefined {
  const clauses: (SQL | undefined)[] = [];
  if (filters.action) clauses.push(eq(auditEvents.action, filters.action));
  if (filters.outcome) clauses.push(eq(auditEvents.outcome, filters.outcome));
  if (filters.actor) {
    clauses.push(eq(auditEvents.actorType, filters.actor.type));
    clauses.push(
      filters.actor.type === "system"
        ? isNull(auditEvents.actorId)
        : eq(auditEvents.actorId, filters.actor.id),
    );
  }
  return and(...clauses);
}

/**
 * One page of events, newest first, with the total for the paginator.
 * Ties on the timestamp are broken by id, so pages never overlap.
 */
export async function listAuditEvents(
  filters: AuditEventFilters,
): Promise<{ data: AuditEvent[]; total: number }> {
  const where = filterClause(filters);
  try {
    const [data, [countRow]] = await Promise.all([
      db
        .select()
        .from(auditEvents)
        .where(where)
        .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
        .limit(filters.limit)
        .offset((filters.page - 1) * filters.limit),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(auditEvents)
        .where(where),
    ]);
    return { data, total: countRow?.count ?? 0 };
  } catch (error: unknown) {
    throw toAuditStoreError(error);
  }
}

/**
 * The users and API keys that appear as actors, each with its most
 * recent label, for the page's actor filter. Ordered by label.
 */
export async function listAuditActors(): Promise<AuditActorOption[]> {
  let rows: { type: string; id: string | null; label: string | null }[];
  try {
    rows = await db
      .select({
        type: auditEvents.actorType,
        id: auditEvents.actorId,
        label: sql<
          string | null
        >`(array_agg(${auditEvents.actorLabel} ORDER BY ${auditEvents.occurredAt} DESC))[1]`,
      })
      .from(auditEvents)
      .where(
        and(
          isNotNull(auditEvents.actorId),
          inArray(auditEvents.actorType, ["user", "api_key"]),
        ),
      )
      .groupBy(auditEvents.actorType, auditEvents.actorId)
      .orderBy(sql`3`)
      .limit(ACTOR_OPTION_LIMIT);
  } catch (error: unknown) {
    throw toAuditStoreError(error);
  }
  const options: AuditActorOption[] = [];
  for (const row of rows) {
    if (row.id === null) continue;
    if (row.type === "user" || row.type === "api_key") {
      options.push({ type: row.type, id: row.id, label: row.label });
    }
  }
  return options;
}

/**
 * Deletes the events older than `retentionDays` (on the database clock),
 * in batches of `batchSize`, at most `PURGE_MAX_BATCHES` batches per call
 * (the rest goes at the next pass): the only delete of the table.
 *
 * @returns how many events were deleted.
 */
export async function purgeOldAuditEvents(
  retentionDays: number,
  batchSize: number = PURGE_BATCH_SIZE,
): Promise<number> {
  const cutoff = sql`now() - ${sql.raw(`interval '${Math.trunc(retentionDays)} days'`)}`;
  let deleted = 0;
  try {
    for (let batch = 0; batch < PURGE_MAX_BATCHES; batch += 1) {
      const expired = db
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(lt(auditEvents.occurredAt, cutoff))
        .limit(batchSize);
      const rows = await db
        .delete(auditEvents)
        .where(inArray(auditEvents.id, expired))
        .returning({ id: auditEvents.id });
      deleted += rows.length;
      if (rows.length < batchSize) break;
    }
  } catch (error: unknown) {
    throw toAuditStoreError(error);
  }
  return deleted;
}
