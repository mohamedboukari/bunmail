/**
 * Lenient pagination parsing for dashboard list pages (#172, #429).
 *
 * Dashboard URLs are edited by hand, so bad values are corrected rather
 * than rejected: a raw 422 is a poor experience in a browser. (The REST
 * API validates the same params strictly and answers 422 instead.)
 *
 * Without this, `parseInt` let `?page=0` produce a negative OFFSET (a 500
 * from Postgres) and let `?limit=abc` or a huge limit read the whole table:
 * the driver treats a NaN limit as no limit at all.
 */

/**
 * The rows-per-page sizes a dashboard list offers (#429), in the order the
 * "Rows per page" select shows them. Any other `?limit=` falls back to the
 * page's default, so a list never reads more than the largest size.
 */
export const PAGE_SIZES = [25, 50, 100] as const;

/** One of the allowed rows-per-page sizes. */
export type PageSize = (typeof PAGE_SIZES)[number];

/** Rows per page when the URL names no allowed size (#429, was 20). */
export const DEFAULT_PAGE_SIZE: PageSize = 25;

/**
 * Highest page number. Keeps OFFSET far inside Postgres's bigint range: an
 * unbounded page like 1e20 overflowed it and produced a 500 (#172).
 */
export const MAX_PAGE = 1_000_000;

/** Validated pagination values. */
export interface Pagination {
  page: number;
  limit: PageSize;
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
 * Returns the allowed page size equal to `n`, or undefined when `n` is
 * not one of PAGE_SIZES. A lookup rather than a cast, so the result is a
 * real `PageSize`.
 */
function toPageSize(n: number | undefined): PageSize | undefined {
  return PAGE_SIZES.find((size) => size === n);
}

/**
 * Turns raw `?page=` / `?limit=` strings into safe values.
 *
 * - page: a positive integer capped at MAX_PAGE, else 1
 * - limit: one of PAGE_SIZES (25, 50, 100), else the page's default; an
 *   old bookmark's `limit=20`, junk and huge values all land on the default
 *
 * @param query        - The raw query params
 * @param defaultLimit - Rows per page when `limit` is missing or not allowed
 */
export function parsePagination(
  query: { page?: string; limit?: string },
  defaultLimit: PageSize = DEFAULT_PAGE_SIZE,
): Pagination {
  const page = Math.min(MAX_PAGE, positiveInt(query.page) ?? 1);
  const limit = toPageSize(positiveInt(query.limit)) ?? defaultLimit;
  return { page, limit };
}
