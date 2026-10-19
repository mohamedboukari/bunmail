import { t } from "elysia";

/**
 * Query params for `GET /api/v1/webhooks` (#258). Same rules as the other
 * API lists (page/limit, 1-indexed page, 422 on anything out of bounds),
 * but `limit` defaults to 100, the maximum: a key has at most
 * `WEBHOOKS_MAX_PER_API_KEY` (up to 100) webhooks, so a client that never
 * sends `page` still gets all of them.
 */
export const listWebhooksQueryDto = t.Object({
  /** Capped so OFFSET stays inside Postgres's bigint range (#172). */
  page: t.Optional(t.Numeric({ minimum: 1, maximum: 1_000_000, default: 1 })),
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, default: 100 })),
});
