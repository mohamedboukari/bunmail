import { Elysia, t } from "elysia";
import { serializeInboundEmail } from "./serializations/inbound.serialization.ts";
import * as inboundService from "./services/inbound.service.ts";
import { authMiddleware } from "../../middleware/auth.ts";
import { rateLimitMiddleware } from "../../middleware/rate-limit.ts";
import { logger } from "../../utils/logger.ts";

/**
 * Inbound emails plugin — API for received emails under /api/v1/inbound.
 *
 * Routes:
 * - GET    /                  → List inbound emails (excludes trashed)
 * - GET    /trash             → List trashed inbound emails
 * - GET    /:id               → Get a single inbound email by ID (excludes trashed)
 * - DELETE /:id               → Move inbound email to trash
 * - POST   /bulk-delete       → Bulk-trash inbound emails
 * - POST   /:id/restore       → Restore a trashed inbound email
 * - DELETE /:id/permanent     → Permanently delete a trashed inbound email
 * - POST   /trash/empty       → Permanently delete all trashed inbound emails
 */
export const inboundPlugin = new Elysia({
  prefix: "/api/v1/inbound",
  normalize: true,
})
  .use(authMiddleware)
  .use(rateLimitMiddleware)

  /**
   * GET /api/v1/inbound
   * Returns a paginated list of received emails (newest first, no trashed).
   */
  .get(
    "/",
    async ({ query }) => {
      const page = query.page ?? 1;
      const limit = query.limit ?? 20;

      logger.info("GET /api/v1/inbound", { page, limit });

      const { data, total } = await inboundService.listInboundEmails({ page, limit });

      return {
        success: true,
        data: data.map(serializeInboundEmail),
        pagination: { page, limit, total },
      };
    },
    {
      query: t.Object({
        page: t.Optional(t.Number({ minimum: 1 })),
        limit: t.Optional(t.Number({ minimum: 1, maximum: 100 })),
      }),
      detail: {
        tags: ["Inbound"],
        summary: "List inbound emails",
        description: "Returns a paginated list of received emails, newest first.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  /**
   * GET /api/v1/inbound/trash
   * Trashed inbound emails — auto-purged after TRASH_RETENTION_DAYS days.
   * Defined before /:id so the segment doesn't match it.
   */
  .get(
    "/trash",
    async ({ query }) => {
      const page = query.page ?? 1;
      const limit = query.limit ?? 20;

      logger.info("GET /api/v1/inbound/trash", { page, limit });

      const { data, total } = await inboundService.listTrashedInboundEmails({
        page,
        limit,
      });

      return {
        success: true,
        data: data.map(serializeInboundEmail),
        pagination: { page, limit, total },
      };
    },
    {
      query: t.Object({
        page: t.Optional(t.Number({ minimum: 1 })),
        limit: t.Optional(t.Number({ minimum: 1, maximum: 100 })),
      }),
      detail: {
        tags: ["Inbound"],
        summary: "List trashed inbound emails",
        description:
          "Trashed inbound emails are permanently purged after TRASH_RETENTION_DAYS days.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  .get(
    "/:id",
    async ({ params, set }) => {
      logger.info("GET /api/v1/inbound/:id", { id: params.id });

      const email = await inboundService.getInboundEmailById(params.id);

      if (!email) {
        set.status = 404;
        return { success: false, error: "Inbound email not found" };
      }

      return { success: true, data: serializeInboundEmail(email) };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        tags: ["Inbound"],
        summary: "Get inbound email by ID",
        description: "Returns a single inbound email by its ID.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  /**
   * DELETE /api/v1/inbound/:id
   * Soft-deletes (moves to trash). Auto-purged after retention window.
   */
  .delete(
    "/:id",
    async ({ params, set }) => {
      logger.info("DELETE /api/v1/inbound/:id", { id: params.id });

      const email = await inboundService.trashInboundEmail(params.id);

      if (!email) {
        set.status = 404;
        return { success: false, error: "Inbound email not found" };
      }

      return { success: true, data: serializeInboundEmail(email) };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        tags: ["Inbound"],
        summary: "Move inbound email to trash",
        description: "Soft-deletes; restorable within the retention window.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  /**
   * POST /api/v1/inbound/bulk-delete
   * Bulk soft-delete by IDs. POST so request bodies aren't stripped.
   */
  .post(
    "/bulk-delete",
    async ({ body }) => {
      logger.info("POST /api/v1/inbound/bulk-delete", { count: body.ids.length });

      const deleted = await inboundService.trashInboundEmails(body.ids);

      return { success: true, deleted };
    },
    {
      body: t.Object({
        ids: t.Array(t.String(), { minItems: 1, maxItems: 100 }),
      }),
      detail: {
        tags: ["Inbound"],
        summary: "Bulk move inbound emails to trash",
        description: "Soft-deletes up to 100 inbound emails in one call.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  /**
   * POST /api/v1/inbound/:id/restore
   * Restores a trashed inbound email.
   */
  .post(
    "/:id/restore",
    async ({ params, set }) => {
      logger.info("POST /api/v1/inbound/:id/restore", { id: params.id });

      const email = await inboundService.restoreInboundEmail(params.id);

      if (!email) {
        set.status = 404;
        return { success: false, error: "Trashed inbound email not found" };
      }

      return { success: true, data: serializeInboundEmail(email) };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        tags: ["Inbound"],
        summary: "Restore a trashed inbound email",
        description: "Clears the deletion marker.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  /**
   * DELETE /api/v1/inbound/:id/permanent
   * Hard-deletes a trashed inbound email immediately.
   */
  .delete(
    "/:id/permanent",
    async ({ params, set }) => {
      logger.info("DELETE /api/v1/inbound/:id/permanent", { id: params.id });

      const email = await inboundService.permanentDeleteInboundEmail(params.id);

      if (!email) {
        set.status = 404;
        return { success: false, error: "Trashed inbound email not found" };
      }

      return { success: true, data: serializeInboundEmail(email) };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        tags: ["Inbound"],
        summary: "Permanently delete a trashed inbound email",
        description: "Irreversible.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  /**
   * POST /api/v1/inbound/trash/empty
   * Permanently deletes every trashed inbound email.
   */
  .post(
    "/trash/empty",
    async () => {
      logger.info("POST /api/v1/inbound/trash/empty");

      const deleted = await inboundService.emptyInboundTrash();

      return { success: true, deleted };
    },
    {
      detail: {
        tags: ["Inbound"],
        summary: "Empty the inbound trash",
        description: "Permanently deletes all trashed inbound emails.",
        security: [{ bearerAuth: [] }],
      },
    },
  );
