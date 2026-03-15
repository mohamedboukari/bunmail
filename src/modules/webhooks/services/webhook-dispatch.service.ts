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
 * Signs a JSON payload with HMAC-SHA256 using the webhook's secret.
 * The signature is sent in the `X-BunMail-Signature` header so
 * consumers can verify the payload wasn't tampered with.
 */
function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
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
  const signature = signPayload(body, secret);

  for (let attempt = 1; attempt <= MAX_DISPATCH_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-BunMail-Signature": signature,
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
