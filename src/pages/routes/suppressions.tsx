import { BaseLayout } from "../layouts/base.tsx";
import { FlashMessage } from "../components/flash-message.tsx";
import { EmptyState } from "../components/empty-state.tsx";
import { Pagination } from "../components/pagination.tsx";
import { TimeDisplay } from "../components/time-display.tsx";
import type { Suppression } from "../../modules/suppressions/types/suppression.types.ts";
import type { ApiKey } from "../../modules/api-keys/types/api-key.types.ts";

/**
 * Lookup map (`ApiKey.id` → name) so the table can render a
 * human-readable name next to each suppression row's owning key.
 * Falls back to "(unknown)" when the owning key has been deleted.
 */
type ApiKeyLabelMap = Record<string, { name: string }>;

interface SuppressionsPageProps {
  /** Page-scoped slice of suppressions to render. */
  suppressions: Suppression[];
  /** Total matching rows across all pages, for the paginator. */
  total: number;
  page: number;
  limit: number;
  /** Current filter values, used to repopulate the form. */
  filters: {
    email?: string;
    apiKeyId?: string;
  };
  /** All API keys for the filter dropdown. */
  apiKeys: ApiKey[];
  /** Lookup map for rendering owning-key labels. */
  apiKeyLabels: ApiKeyLabelMap;
  flash?: { message: string; type: "success" | "error" };
}

/**
 * Suppressions page (#89) — admin-scoped list across all API keys.
 *
 * Why unscoped: auto-suppressions get filed under whichever API key
 * happened to be sending when the bounce came in, which usually isn't
 * the API key in the operator's Bearer token. Before this page, the
 * only way to clear a stuck suppression was direct SQL. Now it's two
 * clicks.
 */
export function SuppressionsPage({
  suppressions,
  total,
  page,
  limit,
  filters,
  apiKeys,
  apiKeyLabels,
  flash,
}: SuppressionsPageProps) {
  return (
    <BaseLayout title="Suppressions" activeNav="suppressions">
      <h1 class="text-xl font-semibold mb-6">Suppressions</h1>

      {flash && <FlashMessage message={flash.message} type={flash.type} />}

      {/* Filter form — email substring + api key drilldown */}
      <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4 mb-6">
        <form
          method="GET"
          action="/dashboard/suppressions"
          class="flex flex-wrap gap-3 items-end"
        >
          <div class="flex-1 min-w-[200px]">
            <label
              for="email"
              class="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1"
            >
              Email contains
            </label>
            <input
              type="text"
              id="email"
              name="email"
              value={filters.email ?? ""}
              placeholder="e.g. gmail.com"
              class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500"
            />
          </div>
          <div class="min-w-[200px]">
            <label
              for="apiKeyId"
              class="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1"
            >
              API key
            </label>
            <select
              id="apiKeyId"
              name="apiKeyId"
              class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500"
            >
              <option value="">All keys</option>
              {apiKeys.map((k) => (
                <option value={k.id} selected={k.id === filters.apiKeyId}>
                  {/* Name first, then id suffix in muted form for disambiguation. */}
                  {`${k.name} — ${k.id.slice(0, 12)}…`}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            class="px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium rounded-lg hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors whitespace-nowrap"
          >
            Apply
          </button>
          {(filters.email || filters.apiKeyId) && (
            <a
              href="/dashboard/suppressions"
              class="px-4 py-2 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors whitespace-nowrap"
            >
              Clear
            </a>
          )}
        </form>
      </div>

      {suppressions.length === 0 ? (
        <EmptyState
          message={
            filters.email || filters.apiKeyId
              ? "No suppressions match the current filters."
              : "No suppressions. Recipients added here (manually or via hard bounces) are blocked from receiving mail under their API key."
          }
        />
      ) : (
        <>
          <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-gray-200 dark:border-gray-800">
                  <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                    Email
                  </th>
                  <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                    Reason
                  </th>
                  <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                    Bounce
                  </th>
                  <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                    Owning API key
                  </th>
                  <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                    Source email
                  </th>
                  <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                    Expires
                  </th>
                  <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                    Created
                  </th>
                  <th class="text-right px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
                {suppressions.map((sup) => {
                  const keyLabel = apiKeyLabels[sup.apiKeyId]?.name ?? "(unknown)";
                  return (
                    <tr class="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                      <td
                        class="px-4 py-3 font-mono text-xs text-gray-900 dark:text-gray-100 break-all"
                        safe
                      >
                        {sup.email}
                      </td>
                      <td class="px-4 py-3 text-gray-700 dark:text-gray-300" safe>
                        {sup.reason}
                      </td>
                      <td class="px-4 py-3 text-gray-700 dark:text-gray-300">
                        {sup.bounceType ? (
                          <span
                            class={`inline-flex items-center px-2 py-0.5 text-xs rounded ${
                              sup.bounceType === "hard"
                                ? "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300"
                                : "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300"
                            }`}
                            safe
                          >
                            {sup.bounceType}
                          </span>
                        ) : (
                          <span class="text-gray-400 dark:text-gray-600">—</span>
                        )}
                      </td>
                      <td class="px-4 py-3 text-gray-700 dark:text-gray-300" safe>
                        {`${keyLabel} (${sup.apiKeyId.slice(0, 12)}…)`}
                      </td>
                      <td class="px-4 py-3">
                        {sup.sourceEmailId ? (
                          <a
                            href={`/dashboard/emails/${sup.sourceEmailId}`}
                            class="text-xs font-mono text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:underline"
                            safe
                          >
                            {sup.sourceEmailId.slice(0, 14) + "…"}
                          </a>
                        ) : (
                          <span class="text-gray-400 dark:text-gray-600">—</span>
                        )}
                      </td>
                      <td class="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap text-xs">
                        <TimeDisplay value={sup.expiresAt} fallback="Permanent" />
                      </td>
                      <td class="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap text-xs">
                        <TimeDisplay value={sup.createdAt} />
                      </td>
                      <td class="px-4 py-3 text-right">
                        <form
                          method="POST"
                          action={`/dashboard/suppressions/${sup.id}/delete`}
                          class="inline"
                        >
                          <button
                            type="submit"
                            class="text-xs text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 font-medium"
                            onclick={`return confirm('Remove the suppression for ${sup.email}? They will be able to receive mail from this API key again.')`}
                          >
                            Delete
                          </button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <Pagination
            page={page}
            limit={limit}
            total={total}
            baseUrl="/dashboard/suppressions"
            extraParams={new URLSearchParams(
              Object.fromEntries(
                Object.entries(filters).filter(([, v]) => v !== undefined && v !== ""),
              ) as Record<string, string>,
            ).toString()}
          />
        </>
      )}
    </BaseLayout>
  );
}
