import { Elysia, t } from "elysia";
import { listDmarcReportsDto } from "./dtos/list-dmarc-reports.dto.ts";
import {
  serializeDmarcReportSummary,
  serializeDmarcReportDetail,
} from "./serializations/dmarc-report.serialization.ts";
import * as dmarcReportsService from "./services/dmarc-reports.service.ts";
import { authMiddleware } from "../../middleware/auth.ts";
import { rateLimitMiddleware } from "../../middleware/rate-limit.ts";
import { logger } from "../../utils/logger.ts";

/**
 * DMARC reports plugin — read-only API for inspecting aggregate
 * reports parsed from inbound DMARC `rua` mail (#41).
 *
 * Routes:
 * - GET /              List reports, paginated, optional `?domain=` filter
 * - GET /:id           Detail with per-source-IP records + computed totals
 *
 * Reports are operator-level data (not tenant-scoped) — see
 * docs/dmarc-reports.md for the rationale. All routes still require a
 * Bearer token; in this codebase that's effectively admin auth.
 */
export const dmarcReportsPlugin = new Elysia({
  prefix: "/api/v1/dmarc-reports",
  normalize: true,
})
  .use(authMiddleware)
  .use(rateLimitMiddleware)

  .get(
    "/",
    async ({ query, apiKeyId }) => {
      logger.info("GET /api/v1/dmarc-reports", { apiKeyId, ...query });

      const { data, total } = await dmarcReportsService.listDmarcReports({
        page: query.page ?? 1,
        limit: query.limit ?? 20,
        domain: query.domain,
      });

      return {
        success: true,
        data: data.map(serializeDmarcReportSummary),
        pagination: { page: query.page ?? 1, limit: query.limit ?? 20, total },
      };
    },
    {
      query: listDmarcReportsDto,
      detail: {
        tags: ["DMARC Reports"],
        summary: "List DMARC aggregate reports",
        description:
          "Returns parsed DMARC aggregate (rua) reports received from remote receivers. Optional `?domain=` filter.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  .get(
    "/:id",
    async ({ params, set, apiKeyId }) => {
      logger.info("GET /api/v1/dmarc-reports/:id", { apiKeyId, id: params.id });

      const result = await dmarcReportsService.getDmarcReportById(params.id);
      if (!result) {
        set.status = 404;
        return { success: false, error: "DMARC report not found" };
      }

      return {
        success: true,
        data: serializeDmarcReportDetail(result.report, result.records),
      };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        tags: ["DMARC Reports"],
        summary: "Get DMARC report detail",
        description:
          "Returns one DMARC report with its full per-source-IP records + computed alignment totals.",
        security: [{ bearerAuth: [] }],
      },
    },
  );
