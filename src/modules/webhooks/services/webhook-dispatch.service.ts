import { createHmac } from "crypto";
import { findWebhooksForEvent } from "./webhook.service.ts";
import { logger } from "../../../utils/logger.ts";
import type { WebhookEventType } from "../types/webhook.types.ts";

interface WebhookPayload {
  event: WebhookEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

const MAX_DISPATCH_ATTEMPTS = 3;

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
 */
export function signPayload(timestamp: string, body: string, secret: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/**
 * Dispatches a single event to one webhook URL with retries.
 * Exponential backoff: 1s, 2s, 4s.
 */
async function deliverToWebhook(
  url: string,
  secret: string,
  payload: WebhookPayload,
): Promise<void> {
  const body = JSON.stringify(payload);

  for (let attempt = 1; attempt <= MAX_DISPATCH_ATTEMPTS; attempt++) {
    /**
     * Freshly compute the signature timestamp per attempt so a long
     * retry chain doesn't ship a 12-minute-old signature that the
     * consumer's freshness check would then reject. Each retry has
     * its own valid signing window.
     */
    const sigTimestamp = Math.floor(Date.now() / 1000).toString();
    const signature = signPayload(sigTimestamp, body, secret);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-BunMail-Signature": signature,
          "X-BunMail-Timestamp": sigTimestamp,
          "X-BunMail-Event": payload.event,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });

      if (response.ok) {
        logger.debug("Webhook delivered", { url, event: payload.event, attempt });
        return;
      }

      logger.warn("Webhook delivery failed (non-2xx)", {
        url,
        status: response.status,
        attempt,
      });
    } catch (error) {
      logger.warn("Webhook delivery error", {
        url,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (attempt < MAX_DISPATCH_ATTEMPTS) {
      const backoff = Math.pow(2, attempt - 1) * 1000;
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  logger.error("Webhook delivery permanently failed", {
    url,
    event: payload.event,
  });
}

/**
 * Dispatches an event to all subscribed webhooks.
 * Fire-and-forget — errors are logged but don't block the caller.
 */
export function dispatchEvent(
  event: WebhookEventType,
  data: Record<string, unknown>,
): void {
  const payload: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    data,
  };

  findWebhooksForEvent(event)
    .then((hooks) => {
      if (hooks.length === 0) return;

      logger.debug("Dispatching webhook event", {
        event,
        webhookCount: hooks.length,
      });

      for (const hook of hooks) {
        deliverToWebhook(hook.url, hook.secret, payload).catch(() => {
          /* errors already logged inside deliverToWebhook */
        });
      }
    })
    .catch((error) => {
      logger.error("Failed to find webhooks for event", {
        event,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}
