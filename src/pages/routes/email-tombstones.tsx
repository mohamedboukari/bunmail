import { BaseLayout } from "../layouts/base.tsx";
import { Pagination } from "../components/pagination.tsx";
import { EmptyState } from "../components/empty-state.tsx";
import type { EmailTombstone } from "../../modules/emails/models/email-tombstone.schema.ts";

interface EmailTombstonesPageProps {
  tombstones: EmailTombstone[];
  total: number;
  page: number;
  limit: number;
  /** Active Message-ID filter (operator typed it into the search box). */
  messageIdFilter?: string;
}

/**
 * Email tombstones (#34) — post-purge audit trail.
 *
 * Operators land here to answer "did we ever send the message that
 * just bounced / generated this complaint?". Each row is a snapshot
 * of an email after it was hard-deleted (either by the trash purge
 * sweep or by an explicit `permanent` action). The body is gone but
 * identifiers — id, Message-ID, recipient, subject, status — survive
 * for 90 days by default.
 */
export function EmailTombstonesPage({
  tombstones,
  total,
  page,
  limit,
  messageIdFilter,
}: EmailTombstonesPageProps) {
  return (
    <BaseLayout title="Email tombstones" activeNav="emails">
      <div class="mb-4">
        <a
          href="/dashboard/emails"
          class="text-sm text-gray-600 dark:text-gray-400 hover:underline"
        >
          ← All emails
        </a>
      </div>

      <h1 class="text-xl font-semibold mb-1">Tombstones</h1>
      <p class="text-sm text-gray-600 dark:text-gray-400 mb-6">
        Post-purge audit snapshots of hard-deleted emails. Use these to trace late
        complaints and bounces back to a sent message after the original row is gone.
      </p>

      {/* Search by Message-ID — the canonical "did we send this?" query */}
      <form
        method="GET"
        action="/dashboard/emails/tombstones"
        class="flex flex-wrap items-center gap-2 mb-4"
      >
        <input
          type="text"
          name="messageId"
          placeholder="Paste a Message-ID to find a sent message"
          value={messageIdFilter ?? ""}
          class="flex-1 min-w-[300px] px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500 focus:border-transparent"
        />
        <button
          type="submit"
          class="px-4 py-2 bg-gray-900 text-white text-sm rounded-lg hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-300"
        >
          Search
        </button>
        {messageIdFilter && (
          <a
            href="/dashboard/emails/tombstones"
            class="px-3 py-2 text-sm text-gray-600 dark:text-gray-400 hover:underline"
          >
            Clear
          </a>
        )}
      </form>

      {tombstones.length === 0 ? (
        <EmptyState
          message={
            messageIdFilter
              ? `No tombstone matches Message-ID "${messageIdFilter}". Either we never sent it, or it was hard-deleted more than ${90} days ago and the tombstone has aged out.`
              : "No tombstones yet. They appear here whenever the trash purge sweep or a permanent-delete action hard-deletes an email."
          }
        />
      ) : (
        <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-gray-50 dark:bg-gray-800/50 text-left">
              <tr>
                <th class="px-4 py-3 font-medium text-gray-700 dark:text-gray-300">
                  Email ID
                </th>
                <th class="px-4 py-3 font-medium text-gray-700 dark:text-gray-300">
                  Message-ID
                </th>
                <th class="px-4 py-3 font-medium text-gray-700 dark:text-gray-300">To</th>
                <th class="px-4 py-3 font-medium text-gray-700 dark:text-gray-300">
                  Subject
                </th>
                <th class="px-4 py-3 font-medium text-gray-700 dark:text-gray-300">
                  Status
                </th>
                <th class="px-4 py-3 font-medium text-gray-700 dark:text-gray-300">
                  Sent
                </th>
                <th class="px-4 py-3 font-medium text-gray-700 dark:text-gray-300">
                  Purged
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-200 dark:divide-gray-800">
              {tombstones.map((t) => (
                <tr class="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                  <td class="px-4 py-3 font-mono text-xs">{t.id}</td>
                  <td class="px-4 py-3 font-mono text-xs break-all" safe>
                    {t.messageId ?? <span class="text-gray-400">—</span>}
                  </td>
                  <td class="px-4 py-3 text-xs text-gray-700 dark:text-gray-300" safe>
                    {t.toAddress}
                  </td>
                  <td class="px-4 py-3 text-xs truncate max-w-[300px]" safe>
                    {t.subject ?? <span class="text-gray-400">—</span>}
                  </td>
                  <td class="px-4 py-3">
                    <StatusBadge status={t.status} />
                  </td>
                  <td class="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {t.sentAt ? (
                      t.sentAt.toISOString().slice(0, 10)
                    ) : (
                      <span class="text-gray-400">—</span>
                    )}
                  </td>
                  <td class="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {t.purgedAt.toISOString().slice(0, 10)}
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
        baseUrl="/dashboard/emails/tombstones"
        extraParams={
          messageIdFilter ? `messageId=${encodeURIComponent(messageIdFilter)}` : undefined
        }
      />
    </BaseLayout>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    sent: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
    bounced: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
    failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
    queued: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300",
    sending: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  };
  const cls = styles[status] ?? "bg-gray-100 text-gray-800 dark:bg-gray-800";
  return <span class={`px-2 py-0.5 text-xs rounded ${cls}`}>{status}</span>;
}
