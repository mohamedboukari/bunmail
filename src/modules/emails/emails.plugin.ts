import { Elysia, t } from "elysia";
import { sendEmailDto } from "./dtos/send-email.dto.ts";
import { listEmailsDto } from "./dtos/list-emails.dto.ts";
import { serializeEmail } from "./serializations/email.serialization.ts";
import * as emailService from "./services/email.service.ts";
import { authMiddleware } from "../../middleware/auth.ts";
import { rateLimitMiddleware } from "../../middleware/rate-limit.ts";
import { logger } from "../../utils/logger.ts";

/**
 * Emails plugin — registers all email-related routes under /api/v1/emails.
 *
 * Routes:
 * - POST /send    → Queue a new email for delivery
 * - GET /         → List emails with pagination and optional status filter
 * - GET /:id      → Get a single email by ID
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
    async (context) => {
      /**
       * apiKeyId is injected by authMiddleware via derive().
       * Elysia's type inference doesn't propagate derive types across
       * .use() boundaries, so we access it from the context object.
       */
      const { body, apiKeyId } = context as typeof context & { apiKeyId: string };

      logger.info("POST /api/v1/emails/send", { apiKeyId, to: body.to });

      /** Create the email record — it starts in "queued" status */
      const email = await emailService.createEmail(body, apiKeyId);

      return {
        success: true,
        data: serializeEmail(email),
      };
    },
    {
      /** Validate request body against the send email DTO */
      body: sendEmailDto,
    }
  )

  /**
   * GET /api/v1/emails
   *
   * Returns a paginated list of emails for the current API key.
   * Supports optional `status` filter and `page`/`limit` query params.
   */
  .get(
    "/",
    async (context) => {
      /** apiKeyId from auth middleware derive() */
      const { query, apiKeyId } = context as typeof context & { apiKeyId: string };

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
      /** Validate query parameters against the list emails DTO */
      query: listEmailsDto,
    }
  )

  /**
   * GET /api/v1/emails/:id
   *
   * Returns a single email by its ID. Scoped to the current API key —
   * users can only see emails they created. Returns 404 if not found.
   */
  .get(
    "/:id",
    async (context) => {
      /** apiKeyId from auth middleware derive() */
      const { params, apiKeyId, set } = context as typeof context & { apiKeyId: string };

      logger.info("GET /api/v1/emails/:id", { emailId: params.id, apiKeyId });

      /** Pass apiKeyId to ensure users can only see their own emails */
      const email = await emailService.getEmailById(params.id, apiKeyId);

      /** Return 404 if no email matches the given ID and API key */
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
      /** Validate the :id URL parameter */
      params: t.Object({
        id: t.String(),
      }),
    }
  );
