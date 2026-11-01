import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { emails } from "../../emails/models/email.schema.ts";
import { webhookDeliveries } from "../../webhooks/models/webhook-delivery.schema.ts";
import { suppressions } from "../../suppressions/models/suppression.schema.ts";

/** The queue as one scrape sees it (#362). */
export interface QueueSnapshot {
  /** Waiting to be sent, including scheduled retries. */
  queued: number;
  /** Claimed by a worker right now. */
  sending: number;
  /** Queued and due now (`next_attempt_at` passed): what the queue should be sending. */
  due: number;
  /** Seconds the most overdue email has been due; 0 when none is. */
  oldestDueAgeSeconds: number;
}

/** Webhook deliveries still to make (#362). */
export interface WebhookBacklog {
  /** Every `pending` delivery, including scheduled retries. */
  pending: number;
  /** Pending and due now: what the worker should be delivering. */
  due: number;
}

/** The suppression reasons a label may carry; anything else in the column is `other`. */
const SUPPRESSION_REASON_LABELS = [
  "bounce",
  "complaint",
  "manual",
  "unsubscribe",
] as const;

/** Everything the database gauges show, read together once per scrape. */
export interface DbSnapshot {
  queue: QueueSnapshot;
  webhooks: WebhookBacklog;
  /** Active suppressions (not expired) by reason, `other` for an unknown one. */
  suppressions: { reason: string; count: number }[];
}

/**
 * Reads the queue's state in one query: only the live, non-terminal rows
 * (`queued`, `sending`, not trashed), the same set the queue claims from,
 * so it stays cheap on a large `emails` table (`idx_emails_status_created`).
 * A healthy queue keeps `oldestDueAgeSeconds` near zero, whatever its
 * scheduled retries look like; a stuck one lets it grow.
 */
export async function readQueueSnapshot(): Promise<QueueSnapshot> {
  const [row] = await db
    .select({
      queued: sql<number>`count(*) filter (where ${emails.status} = 'queued')::int`,
      sending: sql<number>`count(*) filter (where ${emails.status} = 'sending')::int`,
      due: sql<number>`count(*) filter (where ${emails.status} = 'queued' and ${emails.nextAttemptAt} <= now())::int`,
      oldestDueAgeSeconds: sql<number>`coalesce(extract(epoch from now() - min(${emails.nextAttemptAt}) filter (where ${emails.status} = 'queued' and ${emails.nextAttemptAt} <= now())), 0)::float8`,
    })
    .from(emails)
    .where(and(inArray(emails.status, ["queued", "sending"]), isNull(emails.deletedAt)));
  return {
    queued: row?.queued ?? 0,
    sending: row?.sending ?? 0,
    due: row?.due ?? 0,
    oldestDueAgeSeconds: row?.oldestDueAgeSeconds ?? 0,
  };
}

/**
 * Counts the webhook deliveries still to make: only `pending` rows, which
 * the worker's partial index covers, so delivered history costs nothing.
 */
export async function readWebhookBacklog(): Promise<WebhookBacklog> {
  const [row] = await db
    .select({
      pending: sql<number>`count(*)::int`,
      due: sql<number>`count(*) filter (where ${webhookDeliveries.nextAttemptAt} <= now())::int`,
    })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.status, "pending"));
  return { pending: row?.pending ?? 0, due: row?.due ?? 0 };
}

/**
 * Counts the active suppressions (no expiry, or one still ahead) by
 * reason. A gauge read from the table rather than a counter bumped on
 * insert: the bounce and complaint inserts run inside retried
 * transactions, where a counter could count a write that was rolled back.
 */
export async function readSuppressionCounts(): Promise<
  { reason: string; count: number }[]
> {
  /**
   * Literals, not bound parameters: the same expression appears in SELECT
   * and GROUP BY, and parameters would number differently in each, which
   * Postgres refuses. The values are the constants above, never input.
   */
  const known = sql.raw(
    SUPPRESSION_REASON_LABELS.map((reason) => `'${reason}'`).join(", "),
  );
  const label = sql<string>`case when ${suppressions.reason} in (${known}) then ${suppressions.reason} else 'other' end`;
  const rows = await db
    .select({ reason: label, count: sql<number>`count(*)::int` })
    .from(suppressions)
    .where(or(isNull(suppressions.expiresAt), gt(suppressions.expiresAt, sql`now()`)))
    .groupBy(label);
  return rows.map((row) => ({ reason: row.reason, count: row.count }));
}

/** Every database gauge, read in parallel. */
export async function readDbSnapshot(): Promise<DbSnapshot> {
  const [queue, webhooks, suppressionCounts] = await Promise.all([
    readQueueSnapshot(),
    readWebhookBacklog(),
    readSuppressionCounts(),
  ]);
  return { queue, webhooks, suppressions: suppressionCounts };
}
