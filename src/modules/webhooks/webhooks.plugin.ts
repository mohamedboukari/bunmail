import { Elysia, t } from "elysia";
import { createWebhookDto } from "./dtos/create-webhook.dto.ts";
import { serializeWebhook } from "./serializations/webhook.serialization.ts";
import * as webhookService from "./services/webhook.service.ts";
import { authMiddleware } from "../../middleware/auth.ts";
import { rateLimitMiddleware } from "../../middleware/rate-limit.ts";
import { logger } from "../../utils/logger.ts";

/**
 * Webhooks plugin — registers webhook management routes under /api/v1/webhooks.
 *
 * Routes:
 * - POST /        → Register a new webhook endpoint
 * - GET /         → List webhooks for the current API key
 * - DELETE /:id   → Delete a webhook
 */
export const webhooksPlugin = new Elysia({
  prefix: "/api/v1/webhooks",
  normalize: true,
})
  .use(authMiddleware)
  .use(rateLimitMiddleware)

  .post(
    "/",
    async (context) => {
      const { body, apiKeyId } = context as typeof context & { apiKeyId: string };

      logger.info("POST /api/v1/webhooks", { url: body.url, events: body.events });

      const { webhook, secret } = await webhookService.createWebhook(
        { url: body.url, events: body.events },
        apiKeyId,
      );

      return {
        success: true,
        data: {
          ...serializeWebhook(webhook),
          secret,
        },
      };
    },
    { body: createWebhookDto },
  )

  .get("/", async (context) => {
    const { apiKeyId } = context as typeof context & { apiKeyId: string };

    const hooks = await webhookService.listWebhooks(apiKeyId);

    return {
      success: true,
      data: hooks.map(serializeWebhook),
    };
  })

  .delete(
    "/:id",
    async (context) => {
      const { params, set, apiKeyId } = context as typeof context & { apiKeyId: string };

      const webhook = await webhookService.deleteWebhook(params.id, apiKeyId);

      if (!webhook) {
        set.status = 404;
        return { success: false, error: "Webhook not found" };
      }

      return {
        success: true,
        data: serializeWebhook(webhook),
      };
    },
    {
      params: t.Object({ id: t.String() }),
    },
  );
