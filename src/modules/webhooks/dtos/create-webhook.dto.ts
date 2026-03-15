import { t } from "elysia";

/** Validation schema for POST /api/v1/webhooks. */
export const createWebhookDto = t.Object({
  /** HTTPS endpoint URL */
  url: t.String({ format: "uri" }),

  /** Event types to subscribe to */
  events: t.Array(
    t.Union([
      t.Literal("email.queued"),
      t.Literal("email.sent"),
      t.Literal("email.failed"),
      t.Literal("email.bounced"),
    ]),
    { minItems: 1 },
  ),
});
