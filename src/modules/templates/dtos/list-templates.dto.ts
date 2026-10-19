import { t } from "elysia";

/**
 * Query params for `GET /api/v1/templates` (#258). Same rules as the
 * other API lists (page/limit, 1-indexed page, 422 on anything out of
 * bounds), but `limit` defaults to 100, the maximum, so a client that
 * never sends `page` sees the same first 100 templates it saw before the
 * list was paginated.
 */
export const listTemplatesQueryDto = t.Object({
  /** Capped so OFFSET stays inside Postgres's bigint range (#172). */
  page: t.Optional(t.Numeric({ minimum: 1, maximum: 1_000_000, default: 1 })),
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, default: 100 })),
});
