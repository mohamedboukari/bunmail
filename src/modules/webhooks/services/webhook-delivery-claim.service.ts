import { eq, sql, inArray, type SQL } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { webhookDeliveries } from "../models/webhook-delivery.schema.ts";
import { webhooks } from "../models/webhook.schema.ts";
import { apiKeys } from "../../api-keys/models/api-key.schema.ts";
import { logger } from "../../../utils/logger.ts";
import { decryptSecret, isEncryptedSecret } from "../../../utils/crypto.ts";
import { config } from "../../../config.ts";
import { MAX_DELIVERY_ATTEMPTS } from "./webhook-delivery-schedule.service.ts";

/**
 * The claim advances `next_attempt_at` by this much so the row is
 * invisible to subsequent claims for the duration of the in-flight
 * HTTP attempt. Without this, two parallel workers would happily
 * re-pick the same row between (claim commit) and (recordAttempt commit)
 * because the row stays `pending` and remains due. Set to ~3x the
 * HTTP timeout: long enough to cover normal attempts plus slack for
 * `recordAttempt`'s round-trip; short enough that a worker crash
 * mid-attempt unblocks the row within half a minute. */
const ATTEMPT_LOCK_MS = 30_000;

/**
 * The ids of the next `n` due `pending` deliveries, shared fairly across
 * the API keys that own their webhooks (#258), each row locked
 * `FOR UPDATE SKIP LOCKED`.
 *
 * A plain global FIFO let one key with a large backlog (or a webhook that
 * is down and collecting retries) fill every batch, delaying every other
 * key's events. Deliveries carry no `api_key_id`, so the key comes from
 * the owning webhook:
 *
 *   1. For each webhook, a `LATERAL` subquery takes its first `n` due
 *      rows in due order through `webhook_deliveries_due_per_webhook_idx`,
 *      locking them `SKIP LOCKED`: one short index probe per webhook,
 *      whatever the backlog (webhooks per key are capped, see
 *      `WEBHOOKS_MAX_PER_API_KEY`).
 *   2. The candidates are ranked within the webhook's API key by due time,
 *      and the batch takes the lowest ranks first, oldest first within a
 *      rank: round-robin across keys. A single key keeps FIFO order.
 *
 * The lock sits in the per-webhook subqueries because Postgres refuses
 * `FOR UPDATE` at the level of a window function; there it keeps
 * concurrent workers' claims disjoint. Candidates locked but not taken
 * are released when the claim's transaction ends.
 */
function fairDueDeliveryIds(n: number): SQL {
  return sql`
    SELECT fair.id FROM (
      SELECT due.id, due.next_attempt_at,
        row_number() OVER (
          PARTITION BY ${webhooks.apiKeyId} ORDER BY due.next_attempt_at, due.id
        ) AS key_rank
      FROM ${webhooks} CROSS JOIN LATERAL (
        SELECT ${webhookDeliveries.id}, ${webhookDeliveries.nextAttemptAt}
        FROM ${webhookDeliveries}
        WHERE ${webhookDeliveries.webhookId} = ${webhooks.id}
          AND ${webhookDeliveries.status} = 'pending'
          AND ${webhookDeliveries.nextAttemptAt} <= NOW()
        ORDER BY ${webhookDeliveries.nextAttemptAt}
        LIMIT ${n}
        FOR UPDATE OF ${webhookDeliveries} SKIP LOCKED
      ) AS due
    ) AS fair
    ORDER BY fair.key_rank, fair.next_attempt_at, fair.id
    LIMIT ${n}`;
}

/**
 * Claims up to `n` due `pending` rows and returns them with the
 * webhook secret + url joined in. Atomic: two concurrent workers will
 * never see the same row, same guarantee as the email queue claim
 * from #20.
 *
 * The claim counts the attempt (`attempts + 1`) before it is made, and
 * returns the count from before the claim; `recordAttempt` then writes
 * that same `prior + 1`. Counting at claim time means an attempt that
 * crashes the process (before `recordAttempt` runs) still counts toward
 * the retry limit, so a delivery that kills the worker cannot be retried
 * forever; once the limit is exceeded the claim marks it `failed`. Drizzle
 * doesn't support a literal SELECT FOR UPDATE in the bun-sql adapter
 * cleanly without an UPDATE wrapper, and we want exclusive locks so
 * concurrent workers' SKIP LOCKED actually skips.
 *
 * Internal: exposed for the worker only.
 */
export async function claimDueDeliveries(
  n: number,
  now: Date = new Date(),
): Promise<
  Array<{
    id: string;
    webhookId: string;
    event: string;
    payload: string;
    attempts: number;
    url: string;
    /** The signing secret in plaintext, or `null` when it cannot be decrypted. */
    secret: string | null;
  }>
> {
  /**
   * Inner: pick + lock the next `n` due rows, shared fairly across API
   * keys (#258, see {@link fairDueDeliveryIds}).
   *
   * The "is this row due?" comparison uses Postgres `NOW()` rather
   * than the JS `now` we got from the caller. Why: rows set
   * `next_attempt_at` via Drizzle's `defaultNow()` (= Postgres NOW())
   * at insert time. On a CI runner with a containerised Postgres, the
   * DB clock can drift a few ms ahead of the worker process's clock,
   * which means a freshly-enqueued row's `next_attempt_at` is in the
   * Node-perceived future for a brief window, and the claim's `<=`
   * filter excludes it. Comparing both sides in DB time sidesteps the
   * skew entirely. The OUTER UPDATE below still uses the Node `now`
   * for its set values; minor skew on those is harmless.
   */
  const pickIds = fairDueDeliveryIds(n);

  /** Outer: push `next_attempt_at` forward by ATTEMPT_LOCK_MS so the
   *  row is invisible to subsequent claims for the duration of the
   *  in-flight attempt. This is the actual concurrency-safety guarantee:
   *  the SELECT FOR UPDATE only locks rows for the few-ms duration of
   *  this single statement, but the HTTP attempt that follows takes
   *  much longer. Without this push, a parallel worker would re-claim
   *  the same row immediately after this statement commits.
   *
   *  `recordAttempt` runs after the HTTP call returns and overwrites
   *  `next_attempt_at` with either the real backoff schedule (failure)
   *  or sets `delivered_at` (success). If the worker process crashes
   *  before `recordAttempt` runs, the lock expires after ATTEMPT_LOCK_MS
   *  and the row becomes claimable again: natural crash recovery
   *  with no explicit `recoverInterrupted` step needed. */
  /**
   * The claim and its follow-up updates run in one transaction: if any
   * statement fails, the `attempts` increment rolls back instead of
   * costing every claimed row an attempt, and the claimed rows stay
   * locked until commit, so a concurrent replay or `recordAttempt` waits
   * rather than being overwritten by the updates below.
   */
  return db.transaction(async (tx) => {
    const claimed = await tx
      .update(webhookDeliveries)
      .set({
        nextAttemptAt: new Date(now.getTime() + ATTEMPT_LOCK_MS),
        attempts: sql`${webhookDeliveries.attempts} + 1`,
        updatedAt: now,
      })
      .where(sql`${webhookDeliveries.id} IN (${pickIds})`)
      .returning();

    if (claimed.length === 0) return [];

    /** Join the webhook's url + secret per row. We need both for delivery
     *  but they live on the parent table. One round-trip via inArray. */
    const webhookIds = [...new Set(claimed.map((r) => r.webhookId))];
    const hooks = await tx
      .select({
        id: webhooks.id,
        url: webhooks.url,
        secret: webhooks.secret,
        isActive: webhooks.isActive,
        /** Deliverable only while the owning key is active too: rows
         *  queued before a key was revoked are not sent afterwards. */
        keyActive: apiKeys.isActive,
      })
      .from(webhooks)
      .innerJoin(apiKeys, eq(apiKeys.id, webhooks.apiKeyId))
      .where(inArray(webhooks.id, webhookIds));
    const hookById = new Map(hooks.map((h) => [h.id, h]));

    /** Drop deliveries whose webhook was deactivated after enqueue. We
     *  mark them `failed` rather than send to a hook the operator has
     *  paused: that's the operator's stated intent. */
    const live: typeof claimed = [];
    for (const row of claimed) {
      /** Over the limit only if earlier attempts never reached
       *  `recordAttempt` (the process died mid-attempt): stop retrying. */
      if (row.attempts > MAX_DELIVERY_ATTEMPTS) {
        await tx
          .update(webhookDeliveries)
          .set({
            status: "failed",
            attempts: MAX_DELIVERY_ATTEMPTS,
            lastError: "attempt limit reached: earlier attempts were interrupted",
            updatedAt: now,
          })
          .where(eq(webhookDeliveries.id, row.id));
        logger.warn("Webhook delivery failed: attempts interrupted", {
          deliveryId: row.id,
          webhookId: row.webhookId,
        });
        continue;
      }
      const hook = hookById.get(row.webhookId);
      if (!hook || !hook.isActive || !hook.keyActive) {
        await tx
          .update(webhookDeliveries)
          .set({
            status: "failed",
            /** No request is made: undo the claim's increment. */
            attempts: row.attempts - 1,
            lastError: "webhook or its API key inactive at delivery time",
            updatedAt: now,
          })
          .where(eq(webhookDeliveries.id, row.id));
        logger.warn("Webhook delivery cancelled: webhook inactive", {
          deliveryId: row.id,
          webhookId: row.webhookId,
        });
        continue;
      }
      live.push(row);
    }

    return live.map((row) => {
      const hook = hookById.get(row.webhookId)!;
      return {
        id: row.id,
        webhookId: row.webhookId,
        event: row.event,
        payload: row.payload,
        /** Count before this attempt (the claim already added it). */
        attempts: row.attempts - 1,
        url: hook.url,
        secret: readWebhookSecret(hook.secret, hook.id),
      };
    });
  });
}

/**
 * Decrypts a webhook's stored signing secret (#259). A row from before
 * #259 still holds the plaintext until the boot pass encrypts it: used
 * as is, with a warning. A secret that does not decrypt (the key changed
 * or the value was tampered with) gives `null`, and the attempt fails
 * without sending: never a request signed with the wrong secret.
 */
function readWebhookSecret(stored: string, webhookId: string): string | null {
  if (!isEncryptedSecret(stored)) {
    logger.warn(
      "Webhook signing secret stored as plaintext: boot encrypter has not run",
      {
        webhookId,
      },
    );
    return stored;
  }
  try {
    return decryptSecret(stored, config.dkimEncryptionKey);
  } catch (error: unknown) {
    logger.error("Failed to decrypt webhook signing secret: delivery not sent", {
      webhookId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
