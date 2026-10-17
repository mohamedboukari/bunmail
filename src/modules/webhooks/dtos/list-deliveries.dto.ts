import { t } from "elysia";

/**
 * Query params for `GET /api/v1/webhooks/:id/deliveries`. Pagination
 * mirrors the rest of the API (page/limit, 1-indexed page). Bounded so a
 * bad value is a 422, never a negative OFFSET (500) or an unbounded read
 * (#172).
 */
export const listDeliveriesQueryDto = t.Object({
  /** Capped so OFFSET stays inside Postgres's bigint range (#172). */
  page: t.Optional(t.Numeric({ minimum: 1, maximum: 1_000_000, default: 1 })),
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, default: 20 })),
  /** Optional filter: pending | delivered | failed. */
  status: t.Optional(t.String()),
});
