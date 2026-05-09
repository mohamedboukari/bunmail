import { t } from "elysia";

/**
 * Query params for `GET /api/v1/webhooks/:id/deliveries`. Pagination
 * mirrors the rest of the API (page/limit, 1-indexed page).
 */
export const listDeliveriesQueryDto = t.Object({
  page: t.Optional(t.String()),
  limit: t.Optional(t.String()),
  /** Optional filter: pending | delivered | failed. */
  status: t.Optional(t.String()),
});
