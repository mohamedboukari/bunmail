import { createHmac } from "crypto";
import { sql, type SQL } from "drizzle-orm";
import type { Tx } from "../../../db/index.ts";
import { apiKeys } from "../../api-keys/models/api-key.schema.ts";
import { webhookDeliveries } from "../models/webhook-delivery.schema.ts";
import { webhooks } from "../models/webhook.schema.ts";
import { toWebhookEnqueueError } from "../errors.ts";
import { logger } from "../../../utils/logger.ts";
import type { WebhookEventType } from "../types/webhook.types.ts";

interface WebhookPayload {
  event: WebhookEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

/**
 * Signs the dispatch envelope with HMAC-SHA256 using the webhook's secret.
 *
 * The signature input is `<unix-seconds-timestamp>.<json-body>`, sent
 * alongside the timestamp in `X-BunMail-Timestamp`. This binds the
 * signature to a specific dispatch time so a captured payload cannot
 * be replayed indefinitely against the receiver: consumers should
 * reject any request whose timestamp drifts beyond a tolerance window
 * (5 minutes is the recommended default; see `docs/webhooks.md`).
 *
 * Stripe / Slack use the same construction. The string form is stable
 * and easy to reproduce in any language without parsing the JSON.
 *
 * Re-exported by `webhook-delivery.service.ts` so the worker can sign
 * each retry attempt with a fresh timestamp.
 */
export function signPayload(timestamp: string, body: string, secret: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/**
 * Who an event may be delivered to.
 *
 * - `{ apiKeyId }`: an event about one API key's email (`email.sent`,
 *   `email.failed`, `email.bounced`, `email.complained`,
 *   `email.unsubscribed`). Only that key's webhooks receive it.
 * - `{ adminOnly: true }`: an event with no owning key (`email.received`,
 *   `domain.verified`, `domain.verification_failed`: domains and inbound
 *   mail aren't owned by a key). Only webhooks owned by admin keys receive
 *   it, matching the admin-only inbound and domains APIs (#130, #250).
 */
export type DispatchScope = { apiKeyId: string } | { adminOnly: true };

/**
 * The webhooks that receive `event` in `scope`, as a `WHERE` condition on
 * `webhooks` joined to its `api_keys` row: active webhooks of an active
 * key (revoking a leaked key also cuts off the event feed its holder
 * registered), subscribed to the event, owned by the scope's key or by an
 * admin key. The event is matched in SQL (#173): `events` holds real JSON
 * since #261, and the array is built from a plain parameter (see
 * `src/db/jsonb.ts`). The owner filter is served by
 * `webhooks_api_key_id_idx` (#313).
 */
function matchingWebhooks(event: WebhookEventType, scope: DispatchScope): SQL {
  const owner =
    "apiKeyId" in scope
      ? sql`${webhooks.apiKeyId} = ${scope.apiKeyId}`
      : sql`${apiKeys.isAdmin} = true`;
  return sql`${webhooks.isActive} = true
    AND ${apiKeys.isActive} = true
    AND ${webhooks.events} @> jsonb_build_array(${event}::text)
    AND ${owner}`;
}

/**
 * Enqueues `event` for every webhook that receives it, inside the caller's
 * transaction: the webhook outbox (#184).
 *
 * The caller opens one transaction for the state change the event
 * describes (an email row's outcome, a suppression, an inbound row) and
 * this insert, so both commit together or neither does. Before, the state
 * change committed first and the delivery rows were written afterwards,
 * fire-and-forget: a crash or a failed insert in between lost the event
 * for good, with nothing to detect it. The `Tx` parameter makes the
 * transaction a requirement, not a convention: `db` itself does not fit.
 *
 * Fan-out happens here, at write time, in ONE statement:
 * `INSERT INTO webhook_deliveries ... SELECT ... FROM webhooks`, one
 * `pending` row per matching webhook. The match is an index probe on the
 * owning key (#313) and a key has at most `WEBHOOKS_MAX_PER_API_KEY`
 * webhooks (#258), so the statement stays short inside the caller's
 * transaction, and the delivery worker, replay and the dashboard keep
 * working on `webhook_deliveries` rows unchanged. No matching webhook
 * inserts nothing, which is success.
 *
 * The body is serialized once here (it is what the worker POSTs and
 * re-signs per attempt) and bound as one text parameter; the webhook's
 * secret is not read. Delivery ids are `wdl_` plus 32 hex characters
 * from `gen_random_uuid()`, generated per row by the database.
 *
 * Throws `WebhookEnqueueError` (SQLSTATE only, never the payload) when
 * the insert fails; the caller's transaction then rolls back, state change
 * included, and the caller handles it like any failed write.
 *
 * @returns How many delivery rows were enqueued.
 */
export async function enqueueEvent(
  tx: Tx,
  event: WebhookEventType,
  data: Record<string, unknown>,
  /** Who may receive it: the owning API key, or admin keys only. See DispatchScope. */
  scope: DispatchScope,
): Promise<number> {
  const envelope: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    data,
  };
  const body = JSON.stringify(envelope);

  /** Bare column names: an INSERT column list takes no table qualifier. */
  const column = (name: string) => sql.identifier(name);
  let rows: Record<string, unknown>[];
  try {
    rows = await tx.execute(sql`
      INSERT INTO ${webhookDeliveries} (
        ${column(webhookDeliveries.id.name)},
        ${column(webhookDeliveries.webhookId.name)},
        ${column(webhookDeliveries.event.name)},
        ${column(webhookDeliveries.payload.name)}
      )
      SELECT
        'wdl_' || replace(gen_random_uuid()::text, '-', ''),
        ${webhooks.id},
        ${event}::varchar,
        ${body}::text
      FROM ${webhooks}
      INNER JOIN ${apiKeys} ON ${apiKeys.id} = ${webhooks.apiKeyId}
      WHERE ${matchingWebhooks(event, scope)}
      RETURNING ${column(webhookDeliveries.id.name)}`);
  } catch (error) {
    throw toWebhookEnqueueError(event, error);
  }

  logger.debug("Webhook event enqueued", { event, deliveries: rows.length });
  return rows.length;
}
