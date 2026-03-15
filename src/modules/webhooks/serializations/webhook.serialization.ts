import type { Webhook } from "../types/webhook.types.ts";

export interface SerializedWebhook {
  id: string;
  url: string;
  events: string[];
  isActive: boolean;
  createdAt: Date;
}

/**
 * Strips the signing secret — never expose it in list/get responses.
 * The secret is only shown once at creation time.
 */
export function serializeWebhook(webhook: Webhook): SerializedWebhook {
  return {
    id: webhook.id,
    url: webhook.url,
    events: webhook.events,
    isActive: webhook.isActive,
    createdAt: webhook.createdAt,
  };
}
