import { createHmac } from "crypto";
import { findWebhooksForEvent } from "./webhook.service.ts";
import { enqueueDelivery } from "./webhook-delivery.service.ts";
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
 * be replayed indefinitely against the receiver — consumers should
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
 * Dispatches an event to all subscribed webhooks.
 *
 * As of #30, this is a synchronous **enqueue** — for each subscribed
 * webhook, one row is INSERTed into `webhook_deliveries` at
 * `status='pending'`. The actual HTTP POST is performed by the
 * delivery worker poll loop in `webhook-delivery-worker.service.ts`.
 *
 * Why durably enqueue instead of in-memory retry:
 *   - A server restart no longer loses pending events; rows survive
 *     reboot and the next poll picks them up.
 *   - Consumer outages longer than ~7s no longer burn through retries
 *     before the consumer recovers; the worker retries over hours.
 *   - Operators get inspection + replay via the dashboard / REST API.
 *
 * Still **fire-and-forget** from the caller's perspective: callers
 * (queue.service.ts on `email.sent`, bounce-handler on `email.bounced`,
 * etc.) don't await this — errors are logged, never thrown.
 */
export function dispatchEvent(
  event: WebhookEventType,
  data: Record<string, unknown>,
): void {
  const envelope: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    data,
  };

  findWebhooksForEvent(event)
    .then(async (hooks) => {
      if (hooks.length === 0) return;

      logger.debug("Enqueuing webhook event", {
        event,
        webhookCount: hooks.length,
      });

      /** Enqueue one row per subscribed webhook. Errors at the row
       *  level shouldn't abort the others — log and continue. */
      await Promise.allSettled(
        hooks.map(async (hook) => {
          try {
            await enqueueDelivery({ webhookId: hook.id, envelope });
          } catch (err) {
            logger.error("Failed to enqueue webhook delivery", {
              event,
              webhookId: hook.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }),
      );
    })
    .catch((error) => {
      logger.error("Failed to find webhooks for event", {
        event,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}
