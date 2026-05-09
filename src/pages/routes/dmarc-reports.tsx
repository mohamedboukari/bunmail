import { BaseLayout } from "../layouts/base.tsx";
import { EmptyState } from "../components/empty-state.tsx";
import { Pagination } from "../components/pagination.tsx";
import type { DmarcReport } from "../../modules/dmarc-reports/types/dmarc-report.types.ts";

interface DmarcReportsPageProps {
  reports: DmarcReport[];
  total: number;
  page: number;
  limit: number;
  /** Active domain filter, or undefined for "all". */
  domainFilter?: string;
  /** All distinct domains we have reports for — drives the filter dropdown. */
  domains: string[];
}

/**
 * DMARC reports list — table of received aggregate reports from
 * remote receivers. Each row links to the detail view with full
 * per-source-IP breakdown.
 */
export function DmarcReportsPage({
  reports,
  total,
  page,
  limit,
  domainFilter,
  domains,
}: DmarcReportsPageProps) {
  return (
    <BaseLayout title="DMARC Reports" activeNav="dmarc-reports">
      <div class="flex items-center justify-between mb-6">
        <h1 class="text-xl font-semibold">DMARC Reports</h1>
      </div>

      <p class="text-sm text-gray-600 dark:text-gray-400 mb-4">
        Aggregate (rua) reports from remote receivers. Each report covers a 24h window and
        lists per-source-IP authentication results for messages claiming to be from your
        domain.
      </p>

      {/* Domain filter — links rather than a form so server stays stateless */}
      {domains.length > 1 && (
        <div class="flex flex-wrap items-center gap-2 mb-4">
          <span class="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Domain
          </span>
          <a
            href="/dashboard/dmarc-reports"
            class={`px-3 py-1 rounded text-sm ${
              !domainFilter
                ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
                : "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300"
            }`}
          >
            All
          </a>
          {domains.map((d) => (
            <a
              href={`/dashboard/dmarc-reports?domain=${encodeURIComponent(d)}`}
              class={`px-3 py-1 rounded text-sm ${
                domainFilter === d
                  ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
                  : "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300"
              }`}
            >
              {d}
            </a>
          ))}
        </div>
      )}

      {reports.length === 0 ? (
        <EmptyState message="No DMARC reports yet. Aggregate reports arrive daily from receivers (Microsoft, Google, Yahoo, etc.) once your domain has a _dmarc TXT record with rua=mailto:..." />
      ) : (
        <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
          <table class="w-full text-sm">
            <thead class="bg-gray-50 dark:bg-gray-800/50 text-left">
              <tr>
                <th class="px-4 py-3 font-medium text-gray-700 dark:text-gray-300">
                  Reporter
                </th>
                <th class="px-4 py-3 font-medium text-gray-700 dark:text-gray-300">
                  Domain
                </th>
                <th class="px-4 py-3 font-medium text-gray-700 dark:text-gray-300">
                  Window
                </th>
                <th class="px-4 py-3 font-medium text-gray-700 dark:text-gray-300">
                  Policy
                </th>
                <th class="px-4 py-3 font-medium text-gray-700 dark:text-gray-300">
                  Received
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-200 dark:divide-gray-800">
              {reports.map((r) => (
                <tr class="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                  <td class="px-4 py-3">
                    <a
                      href={`/dashboard/dmarc-reports/${r.id}`}
                      class="text-blue-600 dark:text-blue-400 hover:underline"
                    >
                      {r.orgName}
                    </a>
                  </td>
                  <td class="px-4 py-3 font-mono text-xs">{r.domain}</td>
                  <td class="px-4 py-3 text-gray-600 dark:text-gray-400 text-xs">
                    {r.dateBegin.toISOString().slice(0, 10)} →{" "}
                    {r.dateEnd.toISOString().slice(0, 10)}
                  </td>
                  <td class="px-4 py-3">
                    <span class="px-2 py-0.5 text-xs rounded bg-gray-100 dark:bg-gray-800">
                      p={r.policyP}
                    </span>
                  </td>
                  <td class="px-4 py-3 text-gray-500 dark:text-gray-400 text-xs">
                    {r.receivedAt.toISOString().slice(0, 16).replace("T", " ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination
        page={page}
        limit={limit}
        total={total}
        baseUrl="/dashboard/dmarc-reports"
        extraParams={
          domainFilter ? `domain=${encodeURIComponent(domainFilter)}` : undefined
        }
      />
    </BaseLayout>
  );
}
