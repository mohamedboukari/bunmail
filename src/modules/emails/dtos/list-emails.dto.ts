import { t } from "elysia";

/**
 * Validation schema for GET /api/v1/emails query parameters.
 *
 * Controls pagination and optional status filtering.
 * Defaults: page=1, limit=20, status=undefined (all statuses).
 */
export const listEmailsDto = t.Object({
  /** Page number (1-based). Defaults to 1 if not provided. */
  page: t.Optional(t.Numeric({ minimum: 1, default: 1 })),

  /** Number of results per page. Defaults to 20, max 100. */
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, default: 20 })),

  /** Optional filter: only return emails with this status */
  status: t.Optional(
    t.Union([
      t.Literal("queued"),
      t.Literal("sending"),
      t.Literal("sent"),
      t.Literal("failed"),
    ])
  ),
});
