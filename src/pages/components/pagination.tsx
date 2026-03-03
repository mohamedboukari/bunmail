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
  /** Optional extra query params to preserve (e.g. "status=sent") */
  extraParams?: string;
}

/**
 * Pagination — prev/next page links at the bottom of table views.
 * Preserves existing query params (like status filters) when navigating.
 */
export function Pagination({ page, limit, total, baseUrl, extraParams }: PaginationProps) {
  /** Total number of pages */
  const totalPages = Math.max(1, Math.ceil(total / limit));
  /** Whether there's a previous page */
  const hasPrev = page > 1;
  /** Whether there's a next page */
  const hasNext = page < totalPages;

  /** Build query string with optional extra params */
  function buildUrl(targetPage: number): string {
    const params = new URLSearchParams();
    params.set("page", String(targetPage));
    params.set("limit", String(limit));
    if (extraParams) {
      /** Merge extra params (e.g. status=sent) into the URL */
      const extra = new URLSearchParams(extraParams);
      extra.forEach((value, key) => params.set(key, value));
    }
    return `${baseUrl}?${params.toString()}`;
  }

  const buttonBase = "px-3 py-1.5 text-sm font-medium rounded-lg transition-colors";
  const activeButton = `${buttonBase} bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800`;
  const disabledButton = `${buttonBase} text-gray-400 dark:text-gray-600 cursor-not-allowed`;

  return (
    <div class="flex items-center justify-between mt-4">
      <p class="text-sm text-gray-500 dark:text-gray-400">
        Page {page} of {totalPages} ({total} total)
      </p>
      <div class="flex items-center gap-2">
        {hasPrev ? (
          <a href={buildUrl(page - 1)} class={activeButton}>
            Previous
          </a>
        ) : (
          <span class={disabledButton}>Previous</span>
        )}
        {hasNext ? (
          <a href={buildUrl(page + 1)} class={activeButton}>
            Next
          </a>
        ) : (
          <span class={disabledButton}>Next</span>
        )}
      </div>
    </div>
  );
}
