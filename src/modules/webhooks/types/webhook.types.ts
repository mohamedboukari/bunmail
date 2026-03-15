import type { webhooks } from "../models/webhook.schema.ts";
import type { InferSelectModel } from "drizzle-orm";

/** Database row shape for the webhooks table. */
export type Webhook = InferSelectModel<typeof webhooks>;

/** Input for creating a new webhook via the API. */
export interface CreateWebhookInput {
  url: string;
  events: string[];
}

/** All webhook event types BunMail can fire */
export type WebhookEventType =
  | "email.queued"
  | "email.sent"
  | "email.failed"
  | "email.bounced";
