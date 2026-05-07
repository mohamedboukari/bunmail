import { t } from "elysia";

/**
 * Query parameters for `GET /api/v1/suppressions`.
 *
 * `email` is an exact-match filter (typed lookup) — useful when a
 * dashboard wants to show "is this address suppressed?" without paging
 * through the entire list. Wildcard / substring search is intentionally
 * not supported: it would force a non-indexed scan, and the existing
 * `(api_key_id, email)` index already makes exact match fast.
 */
export const listSuppressionsDto = t.Object({
  page: t.Optional(t.Numeric({ minimum: 1, default: 1 })),
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, default: 20 })),
  email: t.Optional(t.String({ maxLength: 255 })),
});
