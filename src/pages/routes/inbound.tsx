import { BaseLayout } from "../layouts/base.tsx";
import { EmptyState } from "../components/empty-state.tsx";
import { Pagination } from "../components/pagination.tsx";
import { FlashMessage } from "../components/flash-message.tsx";
import { TimeDisplay } from "../components/time-display.tsx";
import type { InboundEmail } from "../../modules/inbound/types/inbound.types.ts";

/**
 * Props for the inbound emails list page.
 */
interface InboundPageProps {
  emails: InboundEmail[];
  total: number;
  page: number;
  limit: number;
  flash?: { message: string; type: "success" | "error" };
}

/**
 * Inbound emails list page — table of received emails with bulk-select trash
 * action, per-row trash button, Trash link, and pagination.
 */
export function InboundPage({ emails, total, page, limit, flash }: InboundPageProps) {
  return (
    <BaseLayout title="Inbound Emails" activeNav="inbound">
      <div class="flex items-center justify-between mb-6">
        <h1 class="text-xl font-semibold">Inbound Emails</h1>
        <a
          href="/dashboard/inbound/trash"
          class="text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
        >
          Trash →
        </a>
      </div>

      {flash && <FlashMessage message={flash.message} type={flash.type} />}

      {emails.length === 0 ? (
        <EmptyState message="No inbound emails yet. Emails sent to your configured addresses will appear here." />
      ) : (
        <>
          <form
            method="POST"
            action="/dashboard/inbound/bulk-trash"
            id="inbound-bulk-form"
          >
            <div
              id="inbound-bulk-bar"
              class="hidden mb-3 flex items-center justify-between bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-4 py-2 text-sm"
            >
              <span>
                <span id="inbound-bulk-count">0</span> selected
              </span>
              <button
                type="submit"
                class="px-3 py-1.5 rounded-md bg-red-600 hover:bg-red-700 text-white text-sm font-medium"
                onclick="return confirm('Move selected inbound emails to trash?')"
              >
                Move to trash
              </button>
            </div>

            <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
              <table class="w-full text-sm">
                <thead>
                  <tr class="border-b border-gray-200 dark:border-gray-800">
                    <th class="px-4 py-3 w-10">
                      <input
                        type="checkbox"
                        id="inbound-select-all"
                        class="h-4 w-4 rounded border-gray-300 dark:border-gray-700"
                      />
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
                      Received At
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
                          class="inbound-row-check h-4 w-4 rounded border-gray-300 dark:border-gray-700"
                        />
                      </td>
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
                        <TimeDisplay value={email.receivedAt} />
                      </td>
                      <td class="px-4 py-3 text-right">
                        <button
                          type="submit"
                          form={`inbound-trash-${email.id}`}
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

          {/* Hidden one-id forms for per-row "Trash" buttons */}
          {emails.map((email) => (
            <form
              method="POST"
              action={`/dashboard/inbound/${email.id}/trash`}
              id={`inbound-trash-${email.id}`}
              class="hidden"
            />
          ))}

          <Pagination
            page={page}
            limit={limit}
            total={total}
            baseUrl="/dashboard/inbound"
          />

          <script>
            {`
              (function() {
                var selectAll = document.getElementById('inbound-select-all');
                var bar = document.getElementById('inbound-bulk-bar');
                var count = document.getElementById('inbound-bulk-count');
                var rowChecks = function() {
                  return Array.from(document.querySelectorAll('.inbound-row-check'));
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
