import { and, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { emails } from "../../emails/models/email.schema.ts";

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
