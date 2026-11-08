import { viewerIsAdmin } from "../viewer.ts";

/** Props of `ExportCsvLink`. */
interface ExportCsvLinkProps {
  /** The export route, e.g. `/dashboard/emails/export.csv`. */
  path: string;
  /** The page's current filters; empty and missing values are left out. */
  params?: Record<string, string | undefined>;
}

/**
 * "Export CSV" link of a dashboard table (#430), carrying the page's
 * current filters so the file holds what the page lists (every page, not
 * just this one). Rendered for admins and the owner only: members see
 * nothing (the route answers them 403 anyway, `adminGuard`). The route
 * answers `Content-Disposition: attachment`, so the browser downloads the
 * file and stays on the page. Floats right when placed before a heading;
 * inside a flex header it is a plain item.
 */
export function ExportCsvLink({ path, params = {} }: ExportCsvLinkProps): JSX.Element {
  if (!viewerIsAdmin()) return "";
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value) query.set(name, value);
  }
  const href = query.size > 0 ? `${path}?${query.toString()}` : path;
  return (
    <a
      href={href}
      class="float-right ml-4 text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
    >
      Export CSV
    </a>
  );
}
