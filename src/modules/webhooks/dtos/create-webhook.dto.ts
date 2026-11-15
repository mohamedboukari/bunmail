import { t } from "elysia";
import { WEBHOOK_EVENT_TYPES } from "../types/webhook.types.ts";

/** Validation schema for POST /api/v1/webhooks. */
export const createWebhookDto = t.Object({
  /** HTTPS endpoint URL */
  url: t.String({ format: "uri" }),

  /**
   * Event types to subscribe to: one literal per entry of
   * `WEBHOOK_EVENT_TYPES` (#425), so the accepted set can never drift from
   * the events BunMail fires. The schema is the same union of string
   * literals the hand-written list produced, so the REST contract and the
   * OpenAPI document are unchanged.
   */
  events: t.Array(t.Union(WEBHOOK_EVENT_TYPES.map((event) => t.Literal(event))), {
    minItems: 1,
  }),
});
