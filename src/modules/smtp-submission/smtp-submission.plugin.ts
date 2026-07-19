import { Elysia } from "elysia";
import { statsQueryDto } from "./dtos/stats-query.dto.ts";
import { serializeSubmissionStats } from "./serializations/stats.serialization.ts";
import * as usageService from "./services/usage.service.ts";
import { authMiddleware } from "../../middleware/auth.ts";
import { rateLimitMiddleware } from "../../middleware/rate-limit.ts";
import { config } from "../../config.ts";
import { logger } from "../../utils/logger.ts";

/**
 * SMTP submission REST surface (#123).
 *
 * The submission *server* itself (the SMTP listener) has no HTTP routes —
 * this plugin exposes read-only usage stats + quota status for the SMTP
 * submission path, scoped to the calling API key (consistent with the
 * rest of `/api/v1`). Cross-key / instance-wide views belong in the
 * dashboard and are a separate follow-up.
 *
 * Routes (auth-required, scoped to the calling key):
 * - GET /  stats?days=N   Per-day accepted/rejected + quota status
 */
export const smtpSubmissionPlugin = new Elysia({
  prefix: "/api/v1/smtp-submission",
  normalize: true,
})
  .use(authMiddleware)
  .use(rateLimitMiddleware)

  .get(
    "/stats",
    async ({ query, apiKeyId }) => {
      const days = query.days ?? 30;
      logger.info("GET /api/v1/smtp-submission/stats", { apiKeyId, days });

      const [stats, usedToday] = await Promise.all([
        usageService.getStats(apiKeyId, days),
        usageService.getAcceptedToday(apiKeyId),
      ]);

      return {
        success: true,
        data: serializeSubmissionStats({
          stats,
          dailyQuota: config.smtpSubmission.dailyQuota,
          usedToday,
        }),
      };
    },
    {
      query: statsQueryDto,
      detail: {
        tags: ["SMTP Submission"],
        summary: "SMTP submission usage stats + quota status",
        description:
          "Per-day accepted/rejected counts for messages sent via the SMTP submission server, scoped to the calling API key, plus the key's daily quota status. `days` is the trailing UTC-day window (default 30, max 365).",
        security: [{ bearerAuth: [] }],
      },
    },
  );
