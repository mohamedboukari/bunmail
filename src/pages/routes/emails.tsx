import { BaseLayout } from "../layouts/base.tsx";
import { StatusBadge } from "../components/status-badge.tsx";
import { Pagination } from "../components/pagination.tsx";
import { EmptyState } from "../components/empty-state.tsx";
import { FlashMessage } from "../components/flash-message.tsx";
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
  /** Optional flash message shown after redirect (e.g. "Email moved to trash") */
  flash?: { message: string; type: "success" | "error" };
}

/**
 * Emails list page — shows a filterable, bulk-selectable table of emails.
 * Includes status filter tabs, a Trash link, per-row checkboxes, a bulk
 * "Move to trash" action bar, and pagination.
 */
export function EmailsPage({
  emails,
  total,
  page,
  limit,
  status,
  flash,
}: EmailsPageProps) {
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
      <div class="flex items-center justify-between mb-6">
        <h1 class="text-xl font-semibold">Emails</h1>
        <a
          href="/dashboard/emails/trash"
          class="text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
        >
          Trash →
        </a>
      </div>

      {flash && <FlashMessage message={flash.message} type={flash.type} />}

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
          {/* Form wraps the table so the action bar can submit selected ids */}
          <form method="POST" action="/dashboard/emails/bulk-trash" id="emails-bulk-form">
            {/* Bulk action bar — visible only when at least one row is checked */}
            <div
              id="emails-bulk-bar"
              class="hidden mb-3 flex items-center justify-between bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-4 py-2 text-sm"
            >
              <span>
                <span id="emails-bulk-count">0</span> selected
              </span>
              <button
                type="submit"
                class="px-3 py-1.5 rounded-md bg-red-600 hover:bg-red-700 text-white text-sm font-medium"
                onclick="return confirm('Move selected emails to trash?')"
              >
                Move to trash
              </button>
            </div>

            {/* Emails table */}
            <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
              <table class="w-full text-sm">
                <thead>
                  <tr class="border-b border-gray-200 dark:border-gray-800">
                    <th class="px-4 py-3 w-10">
                      <input
                        type="checkbox"
                        id="emails-select-all"
                        class="h-4 w-4 rounded border-gray-300 dark:border-gray-700"
                      />
                    </th>
                    <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                      Status
                    </th>
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
                      Created
                    </th>
                    <th class="text-right px-4 py-3 font-medium text-gray-500 dark:text-gray-400 w-24">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
                  {emails.map((email) => (
                    <tr class="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                      <td class="px-4 py-3">
                        <input
                          type="checkbox"
                          name="ids"
                          value={email.id}
                          class="emails-row-check h-4 w-4 rounded border-gray-300 dark:border-gray-700"
                        />
                      </td>
                      <td class="px-4 py-3">
                        <StatusBadge status={email.status} />
                      </td>
                      <td class="px-4 py-3 text-gray-700 dark:text-gray-300 truncate max-w-[150px]">
                        <a
                          href={`/dashboard/emails/${email.id}`}
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
                      <td
                        class="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap"
                        title={email.createdAt.toISOString()}
                      >
                        {email.createdAt.toLocaleString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </td>
                      <td class="px-4 py-3 text-right">
                        {/* Per-row trash submits its own one-id form */}
                        <button
                          type="submit"
                          form={`emails-trash-${email.id}`}
                          class="text-xs text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300"
                          onclick="return confirm('Move this email to trash?')"
                        >
                          Trash
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </form>

          {/* Hidden one-id forms for the per-row "Trash" buttons.
              Kept outside the bulk form so a per-row click doesn't sweep up
              unrelated checkboxes. */}
          {emails.map((email) => (
            <form
              method="POST"
              action={`/dashboard/emails/${email.id}/trash`}
              id={`emails-trash-${email.id}`}
              class="hidden"
            />
          ))}

          {/* Pagination */}
          <Pagination
            page={page}
            limit={limit}
            total={total}
            baseUrl="/dashboard/emails"
            extraParams={status ? `status=${status}` : undefined}
          />

          {/* Selection-tracking script — toggles bulk bar and select-all checkbox */}
          <script>
            {`
              (function() {
                var selectAll = document.getElementById('emails-select-all');
                var bar = document.getElementById('emails-bulk-bar');
                var count = document.getElementById('emails-bulk-count');
                var rowChecks = function() {
                  return Array.from(document.querySelectorAll('.emails-row-check'));
                };
                function refresh() {
                  var checked = rowChecks().filter(function(c) { return c.checked; });
                  count.textContent = String(checked.length);
                  bar.classList.toggle('hidden', checked.length === 0);
                  if (selectAll) {
                    selectAll.checked = checked.length > 0 && checked.length === rowChecks().length;
                  }
                }
                if (selectAll) {
                  selectAll.addEventListener('change', function(e) {
                    rowChecks().forEach(function(c) { c.checked = e.target.checked; });
                    refresh();
                  });
                }
                rowChecks().forEach(function(c) {
                  c.addEventListener('change', refresh);
                });
              })();
            `}
          </script>
        </>
      )}
    </BaseLayout>
  );
}
