import { Elysia, t } from "elysia";
import {
  serializeInboundAttachment,
  serializeInboundEmail,
} from "./serializations/inbound.serialization.ts";
import * as inboundService from "./services/inbound.service.ts";
import {
  getInboundAttachment,
  listInboundAttachments,
  parseAttachmentPosition,
} from "./services/inbound-attachments.service.ts";
import { attachmentDownloadHeaders } from "../emails/services/attachments.ts";
import { authMiddleware, adminMiddleware } from "../../middleware/auth.ts";
import { rateLimitMiddleware } from "../../middleware/rate-limit.ts";
import { logger } from "../../utils/logger.ts";

/**
 * Inbound emails plugin: API for received emails under /api/v1/inbound.
 *
 * Routes:
 * - GET    /                  → List inbound emails (excludes trashed)
 * - GET    /trash             → List trashed inbound emails
 * - GET    /:id               → Get a single inbound email by ID (excludes trashed)
 * - GET    /:id/attachments   → List its attachments (#486)
 * - GET    /:id/attachments/:position → Download one attachment (#486)
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
  /**
   * Inbound mail is unscoped (every domain's received mail) and operator-level,
   * so it's admin-only (#130). Restricted keys get 403 rather than being able to
   * read/delete everyone's inbound. Dashboard reads inbound via the service
   * directly under operator session auth, unaffected by this gate.
   */
  .use(adminMiddleware)
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
        data: data.map((email) => serializeInboundEmail(email)),
        pagination: { page, limit, total },
      };
    },
    {
      query: t.Object({
        page: t.Optional(t.Number({ minimum: 1, maximum: 1_000_000 })),
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
   * Trashed inbound emails: auto-purged after TRASH_RETENTION_DAYS days.
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
        data: data.map((email) => serializeInboundEmail(email)),
        pagination: { page, limit, total },
      };
    },
    {
      query: t.Object({
        page: t.Optional(t.Number({ minimum: 1, maximum: 1_000_000 })),
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

      const attachments = await listInboundAttachments(email);
      return { success: true, data: serializeInboundEmail(email, attachments) };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        tags: ["Inbound"],
        summary: "Get inbound email by ID",
        description:
          "Returns a single inbound email by its ID, with its attachment metadata.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  /**
   * GET /api/v1/inbound/:id/attachments (#486)
   * Attachment metadata, parsed from the stored raw message. Trashed
   * emails are excluded, like GET /:id.
   */
  .get(
    "/:id/attachments",
    async ({ params, set }) => {
      const email = await inboundService.getInboundEmailById(params.id);
      if (!email) {
        logger.info("Inbound attachments: email not found", {
          inboundEmailId: params.id,
        });
        set.status = 404;
        return { success: false, error: "Inbound email not found" };
      }

      const attachments = await listInboundAttachments(email);
      logger.info("Inbound attachments listed", {
        inboundEmailId: email.id,
        count: attachments.length,
      });
      return { success: true, data: attachments.map(serializeInboundAttachment) };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        tags: ["Inbound"],
        summary: "List attachments of an inbound email",
        description:
          "Returns the attachments of a received email: position, filename, content type, size and inline Content-ID.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  /**
   * GET /api/v1/inbound/:id/attachments/:position (#486)
   * Downloads one attachment. Always served as an `application/octet-stream`
   * attachment with a sandbox CSP: the sender chose the bytes and the type.
   */
  .get(
    "/:id/attachments/:position",
    async ({ params, set }) => {
      const position = parseAttachmentPosition(params.position);
      const email =
        position === null
          ? undefined
          : await inboundService.getInboundEmailById(params.id);
      const attachment =
        email === undefined || position === null
          ? undefined
          : await getInboundAttachment(email, position);

      if (!attachment) {
        logger.info("Inbound attachment download: not found", {
          inboundEmailId: params.id,
          position,
        });
        set.status = 404;
        return { success: false, error: "Attachment not found" };
      }

      /** Size only: the filename may carry personal data. */
      logger.info("Inbound attachment downloaded", {
        inboundEmailId: params.id,
        position,
        sizeBytes: attachment.sizeBytes,
      });
      return new Response(attachment.content, {
        headers: attachmentDownloadHeaders(attachment.filename),
      });
    },
    {
      params: t.Object({ id: t.String(), position: t.String() }),
      detail: {
        tags: ["Inbound"],
        summary: "Download an attachment of an inbound email",
        description:
          "Returns the attachment bytes as application/octet-stream with a forced attachment disposition.",
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
