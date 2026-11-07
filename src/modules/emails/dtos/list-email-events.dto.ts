import { t } from "elysia";

/**
 * Query of `GET /api/v1/emails/:id/events` (#187): pagination like the
 * emails list. Defaults: page 1, 20 per page, at most 100.
 */
export const listEmailEventsDto = t.Object({
  /** Page number (1-based), capped so OFFSET stays in range (#172). */
  page: t.Optional(t.Numeric({ minimum: 1, maximum: 1_000_000, default: 1 })),
  /** Events per page, at most 100. */
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, default: 20 })),
});
