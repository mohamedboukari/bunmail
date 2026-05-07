import { Elysia, t } from "elysia";
import { createSuppressionDto } from "./dtos/create-suppression.dto.ts";
import { listSuppressionsDto } from "./dtos/list-suppressions.dto.ts";
import { serializeSuppression } from "./serializations/suppression.serialization.ts";
import * as suppressionService from "./services/suppression.service.ts";
import { authMiddleware } from "../../middleware/auth.ts";
import { rateLimitMiddleware } from "../../middleware/rate-limit.ts";
import { logger } from "../../utils/logger.ts";
import { redactEmail } from "../../utils/redact.ts";

/**
 * Suppression list plugin — addresses we refuse to send to.
 *
 * Routes (all auth-required, scoped to the calling API key):
 * - POST   /                Manually add an address
 * - GET    /                Paginated list, optional exact-match `email` filter
 * - GET    /:id             Read one
 * - DELETE /:id             Remove (allows re-sending to the recipient)
 *
 * The actual send-time gate lives in `email.service.createEmail` — when
 * a recipient is on the list, that path throws `SuppressedRecipientError`
 * which the global `onError` handler maps to HTTP 422.
 */
export const suppressionsPlugin = new Elysia({
  prefix: "/api/v1/suppressions",
  normalize: true,
})
  .use(authMiddleware)
  .use(rateLimitMiddleware)

  .post(
    "/",
    async ({ body, apiKeyId }) => {
      logger.info("POST /api/v1/suppressions", {
        apiKeyId,
        email: redactEmail(body.email),
        reason: body.reason,
      });

      const expiresAt =
        body.expiresAt instanceof Date
          ? body.expiresAt
          : typeof body.expiresAt === "string"
            ? new Date(body.expiresAt)
            : null;

      const row = await suppressionService.createSuppression(apiKeyId, {
        email: body.email,
        reason: body.reason,
        expiresAt,
      });

      return { success: true, data: serializeSuppression(row) };
    },
    {
      body: createSuppressionDto,
      detail: {
        tags: ["Suppressions"],
        summary: "Add an address to the suppression list",
        description:
          "Idempotent — re-suppressing an existing address upserts the row. Subsequent sends to this recipient under this API key will return 422.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  .get(
    "/",
    async ({ query, apiKeyId }) => {
      logger.info("GET /api/v1/suppressions", { apiKeyId, ...query });

      const { data, total } = await suppressionService.listSuppressions(apiKeyId, {
        page: query.page ?? 1,
        limit: query.limit ?? 20,
        email: query.email,
      });

      return {
        success: true,
        data: data.map(serializeSuppression),
        pagination: {
          page: query.page ?? 1,
          limit: query.limit ?? 20,
          total,
        },
      };
    },
    {
      query: listSuppressionsDto,
      detail: {
        tags: ["Suppressions"],
        summary: "List suppressions",
        description:
          "Returns a paginated list of suppressed addresses for the current API key. Use the optional `email` query param for an exact-match lookup.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  .get(
    "/:id",
    async ({ params, apiKeyId, set }) => {
      logger.info("GET /api/v1/suppressions/:id", { apiKeyId, id: params.id });

      const row = await suppressionService.getSuppressionById(params.id, apiKeyId);
      if (!row) {
        set.status = 404;
        return { success: false, error: "Suppression not found" };
      }

      return { success: true, data: serializeSuppression(row) };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        tags: ["Suppressions"],
        summary: "Get a suppression by ID",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  .delete(
    "/:id",
    async ({ params, apiKeyId, set }) => {
      logger.info("DELETE /api/v1/suppressions/:id", { apiKeyId, id: params.id });

      const row = await suppressionService.deleteSuppression(params.id, apiKeyId);
      if (!row) {
        set.status = 404;
        return { success: false, error: "Suppression not found" };
      }

      return { success: true, data: serializeSuppression(row) };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        tags: ["Suppressions"],
        summary: "Remove a suppression",
        description:
          "Hard-deletes the suppression. The recipient becomes eligible for sends from this API key again immediately.",
        security: [{ bearerAuth: [] }],
      },
    },
  );
