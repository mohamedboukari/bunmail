import type { webhooks } from "../models/webhook.schema.ts";
import type { InferSelectModel } from "drizzle-orm";

/** Database row shape for the webhooks table. */
export type Webhook = InferSelectModel<typeof webhooks>;

/** Input for creating a new webhook via the API. */
export interface CreateWebhookInput {
  url: string;
  events: string[];
}

/**
 * Every webhook event type BunMail can fire, as a runtime list: the single
 * source of truth (#425). The `WebhookEventType` union is derived from it,
 * the REST create DTO (`dtos/create-webhook.dto.ts`) builds its literals
 * from it, and the dashboard's create form renders one checkbox per entry,
 * so adding a value here is all it takes to expose a new event everywhere.
 */
export const WEBHOOK_EVENT_TYPES = [
  "email.queued",
  "email.sent",
  "email.failed",
  "email.bounced",
  "email.complained",
  "email.received",
  "email.unsubscribed",
  /** A recorded open of a tracked email (#187), with `first` and `machine`. */
  "email.opened",
  /** A recorded click of a tracked email (#187), with the URL and link position. */
  "email.clicked",
  "domain.verified",
  "domain.verification_failed",
] as const;

/** One webhook event type BunMail can fire, derived from `WEBHOOK_EVENT_TYPES`. */
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];
