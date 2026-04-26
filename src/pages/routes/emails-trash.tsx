import { BaseLayout } from "../layouts/base.tsx";
import { StatusBadge } from "../components/status-badge.tsx";
import { Pagination } from "../components/pagination.tsx";
import { EmptyState } from "../components/empty-state.tsx";
import { FlashMessage } from "../components/flash-message.tsx";
import { BackArrowIcon } from "../assets/icons.tsx";
import type { Email } from "../../modules/emails/types/email.types.ts";

interface EmailsTrashPageProps {
  emails: Email[];
  total: number;
  page: number;
  limit: number;
  retentionDays: number;
  flash?: { message: string; type: "success" | "error" };
}

/**
 * Trashed emails page — shows soft-deleted emails with bulk-select Restore /
 * Delete-forever / Empty-trash actions.
 *
 * The same form wraps the table; two submit buttons inside the bulk bar use
 * `formaction` to send the selected ids to either the restore or permanent
 * endpoint without needing client-side state for the action.
 */
export function EmailsTrashPage({
  emails,
  total,
  page,
  limit,
  retentionDays,
  flash,
}: EmailsTrashPageProps) {
  return (
    <BaseLayout title="Trashed Emails" activeNav="emails">
      <a
        href="/dashboard/emails"
        class="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 inline-flex items-center gap-1 mb-4"
      >
        <BackArrowIcon />
        Back to emails
      </a>

      <div class="flex items-center justify-between mb-2">
        <h1 class="text-xl font-semibold">Trashed Emails</h1>
        {emails.length > 0 && (
          <form
            method="POST"
            action="/dashboard/emails/trash/empty"
            onsubmit="return confirm('Permanently delete every trashed email? This cannot be undone.')"
          >
            <button
              type="submit"
              class="px-3 py-1.5 rounded-md bg-red-600 hover:bg-red-700 text-white text-sm font-medium"
            >
              Empty trash
            </button>
          </form>
        )}
      </div>
      <p class="text-xs text-gray-500 dark:text-gray-400 mb-6">
        Trashed emails are permanently deleted after {retentionDays} day
        {retentionDays === 1 ? "" : "s"}.
      </p>

      {flash && <FlashMessage message={flash.message} type={flash.type} />}

      {emails.length === 0 ? (
        <EmptyState message="Trash is empty." />
      ) : (
        <>
          <form
            id="emails-trash-form"
            method="POST"
            action="/dashboard/emails/trash/bulk-restore"
          >
            <div
              id="emails-trash-bar"
              class="hidden mb-3 flex items-center justify-between bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-4 py-2 text-sm"
            >
              <span>
                <span id="emails-trash-count">0</span> selected
              </span>
              <div class="flex items-center gap-2">
                <button
                  type="submit"
                  formaction="/dashboard/emails/trash/bulk-restore"
                  class="px-3 py-1.5 rounded-md bg-gray-900 hover:bg-gray-800 text-white dark:bg-gray-100 dark:hover:bg-gray-200 dark:text-gray-900 text-sm font-medium"
                >
                  Restore
                </button>
                <button
                  type="submit"
                  formaction="/dashboard/emails/trash/bulk-permanent"
                  class="px-3 py-1.5 rounded-md bg-red-600 hover:bg-red-700 text-white text-sm font-medium"
                  onclick="return confirm('Permanently delete selected emails? This cannot be undone.')"
                >
                  Delete forever
                </button>
              </div>
            </div>

            <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
              <table class="w-full text-sm">
                <thead>
                  <tr class="border-b border-gray-200 dark:border-gray-800">
                    <th class="px-4 py-3 w-10">
                      <input
                        type="checkbox"
                        id="emails-trash-select-all"
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
                      Trashed
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
                          class="emails-trash-row-check h-4 w-4 rounded border-gray-300 dark:border-gray-700"
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
                      <td class="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                        {email.deletedAt?.toLocaleDateString() ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </form>

          <Pagination
            page={page}
            limit={limit}
            total={total}
            baseUrl="/dashboard/emails/trash"
          />

          <script>
            {`
              (function() {
                var selectAll = document.getElementById('emails-trash-select-all');
                var bar = document.getElementById('emails-trash-bar');
                var count = document.getElementById('emails-trash-count');
                var rowChecks = function() {
                  return Array.from(document.querySelectorAll('.emails-trash-row-check'));
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
