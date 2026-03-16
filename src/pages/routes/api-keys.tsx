import { BaseLayout } from "../layouts/base.tsx";
import { FlashMessage } from "../components/flash-message.tsx";
import { EmptyState } from "../components/empty-state.tsx";
import type { ApiKey } from "../../modules/api-keys/types/api-key.types.ts";

/**
 * Props for the API keys list page.
 */
interface ApiKeysPageProps {
  /** All API keys (active + revoked) */
  keys: ApiKey[];
  /** Optional flash message (e.g. after creating or revoking a key) */
  flash?: { message: string; type: "success" | "error" };
  /** If a key was just created, show the raw key once */
  rawKey?: string;
}

/**
 * API Keys page — shows a create form and table of all API keys.
 * After creating a key, the raw key is displayed in a flash message (shown once).
 */
export function ApiKeysPage({ keys, flash, rawKey }: ApiKeysPageProps) {
  return (
    <BaseLayout title="API Keys" activeNav="api-keys">
      <h1 class="text-xl font-semibold mb-6">API Keys</h1>

      {/* Flash message */}
      {flash && <FlashMessage message={flash.message} type={flash.type} />}

      {/* Raw key shown once after creation */}
      {rawKey && (
        <div class="bg-emerald-50 text-emerald-800 border border-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:border-emerald-800 rounded-lg px-4 py-3 text-sm mb-4">
          <p class="font-medium mb-1">
            API key created — copy it now, it won't be shown again:
          </p>
          <code class="block bg-emerald-100 dark:bg-emerald-900 px-3 py-2 rounded font-mono text-xs break-all select-all">
            {rawKey}
          </code>
        </div>
      )}

      {/* Create API key form */}
      <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4 mb-6">
        <form method="POST" action="/dashboard/api-keys" class="flex gap-3">
          <input
            type="text"
            name="name"
            required
            placeholder="Key name (e.g. Production)"
            class="flex-1 px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500 focus:border-transparent"
          />
          <button
            type="submit"
            class="px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium rounded-lg hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors whitespace-nowrap"
          >
            Create Key
          </button>
        </form>
      </div>

      {keys.length === 0 ? (
        <EmptyState message="No API keys yet. Create one above to get started." />
      ) : (
        /* API keys table */
        <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-gray-200 dark:border-gray-800">
                <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  Name
                </th>
                <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  Prefix
                </th>
                <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  Status
                </th>
                <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  Last Used
                </th>
                <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  Created
                </th>
                <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
              {keys.map((key) => (
                <tr class="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                  <td class="px-4 py-3 font-medium text-gray-900 dark:text-gray-100" safe>
                    {key.name}
                  </td>
                  <td class="px-4 py-3 font-mono text-xs text-gray-500 dark:text-gray-400">
                    {key.keyPrefix}...
                  </td>
                  <td class="px-4 py-3">
                    {key.isActive ? (
                      <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                        Active
                      </span>
                    ) : (
                      <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                        Revoked
                      </span>
                    )}
                  </td>
                  <td class="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {key.lastUsedAt ? key.lastUsedAt.toLocaleDateString() : "Never"}
                  </td>
                  <td class="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {key.createdAt.toLocaleDateString()}
                  </td>
                  <td class="px-4 py-3">
                    {key.isActive && (
                      <form method="POST" action={`/dashboard/api-keys/${key.id}/revoke`}>
                        <button
                          type="submit"
                          class="text-xs text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 font-medium"
                          onclick="return confirm('Are you sure you want to revoke this key?')"
                        >
                          Revoke
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </BaseLayout>
  );
}
