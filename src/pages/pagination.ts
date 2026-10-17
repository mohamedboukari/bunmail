/**
 * Lenient pagination parsing for dashboard list pages (#172).
 *
 * Dashboard URLs are edited by hand, so bad values are corrected rather
 * than rejected: a raw 422 is a poor experience in a browser. (The REST
 * API validates the same params strictly and answers 422 instead.)
 *
 * Without this, `parseInt` let `?page=0` produce a negative OFFSET (a 500
 * from Postgres) and let `?limit=abc` or a huge limit read the whole table:
 * the driver treats a NaN limit as no limit at all.
 */

/** Hard ceiling on rows per dashboard page. */
export const MAX_PAGE_SIZE = 100;

/**
 * Highest page number. Keeps OFFSET far inside Postgres's bigint range: an
 * unbounded page like 1e20 overflowed it and produced a 500 (#172).
 */
export const MAX_PAGE = 1_000_000;

/** Validated pagination values. */
export interface Pagination {
  page: number;
  limit: number;
}

/**
 * Parses a positive integer, or returns undefined for anything else.
 * `parseInt` semantics, so "2.5" reads as 2 and "12abc" as 12.
 */
function positiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 1 ? n : undefined;
}

/**
 * Turns raw `?page=` / `?limit=` strings into safe values.
 *
 * - page: a positive integer capped at MAX_PAGE, else 1
 * - limit: a positive integer capped at MAX_PAGE_SIZE, else the default
 *
 * @param query        - The raw query params
 * @param defaultLimit - Rows per page when `limit` is missing or invalid
 */
export function parsePagination(
  query: { page?: string; limit?: string },
  defaultLimit: number = 20,
): Pagination {
  const page = Math.min(MAX_PAGE, positiveInt(query.page) ?? 1);
  const limit = Math.min(MAX_PAGE_SIZE, positiveInt(query.limit) ?? defaultLimit);
  return { page, limit };
}
