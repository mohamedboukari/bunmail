import { t } from "elysia";

/**
 * Query parameters for `GET /api/v1/smtp-submission/stats` (#123).
 *
 * `days` is the trailing UTC-day window to aggregate (inclusive of today),
 * capped at a year so the range scan stays bounded.
 */
export const statsQueryDto = t.Object({
  days: t.Optional(t.Numeric({ minimum: 1, maximum: 365, default: 30 })),
});
