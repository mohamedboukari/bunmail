import type { WebhookDelivery } from "../models/webhook-delivery.schema.ts";

export interface SerializedWebhookDelivery {
  id: string;
  webhookId: string;
  event: string;
  status: string;
  attempts: number;
  lastError: string | null;
  lastResponseStatus: number | null;
  nextAttemptAt: Date;
  deliveredAt: Date | null;
  createdAt: Date;
}

/**
 * Trims the response shape to what the dashboard / API consumer
 * actually needs. The signed body bytes (`payload`) and the response
 * preview (`lastResponseBody`) are NOT included by default — they're
 * fat and contain customer data; expose them only on the per-id
 * detail view via {@link serializeWebhookDeliveryDetail}.
 */
export function serializeWebhookDelivery(
  row: WebhookDelivery,
): SerializedWebhookDelivery {
  return {
    id: row.id,
    webhookId: row.webhookId,
    event: row.event,
    status: row.status,
    attempts: row.attempts,
    lastError: row.lastError,
    lastResponseStatus: row.lastResponseStatus,
    nextAttemptAt: row.nextAttemptAt,
    deliveredAt: row.deliveredAt,
    createdAt: row.createdAt,
  };
}

export interface SerializedWebhookDeliveryDetail extends SerializedWebhookDelivery {
  /** The exact JSON bytes that were / will be POSTed. Useful for
   *  debugging signature verification on the consumer side. */
  payload: string;
  /** Truncated body preview from the most recent attempt's response,
   *  if the receiver returned one. */
  lastResponseBody: { bodyPreview?: string } | null;
}

export function serializeWebhookDeliveryDetail(
  row: WebhookDelivery,
): SerializedWebhookDeliveryDetail {
  return {
    ...serializeWebhookDelivery(row),
    payload: row.payload,
    lastResponseBody: row.lastResponseBody ?? null,
  };
}
