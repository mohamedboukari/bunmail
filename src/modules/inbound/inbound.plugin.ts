import { Elysia, t } from "elysia";
import { desc, sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { inboundEmails } from "./models/inbound-email.schema.ts";
import { serializeInboundEmail } from "./serializations/inbound.serialization.ts";
import { authMiddleware } from "../../middleware/auth.ts";
import { rateLimitMiddleware } from "../../middleware/rate-limit.ts";
import { logger } from "../../utils/logger.ts";

/**
 * Inbound emails plugin — read-only API for received emails
 * under /api/v1/inbound.
 *
 * Routes:
 * - GET /        → List inbound emails (paginated)
 * - GET /:id     → Get a single inbound email by ID
 */
export const inboundPlugin = new Elysia({
  prefix: "/api/v1/inbound",
  normalize: true,
})
  .use(authMiddleware)
  .use(rateLimitMiddleware)

  /**
   * GET /api/v1/inbound
   *
   * Returns a paginated list of received emails, newest first.
   */
  .get(
    "/",
    async ({ query }) => {
      const page = query.page ?? 1;
      const limit = query.limit ?? 20;
      const offset = (page - 1) * limit;

      logger.info("GET /api/v1/inbound", { page, limit });

      const [data, [countRow]] = await Promise.all([
        db
          .select()
          .from(inboundEmails)
          .orderBy(desc(inboundEmails.receivedAt))
          .limit(limit)
          .offset(offset),
        db.select({ count: sql<number>`count(*)::int` }).from(inboundEmails),
      ]);

      return {
        success: true,
        data: data.map(serializeInboundEmail),
        pagination: {
          page,
          limit,
          total: countRow?.count ?? 0,
        },
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

  .get(
    "/:id",
    async ({ params, set }) => {
      logger.info("GET /api/v1/inbound/:id", { id: params.id });

      const [email] = await db
        .select()
        .from(inboundEmails)
        .where(eq(inboundEmails.id, params.id));

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
  );
