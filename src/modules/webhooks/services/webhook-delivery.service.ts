/**
 * Webhook delivery service (#30).
 *
 * Replaces the old in-memory retry loop in `webhook-dispatch.service.ts`
 * with a durable, DB-backed queue. Three concerns live here:
 *
 *   1. **Enqueue.** Not here: `enqueueEvent` (webhook-dispatch.service.ts)
 *      inserts one `pending` row per subscribed webhook, inside the
 *      transaction of the state change the event describes (#184).
 *   2. **Claim + send.** `claimAndDeliverDueAttempts` pulls the next N
 *      due rows atomically (FOR UPDATE SKIP LOCKED: same pattern as
 *      the email queue claim from #20), POSTs each one, and updates
 *      the row to `delivered`, rescheduled, or `failed`.
 *   3. **Replay.** `replayDelivery` flips a `failed` row back to
 *      `pending` so the next poll re-attempts it. Operator-driven via
 *      the dashboard / API.
 *
 * Retry schedule (see {@link RETRY_BACKOFF_MINUTES}): waits of 1m, 5m,
 * 15m and 1h between attempts, so 5 attempts over about 80 minutes.
 * After the 5th failed attempt the row settles at `failed`. Finished rows
 * (`delivered` and `failed`) get reaped by the retention cleanup after
 * `WEBHOOK_DELIVERY_RETENTION_DAYS` (see {@link purgeOldDeliveries}).
 *
 * The signature is NOT stored on the row: it's recomputed per attempt
 * with a fresh timestamp so an hour-old retry doesn't ship a stale
 * signature that the consumer's freshness window (5 min default) would
 * reject. Body bytes are stored verbatim once at enqueue time.
 */

/**
 * The service's public surface (#387). The code lives in one file per
 * concern, beside this one:
 *
 *   - `webhook-delivery-schedule.service.ts`: the retry backoff and attempt cap
 *   - `webhook-delivery-claim.service.ts`: the fair claim and the signing secret
 *   - `webhook-delivery-attempt.service.ts`: one HTTP attempt behind the SSRF guard
 *   - `webhook-delivery-query.service.ts`: list, get and replay, scoped by API key
 *   - `webhook-delivery-outcome.service.ts`: recording an attempt's outcome
 *   - `webhook-delivery-retention.service.ts`: the retention purge
 *
 * Importers keep using this module.
 */
export {
  RETRY_BACKOFF_MINUTES,
  MAX_DELIVERY_ATTEMPTS,
  nextAttemptAt,
} from "./webhook-delivery-schedule.service.ts";
export { claimDueDeliveries } from "./webhook-delivery-claim.service.ts";
export { performHttpAttempt } from "./webhook-delivery-attempt.service.ts";
export {
  listDeliveriesForWebhook,
  getDeliveryById,
  replayDelivery,
} from "./webhook-delivery-query.service.ts";
export { recordAttempt } from "./webhook-delivery-outcome.service.ts";
export { purgeOldDeliveries } from "./webhook-delivery-retention.service.ts";
