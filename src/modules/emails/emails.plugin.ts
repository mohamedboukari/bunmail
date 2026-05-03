import { Elysia, t } from "elysia";
import { sendEmailDto } from "./dtos/send-email.dto.ts";
import { listEmailsDto } from "./dtos/list-emails.dto.ts";
import { serializeEmail } from "./serializations/email.serialization.ts";
import * as emailService from "./services/email.service.ts";
import { authMiddleware } from "../../middleware/auth.ts";
import { rateLimitMiddleware } from "../../middleware/rate-limit.ts";
import { logger } from "../../utils/logger.ts";
import { redactEmail } from "../../utils/redact.ts";

/**
 * Emails plugin — registers all email-related routes under /api/v1/emails.
 *
 * Routes:
 * - POST /send                  → Queue a new email for delivery
 * - GET  /                      → List emails (excludes trashed)
 * - GET  /trash                 → List trashed emails
 * - GET  /:id                   → Get a single email by ID (excludes trashed)
 * - DELETE /:id                 → Move email to trash
 * - POST /bulk-delete           → Bulk-trash emails (body: {ids: string[]})
 * - POST /:id/restore           → Restore a trashed email
 * - DELETE /:id/permanent       → Permanently delete a trashed email
 * - POST /trash/empty           → Permanently delete all trashed emails for this key
 *
 * All routes are protected by Bearer token auth and rate limiting.
 */
export const emailsPlugin = new Elysia({
  prefix: "/api/v1/emails",
  /** Normalize URLs — /api/v1/emails and /api/v1/emails/ both work */
  normalize: true,
})
  /** Apply auth middleware — all routes in this plugin require a valid Bearer token */
  .use(authMiddleware)
  /** Apply rate limiting — 100 requests per 60 seconds per API key */
  .use(rateLimitMiddleware)

  /**
   * POST /api/v1/emails/send
   *
   * Accepts email content in the request body, validates it against
   * the sendEmailDto schema, inserts it into the DB with status "queued",
   * and returns the serialized email. The queue processor will handle
   * actual SMTP delivery asynchronously.
   */
  .post(
    "/send",
    async ({ body, apiKeyId }) => {
      logger.info("POST /api/v1/emails/send", { apiKeyId, to: redactEmail(body.to) });

      /** Create the email record — it starts in "queued" status */
      const email = await emailService.createEmail(body, apiKeyId);

      return {
        success: true,
        data: serializeEmail(email),
      };
    },
    {
      body: sendEmailDto,
      detail: {
        tags: ["Emails"],
        summary: "Send an email",
        description:
          "Queue a new email for delivery. The email is inserted with status 'queued' and the queue processor handles SMTP delivery asynchronously.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  .get(
    "/",
    async ({ query, apiKeyId }) => {
      logger.info("GET /api/v1/emails", { apiKeyId, ...query });

      const { data, total } = await emailService.listEmails(apiKeyId, {
        page: query.page ?? 1,
        limit: query.limit ?? 20,
        status: query.status,
      });

      return {
        success: true,
        data: data.map(serializeEmail),
        pagination: {
          page: query.page ?? 1,
          limit: query.limit ?? 20,
          total,
        },
      };
    },
    {
      query: listEmailsDto,
      detail: {
        tags: ["Emails"],
        summary: "List emails",
        description:
          "Returns a paginated list of emails for the current API key. Supports optional status filter.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  /**
   * GET /api/v1/emails/trash
   *
   * Lists emails currently in trash (soft-deleted but not yet purged).
   * Newest-trashed first. Defined before /:id so it doesn't get caught
   * by the dynamic-segment route.
   */
  .get(
    "/trash",
    async ({ query, apiKeyId }) => {
      logger.info("GET /api/v1/emails/trash", { apiKeyId, ...query });

      const { data, total } = await emailService.listTrashedEmails(apiKeyId, {
        page: query.page ?? 1,
        limit: query.limit ?? 20,
      });

      return {
        success: true,
        data: data.map(serializeEmail),
        pagination: {
          page: query.page ?? 1,
          limit: query.limit ?? 20,
          total,
        },
      };
    },
    {
      query: t.Object({
        page: t.Optional(t.Number({ minimum: 1 })),
        limit: t.Optional(t.Number({ minimum: 1, maximum: 100 })),
      }),
      detail: {
        tags: ["Emails"],
        summary: "List trashed emails",
        description:
          "Returns emails currently in trash. Trashed emails are auto-purged after TRASH_RETENTION_DAYS days.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  .get(
    "/:id",
    async ({ params, apiKeyId, set }) => {
      logger.info("GET /api/v1/emails/:id", { emailId: params.id, apiKeyId });

      const email = await emailService.getEmailById(params.id, apiKeyId);

      if (!email) {
        set.status = 404;
        return {
          success: false,
          error: "Email not found",
        };
      }

      return {
        success: true,
        data: serializeEmail(email),
      };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      detail: {
        tags: ["Emails"],
        summary: "Get email by ID",
        description: "Returns a single email by its ID. Scoped to the current API key.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  /**
   * DELETE /api/v1/emails/:id
   *
   * Soft-deletes (moves to trash). Idempotent. The email is auto-purged
   * after TRASH_RETENTION_DAYS days unless restored before then.
   */
  .delete(
    "/:id",
    async ({ params, apiKeyId, set }) => {
      logger.info("DELETE /api/v1/emails/:id", { emailId: params.id, apiKeyId });

      const email = await emailService.trashEmail(params.id, apiKeyId);

      if (!email) {
        set.status = 404;
        return { success: false, error: "Email not found" };
      }

      return { success: true, data: serializeEmail(email) };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        tags: ["Emails"],
        summary: "Move email to trash",
        description:
          "Soft-deletes the email. It can be restored within TRASH_RETENTION_DAYS days before being permanently purged.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  /**
   * POST /api/v1/emails/bulk-delete
   *
   * Bulk soft-delete. POST (not DELETE) because some HTTP clients/proxies
   * strip request bodies on DELETE. Body: { ids: string[] }.
   */
  .post(
    "/bulk-delete",
    async ({ body, apiKeyId }) => {
      logger.info("POST /api/v1/emails/bulk-delete", {
        count: body.ids.length,
        apiKeyId,
      });

      const deleted = await emailService.trashEmails(body.ids, apiKeyId);

      return { success: true, deleted };
    },
    {
      body: t.Object({
        ids: t.Array(t.String(), { minItems: 1, maxItems: 100 }),
      }),
      detail: {
        tags: ["Emails"],
        summary: "Bulk move emails to trash",
        description: "Soft-deletes up to 100 emails in one call.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  /**
   * POST /api/v1/emails/:id/restore
   *
   * Restores a trashed email. 404 if not found or not currently trashed.
   */
  .post(
    "/:id/restore",
    async ({ params, apiKeyId, set }) => {
      logger.info("POST /api/v1/emails/:id/restore", {
        emailId: params.id,
        apiKeyId,
      });

      const email = await emailService.restoreEmail(params.id, apiKeyId);

      if (!email) {
        set.status = 404;
        return { success: false, error: "Trashed email not found" };
      }

      return { success: true, data: serializeEmail(email) };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        tags: ["Emails"],
        summary: "Restore a trashed email",
        description: "Clears the deletion marker so the email reappears in normal lists.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  /**
   * DELETE /api/v1/emails/:id/permanent
   *
   * Permanently deletes a trashed email. Only operates on rows already
   * in trash — protects against bypassing the soft-delete workflow.
   */
  .delete(
    "/:id/permanent",
    async ({ params, apiKeyId, set }) => {
      logger.info("DELETE /api/v1/emails/:id/permanent", {
        emailId: params.id,
        apiKeyId,
      });

      const email = await emailService.permanentDeleteEmail(params.id, apiKeyId);

      if (!email) {
        set.status = 404;
        return { success: false, error: "Trashed email not found" };
      }

      return { success: true, data: serializeEmail(email) };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        tags: ["Emails"],
        summary: "Permanently delete a trashed email",
        description:
          "Hard-deletes a trashed email immediately. This action is irreversible.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  /**
   * POST /api/v1/emails/trash/empty
   *
   * Permanently deletes every trashed email for the calling API key.
   * Returns the count purged.
   */
  .post(
    "/trash/empty",
    async ({ apiKeyId }) => {
      logger.info("POST /api/v1/emails/trash/empty", { apiKeyId });

      const deleted = await emailService.emptyEmailsTrash(apiKeyId);

      return { success: true, deleted };
    },
    {
      detail: {
        tags: ["Emails"],
        summary: "Empty the email trash",
        description: "Permanently deletes all trashed emails for the current API key.",
        security: [{ bearerAuth: [] }],
      },
    },
  );
