import { Elysia, t } from "elysia";
import { sendEmailDto, sendEmailHeadersDto } from "./dtos/send-email.dto.ts";
import { batchSendEmailDto, MAX_BATCH_EMAILS } from "./dtos/batch-send-email.dto.ts";
import { listEmailsDto } from "./dtos/list-emails.dto.ts";
import {
  serializeEmail,
  type SerializedEmail,
} from "./serializations/email.serialization.ts";
import { serializeEmailTombstone } from "./serializations/email-tombstone.serialization.ts";
import * as emailService from "./services/email.service.ts";
import * as tombstoneService from "./services/tombstone.service.ts";
import * as batchSendService from "./services/batch-send.service.ts";
import { authMiddleware } from "../../middleware/auth.ts";
import { rateLimitMiddleware } from "../../middleware/rate-limit.ts";
import { logger } from "../../utils/logger.ts";
import { redactEmail } from "../../utils/redact.ts";
import type { CreatedEmail, Email, SendResponse } from "./types/email.types.ts";

/**
 * Serializes emails with their attachment metadata (#181), read in one
 * query for the whole page and never with the bytes.
 */
async function serializeEmails(rows: Email[]): Promise<SerializedEmail[]> {
  const attachments = await emailService.attachmentsFor(rows.map((row) => row.id));
  return rows.map((row) => serializeEmail(row, attachments.get(row.id) ?? []));
}

/**
 * The `/send` response for a created email: `200` with the email and its
 * sender-domain warnings (#245). Shared by `/send` and each batch item
 * (#178), and stored as the idempotency snapshot (#188). `toAsArray`
 * keeps `to` an array when the request gave one.
 */
function sendResponse(
  { email, warnings, attachments }: CreatedEmail,
  toAsArray: boolean,
): SendResponse {
  return {
    status: 200,
    body: {
      success: true,
      data: serializeEmail(email, attachments, { toAsArray }),
      warnings,
    },
  };
}

/** One email with its attachment metadata (#181). */
async function serializeOneEmail(row: Email): Promise<SerializedEmail> {
  const attachments = await emailService.attachmentsFor([row.id]);
  return serializeEmail(row, attachments.get(row.id) ?? []);
}

/**
 * Emails plugin: registers all email-related routes under /api/v1/emails.
 *
 * Routes:
 * - POST /send                  → Queue a new email for delivery (optional
 *                                 `Idempotency-Key` header, #188)
 * - POST /batch                 → Queue 1 to 100 distinct emails, one result
 *                                 per item (#178)
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
  /** Normalize URLs: /api/v1/emails and /api/v1/emails/ both work */
  normalize: true,
})
  /** Apply auth middleware: all routes in this plugin require a valid Bearer token */
  .use(authMiddleware)
  /** Apply rate limiting: 100 requests per 60 seconds per API key */
  .use(rateLimitMiddleware)

  /**
   * POST /api/v1/emails/send
   *
   * Accepts email content in the request body, validates it against
   * the sendEmailDto schema, inserts it into the DB with status "queued",
   * and returns the serialized email. The queue processor will handle
   * actual SMTP delivery asynchronously.
   *
   * `warnings` (#245) lists the sender domain's DNS records that are not
   * verified (`dkim_unverified`, `spf_unverified`, `dmarc_unverified`, or
   * `domain_unregistered` in development); empty when all are verified.
   */
  .post(
    "/send",
    async ({ body, apiKeyId, headers, set }) => {
      /** The first `to` address and the count only, never the list (#178). */
      const toList = typeof body.to === "string" ? [body.to] : body.to;
      logger.info("POST /api/v1/emails/send", {
        apiKeyId,
        to: redactEmail(toList[0]),
        toCount: toList.length,
      });
      const toAsArray = Array.isArray(body.to);

      /**
       * With an `Idempotency-Key` (#188) the response comes from the key's
       * stored snapshot: the first request stores it, a retry replays it.
       */
      const idempotencyKey = headers["idempotency-key"];
      if (idempotencyKey !== undefined) {
        const result = await emailService.createEmailIdempotent(
          body,
          apiKeyId,
          idempotencyKey,
          (created) => sendResponse(created, toAsArray),
        );
        set.status = result.status;
        if (result.replayed) set.headers["idempotent-replayed"] = "true";
        return result.body;
      }

      /** Create the email record: it starts in "queued" status */
      const response = sendResponse(
        await emailService.createEmail(body, apiKeyId),
        toAsArray,
      );
      set.status = response.status;
      return response.body;
    },
    {
      body: sendEmailDto,
      headers: sendEmailHeadersDto,
      detail: {
        tags: ["Emails"],
        summary: "Send an email",
        description:
          "Queue a new email for delivery. The email is inserted with status 'queued' and the queue processor handles SMTP delivery asynchronously. `to` is one address or an array of up to 50 (one message whose To header lists them all; at most 100 unique recipients with cc and bcc, else 422 TOO_MANY_RECIPIENTS); the response's `to` is an array when the request gave one, a string otherwise. `warnings` lists the sender domain's DNS records that are not verified (empty when all are). An optional `Idempotency-Key` header makes the request safe to retry: a repeat with the same key and body returns the first response with `Idempotent-Replayed: true` instead of sending again. Optional `attachments` (at most 10, at most ATTACHMENTS_MAX_TOTAL_MB decoded in total) are stored until the email reaches a final state; executables, scripts and installers are refused.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  /**
   * POST /api/v1/emails/batch (#178)
   *
   * 1 to 100 distinct emails in one request, each exactly a `/send` body
   * plus an optional per-item `idempotencyKey`. Items are processed in
   * order and independently (`batch-send.service.ts`): one bad item never
   * fails the others. Always `200` when the request itself is valid, with
   * one result per item in request order; each result's `success` carries
   * its outcome. The rate limiter counts the batch as one send per email
   * and refuses it whole (429) when the key's remaining budget is smaller.
   */
  .post(
    "/batch",
    async ({ body, apiKeyId, headers, set }) => {
      /**
       * One key cannot name N sends: refused before any item is touched,
       * with a pointer to the per-item field.
       */
      if (headers["idempotency-key"] !== undefined) {
        logger.warn("Batch send refused: Idempotency-Key header", { apiKeyId });
        set.status = 422;
        return {
          success: false,
          error:
            "The Idempotency-Key header is not supported on /emails/batch: set idempotencyKey on each item instead.",
          code: "IDEMPOTENCY_KEY_NOT_SUPPORTED",
        };
      }

      logger.info("POST /api/v1/emails/batch", { apiKeyId, count: body.emails.length });
      const data = await batchSendService.sendBatch(body.emails, apiKeyId, sendResponse);
      return { success: true, data };
    },
    {
      body: batchSendEmailDto,
      detail: {
        tags: ["Emails"],
        summary: "Send a batch of emails",
        description: `Queue 1 to ${MAX_BATCH_EMAILS} distinct emails in one request: each item is a /send body (templates, tags, attachments included) plus an optional \`idempotencyKey\`, and becomes its own email with its own Message-ID. Items are processed in order and independently, so one invalid or refused item never fails the others. The answer is 200 with one result per item, in request order: \`{ index, success: true, data, warnings, replayed }\` or \`{ index, success: false, error, code, details? }\`, with the codes /send would answer. The batch counts as one send per email against the API key's rate limit and is refused whole with 429 when the remaining budget is smaller. The Idempotency-Key header is refused (422 IDEMPOTENCY_KEY_NOT_SUPPORTED): use per-item keys. Attachments are capped per item (ATTACHMENTS_MAX_TOTAL_MB), and the HTTP body limit caps the whole request, so split large attachment batches.`,
        security: [{ bearerAuth: [] }],
      },
    },
  )

  .get(
    "/",
    async ({ query, apiKeyId, request }) => {
      /**
       * Every `tag` filter (#189), read from the raw query string: Elysia
       * would split a value on its commas. Checked before anything else.
       */
      const tags = emailService.checkTagFilters(
        new URL(request.url).searchParams.getAll("tag"),
        apiKeyId,
      );
      /** Tag keys only: the values may hold customer ids. */
      logger.info("GET /api/v1/emails", {
        apiKeyId,
        page: query.page,
        limit: query.limit,
        status: query.status,
        source: query.source,
        tagKeys: tags.map((tag) => tag.key),
      });

      const { data, total } = await emailService.listEmails(apiKeyId, {
        page: query.page ?? 1,
        limit: query.limit ?? 20,
        status: query.status,
        source: query.source,
        tags,
      });

      return {
        success: true,
        data: await serializeEmails(data),
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
          "Returns a paginated list of emails for the current API key. Supports optional status, source and tag filters; `tag=key:value` may repeat, and every tag must match.",
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
        data: await serializeEmails(data),
        pagination: {
          page: query.page ?? 1,
          limit: query.limit ?? 20,
          total,
        },
      };
    },
    {
      query: t.Object({
        page: t.Optional(t.Number({ minimum: 1, maximum: 1_000_000 })),
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

  /**
   * GET /api/v1/emails/tombstones: paginated list of post-purge audit
   * snapshots (#34). Operators use this to trace late complaints and
   * bounces back to a sent message after the original email row has
   * been hard-deleted by the trash purge sweep.
   *
   * Optional `?messageId=` filter is the hot path: paste the
   * `Message-ID` from a DSN / FBL report to find out whether (and
   * when) we sent it.
   */
  .get(
    "/tombstones",
    async ({ query, apiKeyId }) => {
      const page = query.page ?? 1;
      const limit = query.limit ?? 20;
      const messageId =
        typeof query.messageId === "string" && query.messageId.length > 0
          ? query.messageId
          : undefined;

      const { data, total } = await tombstoneService.listTombstones({
        apiKeyId,
        messageId,
        page,
        limit,
      });

      return {
        success: true,
        data: data.map(serializeEmailTombstone),
        pagination: { page, limit, total },
      };
    },
    {
      /** Bounded like the other list endpoints (#172): bad input is a 422. */
      query: t.Object({
        page: t.Optional(t.Numeric({ minimum: 1, maximum: 1_000_000, default: 1 })),
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, default: 20 })),
        messageId: t.Optional(t.String()),
      }),
      detail: {
        tags: ["Emails"],
        summary: "List email tombstones",
        description:
          "Paginated audit-trail snapshots of emails that have been hard-deleted. Filter by `?messageId=<id>` to trace a complaint or bounce.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  .get(
    "/tombstones/:id",
    async ({ params, apiKeyId, set }) => {
      const row = await tombstoneService.getTombstoneById({
        id: params.id,
        apiKeyId,
      });
      if (!row) {
        set.status = 404;
        return { success: false, error: "Tombstone not found" };
      }
      return { success: true, data: serializeEmailTombstone(row) };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        tags: ["Emails"],
        summary: "Get an email tombstone",
        description: "Returns the post-purge audit snapshot for a single email id.",
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
        data: await serializeOneEmail(email),
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

      return { success: true, data: await serializeOneEmail(email) };
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

      return { success: true, data: await serializeOneEmail(email) };
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
   * in trash: protects against bypassing the soft-delete workflow.
   */
  .delete(
    "/:id/permanent",
    async ({ params, apiKeyId, set }) => {
      logger.info("DELETE /api/v1/emails/:id/permanent", {
        emailId: params.id,
        apiKeyId,
      });

      const result = await emailService.permanentDeleteEmail(params.id, apiKeyId);

      if (!result) {
        set.status = 404;
        return { success: false, error: "Trashed email not found" };
      }

      /** As of #34, hard-delete returns just the id: the row is gone
       *  but a tombstone is at `GET /api/v1/emails/tombstones/:id`. */
      return { success: true, data: { id: result.id } };
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
