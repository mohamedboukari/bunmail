import { BaseLayout } from "../layouts/base.tsx";
import { StatusBadge } from "../components/status-badge.tsx";
import { Pagination } from "../components/pagination.tsx";
import { EmptyState } from "../components/empty-state.tsx";
import type { Email } from "../../modules/emails/types/email.types.ts";

/**
 * Props for the emails list page.
 */
interface EmailsPageProps {
  /** The list of email rows to display */
  emails: Email[];
  /** Total count across all pages (for pagination) */
  total: number;
  /** Current page number */
  page: number;
  /** Items per page */
  limit: number;
  /** Currently active status filter (undefined = "all") */
  status?: string;
}

/**
 * Emails list page — shows a filterable table of all emails.
 * Has status filter tabs and pagination at the bottom.
 */
export function EmailsPage({ emails, total, page, limit, status }: EmailsPageProps) {
  /** Available status filter tabs */
  const filters = [
    { label: "All", value: "" },
    { label: "Queued", value: "queued" },
    { label: "Sending", value: "sending" },
    { label: "Sent", value: "sent" },
    { label: "Failed", value: "failed" },
  ];

  return (
    <BaseLayout title="Emails" activeNav="emails">
      <h1 class="text-xl font-semibold mb-6">Emails</h1>

      {/* Status filter tabs */}
      <div class="flex gap-1 mb-4">
        {filters.map((filter) => {
          const isActive = (status ?? "") === filter.value;
          return (
            <a
              href={`/dashboard/emails${filter.value ? `?status=${filter.value}` : ""}`}
              class={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                isActive
                  ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
                  : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
              }`}
            >
              {filter.label}
            </a>
          );
        })}
      </div>

      {emails.length === 0 ? (
        <EmptyState message="No emails found. Send your first email via the API." />
      ) : (
        <>
          {/* Emails table */}
          <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-gray-200 dark:border-gray-800">
                  <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Status</th>
                  <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">From</th>
                  <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">To</th>
                  <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Subject</th>
                  <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Created</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
                {emails.map((email) => (
                  <tr class="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                    <td class="px-4 py-3">
                      <StatusBadge status={email.status} />
                    </td>
                    <td class="px-4 py-3 text-gray-700 dark:text-gray-300 truncate max-w-[150px]">
                      <a href={`/dashboard/emails/${email.id}`} class="hover:underline" safe>
                        {email.fromAddress}
                      </a>
                    </td>
                    <td class="px-4 py-3 text-gray-700 dark:text-gray-300 truncate max-w-[150px]" safe>
                      {email.toAddress}
                    </td>
                    <td class="px-4 py-3 text-gray-700 dark:text-gray-300 truncate max-w-[200px]" safe>
                      {email.subject}
                    </td>
                    <td class="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                      {email.createdAt.toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <Pagination
            page={page}
            limit={limit}
            total={total}
            baseUrl="/dashboard/emails"
            extraParams={status ? `status=${status}` : undefined}
          />
        </>
      )}
    </BaseLayout>
  );
}
