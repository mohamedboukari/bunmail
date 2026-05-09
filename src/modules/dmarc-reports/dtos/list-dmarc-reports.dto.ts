import { t } from "elysia";

/**
 * Query parameters for `GET /api/v1/dmarc-reports`.
 *
 * `domain` is an exact-match filter — the dashboard's per-domain view
 * uses it. Date-range filtering is intentionally absent in v1; the
 * default ordering (newest first) covers the common "what came in
 * recently" case.
 */
export const listDmarcReportsDto = t.Object({
  page: t.Optional(t.Numeric({ minimum: 1, default: 1 })),
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, default: 20 })),
  domain: t.Optional(t.String({ maxLength: 255 })),
});
