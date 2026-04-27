import { t } from "elysia";

/** Validation schema for POST /api/v1/webhooks. */
export const createWebhookDto = t.Object({
  /** HTTPS endpoint URL */
  url: t.String({ format: "uri" }),

  /**
   * Event types to subscribe to. Must mirror the `WebhookEventType` union
   * in `types/webhook.types.ts` — TypeBox literals can't be derived from
   * a TypeScript type, so the two are kept in sync manually.
   */
  events: t.Array(
    t.Union([
      t.Literal("email.queued"),
      t.Literal("email.sent"),
      t.Literal("email.failed"),
      t.Literal("email.bounced"),
      t.Literal("email.complained"),
      t.Literal("email.received"),
    ]),
    { minItems: 1 },
  ),
});
