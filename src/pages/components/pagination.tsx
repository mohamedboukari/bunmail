import { PAGE_SIZES } from "../pagination.ts";

/**
 * Props for the pagination component.
 */
interface PaginationProps {
  /** Current page number (1-based) */
  page: number;
  /** Number of items per page */
  limit: number;
  /** Total number of items across all pages */
  total: number;
  /** Base URL to append page query params to (e.g. "/dashboard/emails") */
  baseUrl: string;
  /**
   * The page's other query params to preserve, as a query string (e.g.
   * "status=sent&tag=env%3Aprod"). Kept on every page link and, as hidden
   * inputs, by the rows-per-page form. Any `page` or `limit` in it is
   * ignored: the component sets those itself.
   */
  extraParams?: string;
}

/** One slot in the numbered page list: a page number or a gap. */
export type PageSlot = number | "ellipsis";

/**
 * The numbered page slots to show (#429): the first and last page, the
 * current page and its two neighbours, with an ellipsis for each gap.
 * A gap of exactly one page shows that page instead, since an ellipsis
 * standing for a single number saves no room.
 *
 * Examples with 14 pages: page 1 gives `1 2 ... 14`, page 5 gives
 * `1 ... 4 5 6 ... 14`, page 14 gives `1 ... 13 14`.
 *
 * @param current    - The page to centre on, already within 1..totalPages
 * @param totalPages - The number of pages, at least 1
 */
export function pageWindow(current: number, totalPages: number): PageSlot[] {
  /** The pages that must be visible, deduplicated and kept in range. */
  const wanted = new Set<number>([1, totalPages, current - 1, current, current + 1]);
  const pages = [...wanted]
    .filter((n) => n >= 1 && n <= totalPages)
    .toSorted((a, b) => a - b);

  const slots: PageSlot[] = [];
  /** The last page pushed, to measure the gap to the next one. */
  let previous = 0;
  for (const n of pages) {
    if (n - previous === 2) {
      /** One page missing: show it rather than an ellipsis. */
      slots.push(previous + 1);
    } else if (n - previous > 2) {
      slots.push("ellipsis");
    }
    slots.push(n);
    previous = n;
  }
  return slots;
}

/**
 * The preserved query params as key/value pairs, without `page` and
 * `limit` (the component owns those). Repeated keys are kept in order.
 */
function preservedParams(extraParams: string | undefined): Array<[string, string]> {
  if (!extraParams) return [];
  const pairs: Array<[string, string]> = [];
  new URLSearchParams(extraParams).forEach((value, key) => {
    if (key !== "page" && key !== "limit") pairs.push([key, value]);
  });
  return pairs;
}

/** Shared size and shape of the arrow and page-number controls. */
const controlBase =
  "inline-flex h-8 min-w-8 items-center justify-center rounded-lg px-2 text-sm font-medium transition-colors";

/** A clickable page number or arrow. */
const linkClass = `${controlBase} text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800`;

/** The current page number. */
const currentClass = `${controlBase} bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900`;

/** An arrow with nowhere to go (first or last page). */
const disabledClass = `${controlBase} text-gray-300 dark:text-gray-700 cursor-not-allowed`;

/** The emphasised numbers in the "Showing X to Y of Z" summary. */
const countClass = "font-medium text-gray-700 dark:text-gray-300";

/** A left or right chevron for the previous / next controls (Heroicons outline). */
function Chevron({ direction }: { direction: "left" | "right" }): JSX.Element {
  return (
    <svg
      class="w-4 h-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      stroke-width="2"
      aria-hidden="true"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d={
          direction === "left"
            ? "M15.75 19.5L8.25 12l7.5-7.5"
            : "M8.25 4.5l7.5 7.5-7.5 7.5"
        }
      />
    </svg>
  );
}

/**
 * Pagination for every dashboard list (#429): "Showing X to Y of Z" on
 * the left; on the right a "Rows per page" select (25, 50, 100) and the
 * numbered pages with previous / next arrows.
 *
 * Every link keeps the page's other query params (filters). The select
 * sits in a GET form that carries those params as hidden inputs and no
 * `page`, so a new size starts again on page 1. `data-autosubmit` submits
 * the form on change (`assets/dashboard.js`: the CSP allows no inline
 * script); without JavaScript the `<noscript>` Apply button does it.
 */
export function Pagination({
  page,
  limit,
  total,
  baseUrl,
  extraParams,
}: PaginationProps): JSX.Element {
  /** Total number of pages, at least 1 so an empty list still shows page 1. */
  const totalPages = Math.max(1, Math.ceil(total / limit));
  /** Whether the requested page has rows (a hand-edited `?page=` can overshoot). */
  const inRange = page <= totalPages;
  /** The page the number list centres on: the last one when the URL overshoots. */
  const windowPage = Math.min(page, totalPages);
  /** First and last row numbers on this page (1-based, for the summary). */
  const firstRow = (page - 1) * limit + 1;
  const lastRow = Math.min(page * limit, total);
  /** Previous goes back one page, or to the last real page after an overshoot. */
  const prevPage = inRange ? page - 1 : totalPages;
  const hasPrev = prevPage >= 1;
  const hasNext = page < totalPages;

  /** The preserved params, shared by the links and the size form. */
  const kept = preservedParams(extraParams);

  /** Builds a page link: the preserved params, then `page` and `limit`. */
  function buildUrl(targetPage: number): string {
    const params = new URLSearchParams(kept);
    params.set("page", String(targetPage));
    params.set("limit", String(limit));
    return `${baseUrl}?${params.toString()}`;
  }

  return (
    <nav
      aria-label="Pagination"
      class="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <p class="text-sm text-gray-500 dark:text-gray-400">
        {total === 0 ? (
          "No results"
        ) : inRange ? (
          <>
            Showing{" "}
            <span class={countClass} safe>
              {String(firstRow)}
            </span>{" "}
            to{" "}
            <span class={countClass} safe>
              {String(lastRow)}
            </span>{" "}
            of{" "}
            <span class={countClass} safe>
              {String(total)}
            </span>
          </>
        ) : (
          <>
            No rows on this page (
            <span class={countClass} safe>
              {String(total)}
            </span>{" "}
            in total)
          </>
        )}
      </p>

      <div class="flex flex-wrap items-center gap-x-6 gap-y-3">
        <form method="get" action={baseUrl} class="flex items-center gap-2">
          {kept.map(([key, value]) => (
            <input type="hidden" name={key} value={value} />
          ))}
          <label class="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            Rows per page
            <select
              name="limit"
              data-autosubmit
              class="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 px-2 py-1 text-sm"
            >
              {PAGE_SIZES.map((size) => (
                <option value={String(size)} selected={size === limit} safe>
                  {String(size)}
                </option>
              ))}
            </select>
          </label>
          <noscript>
            <button
              type="submit"
              class="px-3 py-1 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              Apply
            </button>
          </noscript>
        </form>

        <div class="flex items-center gap-1">
          {hasPrev ? (
            <a href={buildUrl(prevPage)} class={linkClass} aria-label="Previous page">
              <Chevron direction="left" />
            </a>
          ) : (
            <span class={disabledClass} aria-label="Previous page" aria-disabled="true">
              <Chevron direction="left" />
            </span>
          )}

          {pageWindow(windowPage, totalPages).map((slot) =>
            slot === "ellipsis" ? (
              <span
                class={`${controlBase} text-gray-400 dark:text-gray-600`}
                aria-hidden="true"
              >
                …
              </span>
            ) : (
              <a
                href={buildUrl(slot)}
                class={slot === page ? currentClass : linkClass}
                aria-current={slot === page ? "page" : undefined}
                aria-label={`Page ${slot}`}
                safe
              >
                {String(slot)}
              </a>
            ),
          )}

          {hasNext ? (
            <a href={buildUrl(page + 1)} class={linkClass} aria-label="Next page">
              <Chevron direction="right" />
            </a>
          ) : (
            <span class={disabledClass} aria-label="Next page" aria-disabled="true">
              <Chevron direction="right" />
            </span>
          )}
        </div>
      </div>
    </nav>
  );
}
