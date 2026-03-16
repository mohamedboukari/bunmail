import { BaseLayout } from "../layouts/base.tsx";
import { EmptyState } from "../components/empty-state.tsx";
import { Pagination } from "../components/pagination.tsx";
import type { InboundEmail } from "../../modules/inbound/types/inbound.types.ts";

/**
 * Props for the inbound emails list page.
 */
interface InboundPageProps {
  emails: InboundEmail[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Inbound emails list page — shows a table of received emails with pagination.
 */
export function InboundPage({ emails, total, page, limit }: InboundPageProps) {
  return (
    <BaseLayout title="Inbound Emails" activeNav="inbound">
      <h1 class="text-xl font-semibold mb-6">Inbound Emails</h1>

      {emails.length === 0 ? (
        <EmptyState message="No inbound emails yet. Emails sent to your configured addresses will appear here." />
      ) : (
        <>
          {/* Inbound emails table */}
          <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-gray-200 dark:border-gray-800">
                  <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                    From
                  </th>
                  <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                    To
                  </th>
                  <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                    Subject
                  </th>
                  <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                    Received At
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
                {emails.map((email) => (
                  <tr class="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                    <td class="px-4 py-3 font-medium text-gray-900 dark:text-gray-100 truncate max-w-[150px]">
                      <a
                        href={`/dashboard/inbound/${email.id}`}
                        class="hover:underline"
                        safe
                      >
                        {email.fromAddress}
                      </a>
                    </td>
                    <td
                      class="px-4 py-3 text-gray-700 dark:text-gray-300 truncate max-w-[150px]"
                      safe
                    >
                      {email.toAddress}
                    </td>
                    <td
                      class="px-4 py-3 text-gray-700 dark:text-gray-300 truncate max-w-[200px]"
                      safe
                    >
                      {email.subject}
                    </td>
                    <td class="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                      {email.receivedAt.toLocaleDateString()}
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
            baseUrl="/dashboard/inbound"
          />
        </>
      )}
    </BaseLayout>
  );
}
