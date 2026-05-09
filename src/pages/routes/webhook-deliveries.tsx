import { BaseLayout } from "../layouts/base.tsx";
import { Pagination } from "../components/pagination.tsx";
import { EmptyState } from "../components/empty-state.tsx";
import type { Webhook } from "../../modules/webhooks/types/webhook.types.ts";
import type { WebhookDelivery } from "../../modules/webhooks/models/webhook-delivery.schema.ts";

interface WebhookDeliveriesPageProps {
  webhook: Webhook;
  deliveries: WebhookDelivery[];
  total: number;
  page: number;
  limit: number;
  /** Active status filter, or undefined for "all". */
  statusFilter?: "pending" | "delivered" | "failed";
}

const STATUS_FILTERS: Array<{
  value: "all" | "pending" | "delivered" | "failed";
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "delivered", label: "Delivered" },
  { value: "failed", label: "Failed" },
];

/**
 * Webhook delivery history (#30) — paginated table of every dispatch
 * attempt for one webhook. Operators land here from `/dashboard/webhooks`
 * to check whether events actually delivered, and click into a row to
 * see the full payload + replay a failed delivery.
 */
export function WebhookDeliveriesPage({
  webhook,
  deliveries,
  total,
  page,
  limit,
  statusFilter,
}: WebhookDeliveriesPageProps) {
  const baseUrl = `/dashboard/webhooks/${webhook.id}/deliveries`;

  return (
    <BaseLayout title={`Deliveries: ${webhook.url}`} activeNav="webhooks">
      <div class="mb-4">
        <a
          href="/dashboard/webhooks"
          class="text-sm text-gray-600 dark:text-gray-400 hover:underline"
        >
          ← All webhooks
        </a>
      </div>

      <h1 class="text-xl font-semibold mb-1">Webhook deliveries</h1>
      <p class="text-sm text-gray-600 dark:text-gray-400 mb-6 break-all" safe>
        {webhook.url}
      </p>

      {/* Status filter pills */}
      <div class="flex flex-wrap items-center gap-2 mb-4">
        <span class="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Status
        </span>
        {STATUS_FILTERS.map((f) => {
          const active = (f.value === "all" && !statusFilter) || f.value === statusFilter;
          const href = f.value === "all" ? baseUrl : `${baseUrl}?status=${f.value}`;
          return (
            <a
              href={href}
              class={`px-3 py-1 rounded text-sm ${
                active
                  ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
                  : "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300"
              }`}
            >
              {f.label}
            </a>
          );
        })}
      </div>

      {deliveries.length === 0 ? (
        <EmptyState message="No deliveries match this filter yet. Trigger an event subscribed by this webhook to see delivery records here." />
      ) : (
        <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-gray-50 dark:bg-gray-800/50 text-left">
              <tr>
                <th class="px-4 py-3 font-medium text-gray-700 dark:text-gray-300">
                  Event
                </th>
                <th class="px-4 py-3 font-medium text-gray-700 dark:text-gray-300">
                  Status
                </th>
                <th class="px-4 py-3 font-medium text-gray-700 dark:text-gray-300">
                  Attempts
                </th>
                <th class="px-4 py-3 font-medium text-gray-700 dark:text-gray-300">
                  Last response
                </th>
                <th class="px-4 py-3 font-medium text-gray-700 dark:text-gray-300">
                  Created
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-200 dark:divide-gray-800">
              {deliveries.map((d) => (
                <tr class="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                  <td class="px-4 py-3">
                    <a
                      href={`/dashboard/webhooks/deliveries/${d.id}`}
                      class="text-blue-600 dark:text-blue-400 hover:underline font-mono text-xs"
                    >
                      {d.event}
                    </a>
                  </td>
                  <td class="px-4 py-3">
                    <StatusBadge status={d.status} />
                  </td>
                  <td class="px-4 py-3 text-gray-700 dark:text-gray-300">{d.attempts}</td>
                  <td class="px-4 py-3 text-xs text-gray-600 dark:text-gray-400">
                    {d.lastResponseStatus !== null ? (
                      <span class="font-mono">HTTP {d.lastResponseStatus}</span>
                    ) : d.lastError ? (
                      <span class="text-red-600 dark:text-red-400 truncate" safe>
                        {d.lastError.slice(0, 60)}
                      </span>
                    ) : (
                      <span class="text-gray-400">—</span>
                    )}
                  </td>
                  <td class="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {d.createdAt.toISOString().slice(0, 19).replace("T", " ")}
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
        baseUrl={baseUrl}
        extraParams={statusFilter ? `status=${statusFilter}` : undefined}
      />
    </BaseLayout>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
    delivered: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
    failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  };
  const cls = styles[status] ?? "bg-gray-100 text-gray-800 dark:bg-gray-800";
  return <span class={`px-2 py-0.5 text-xs rounded ${cls}`}>{status}</span>;
}
