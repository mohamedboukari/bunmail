import { Elysia, t } from "elysia";
import { createWebhookDto } from "./dtos/create-webhook.dto.ts";
import { listDeliveriesQueryDto } from "./dtos/list-deliveries.dto.ts";
import { serializeWebhook } from "./serializations/webhook.serialization.ts";
import {
  serializeWebhookDelivery,
  serializeWebhookDeliveryDetail,
} from "./serializations/webhook-delivery.serialization.ts";
import * as webhookService from "./services/webhook.service.ts";
import * as webhookDeliveryService from "./services/webhook-delivery.service.ts";
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
    async ({ body, apiKeyId }) => {
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
    {
      body: createWebhookDto,
      detail: {
        tags: ["Webhooks"],
        summary: "Create webhook",
        description:
          "Registers a new webhook endpoint. Returns the signing secret once — store it securely.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  .get(
    "/",
    async ({ apiKeyId }) => {
      const hooks = await webhookService.listWebhooks(apiKeyId);

      return {
        success: true,
        data: hooks.map(serializeWebhook),
      };
    },
    {
      detail: {
        tags: ["Webhooks"],
        summary: "List webhooks",
        description: "Returns all webhooks for the current API key.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  .delete(
    "/:id",
    async ({ params, set, apiKeyId }) => {
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
      detail: {
        tags: ["Webhooks"],
        summary: "Delete webhook",
        description: "Removes a webhook endpoint.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  /**
   * GET /api/v1/webhooks/:id/deliveries — paginated history of every
   * delivery attempt for one webhook (#30). Operators use this to
   * answer "did event X make it through?" without grepping logs.
   */
  .get(
    "/:id/deliveries",
    async ({ params, query, apiKeyId, set }) => {
      const page = query.page ? parseInt(query.page, 10) : 1;
      const limit = query.limit ? parseInt(query.limit, 10) : 20;
      const status =
        query.status === "pending" ||
        query.status === "delivered" ||
        query.status === "failed"
          ? query.status
          : undefined;

      const { data, total } = await webhookDeliveryService.listDeliveriesForWebhook({
        webhookId: params.id,
        apiKeyId,
        status,
        page,
        limit,
      });

      /** If the lookup turned up empty AND the webhook itself doesn't
       *  exist for this api key, surface 404 rather than an empty list
       *  — otherwise the caller can't distinguish "no deliveries yet"
       *  from "wrong id / wrong key". */
      if (data.length === 0 && total === 0) {
        const ownsWebhook = await webhookService.findWebhookById(params.id, apiKeyId);
        if (!ownsWebhook) {
          set.status = 404;
          return { success: false, error: "Webhook not found" };
        }
      }

      return {
        success: true,
        data: data.map(serializeWebhookDelivery),
        pagination: { page, limit, total },
      };
    },
    {
      params: t.Object({ id: t.String() }),
      query: listDeliveriesQueryDto,
      detail: {
        tags: ["Webhooks"],
        summary: "List webhook deliveries",
        description:
          "Returns paginated delivery attempts for a webhook. Filter by `?status=pending|delivered|failed`.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  /**
   * GET /api/v1/webhooks/deliveries/:deliveryId — full detail of one
   * attempt, including the request body bytes (for signature
   * debugging) and the truncated response preview.
   */
  .get(
    "/deliveries/:deliveryId",
    async ({ params, set, apiKeyId }) => {
      const row = await webhookDeliveryService.getDeliveryById({
        deliveryId: params.deliveryId,
        apiKeyId,
      });
      if (!row) {
        set.status = 404;
        return { success: false, error: "Delivery not found" };
      }
      return { success: true, data: serializeWebhookDeliveryDetail(row) };
    },
    {
      params: t.Object({ deliveryId: t.String() }),
      detail: {
        tags: ["Webhooks"],
        summary: "Get webhook delivery",
        description:
          "Returns one delivery attempt with the exact body bytes that were POSTed and the receiver's response preview.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  /**
   * POST /api/v1/webhooks/deliveries/:deliveryId/replay — manually
   * retry a failed (or stuck) delivery. Resets attempts to 0 and flips
   * status back to pending; the worker re-attempts on the next poll.
   */
  .post(
    "/deliveries/:deliveryId/replay",
    async ({ params, set, apiKeyId }) => {
      const updated = await webhookDeliveryService.replayDelivery({
        deliveryId: params.deliveryId,
        apiKeyId,
      });
      if (!updated) {
        set.status = 404;
        return { success: false, error: "Delivery not found" };
      }
      logger.info("Webhook delivery replay queued", {
        deliveryId: updated.id,
        webhookId: updated.webhookId,
      });
      return { success: true, data: serializeWebhookDeliveryDetail(updated) };
    },
    {
      params: t.Object({ deliveryId: t.String() }),
      detail: {
        tags: ["Webhooks"],
        summary: "Replay webhook delivery",
        description:
          "Resets a delivery to `pending` so the worker re-attempts it on the next poll. Useful for retrying after fixing a consumer-side bug.",
        security: [{ bearerAuth: [] }],
      },
    },
  );
