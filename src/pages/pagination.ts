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

/**
 * The `limit` a list page's filter controls carry (#435), or undefined when
 * they should carry none.
 *
 * A filter link or form that drops `limit` sends the operator back to the
 * page's default size, so choosing 100 rows and then a status tab would
 * show 25 again. The chosen size is carried only when it differs from the
 * default, which keeps the default URLs short and unchanged. A size outside
 * PAGE_SIZES (only possible from a caller that skipped parsePagination) is
 * never carried: the next request would fall back to the default anyway.
 *
 * @param limit        - The rows per page the list is showing
 * @param defaultLimit - The page's default, as given to parsePagination
 * @returns The size as a query value ("50", "100"), or undefined
 */
export function keptLimit(
  limit: number,
  defaultLimit: PageSize = DEFAULT_PAGE_SIZE,
): string | undefined {
  /** Only an allowed size is ever written back into a URL. */
  const size = toPageSize(limit);
  return size === undefined || size === defaultLimit ? undefined : String(size);
}

/**
 * A filter link that keeps the chosen rows-per-page size (#435): `path`
 * with `limit=<size>` appended when keptLimit gives one, else `path`
 * unchanged. `path` may already hold a query string. Never adds `page`, so
 * a filter change still starts on page 1.
 *
 * The appended value is one of the digit strings of PAGE_SIZES, so it
 * needs no encoding.
 *
 * @param path         - The filter link without a `limit`
 * @param limit        - The rows per page the list is showing
 * @param defaultLimit - The page's default, as given to parsePagination
 */
export function withKeptLimit(
  path: string,
  limit: number,
  defaultLimit: PageSize = DEFAULT_PAGE_SIZE,
): string {
  const value = keptLimit(limit, defaultLimit);
  if (value === undefined) return path;
  /** Join with `&` when the link already has a query string. */
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}limit=${value}`;
}
