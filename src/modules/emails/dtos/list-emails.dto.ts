import { t } from "elysia";

/**
 * Validation schema for GET /api/v1/emails query parameters.
 *
 * Controls pagination and optional status filtering.
 * Defaults: page=1, limit=20, status=undefined (all statuses).
 */
export const listEmailsDto = t.Object({
  /** Page number (1-based). Defaults to 1 if not provided. */
  /** Capped so OFFSET stays inside Postgres's bigint range (#172). */
  page: t.Optional(t.Numeric({ minimum: 1, maximum: 1_000_000, default: 1 })),

  /** Number of results per page. Defaults to 20, max 100. */
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, default: 20 })),

  /** Optional filter: only return emails with this status */
  status: t.Optional(
    t.Union([
      t.Literal("queued"),
      t.Literal("sending"),
      t.Literal("sent"),
      t.Literal("failed"),
      t.Literal("bounced"),
    ]),
  ),

  /** Optional filter: only return emails from this ingress channel (#137) */
  source: t.Optional(t.Union([t.Literal("api"), t.Literal("smtp")])),

  /**
   * Optional tag filter (#189), `key:value`, repeatable (all must match).
   * Declared for the OpenAPI document only: Elysia splits repeated and
   * comma-separated values, so the route reads every `tag` from the raw
   * query string instead and checks it with `parseTagFilters`.
   */
  tag: t.Optional(
    t.String({
      description:
        "Only emails carrying this tag, as key:value (split on the first colon, so the value may contain colons). Repeat the parameter to require several tags (all must match), at most 10. An invalid filter is 422 VALIDATION_ERROR.",
    }),
  ),
});
