import { BaseLayout } from "../layouts/base.tsx";
import { FlashMessage } from "../components/flash-message.tsx";
import { EmptyState } from "../components/empty-state.tsx";
import type { Webhook } from "../../modules/webhooks/types/webhook.types.ts";

/**
 * Props for the webhooks list page.
 */
interface WebhooksPageProps {
  webhooks: Webhook[];
  flash?: { message: string; type: "success" | "error" };
  secret?: string;
}

const WEBHOOK_EVENTS = [
  "email.queued",
  "email.sent",
  "email.failed",
  "email.bounced",
] as const;

/**
 * Webhooks page — shows a create form and table of all webhooks.
 * After creating a webhook, the signing secret is displayed once.
 */
export function WebhooksPage({ webhooks, flash, secret }: WebhooksPageProps) {
  return (
    <BaseLayout title="Webhooks" activeNav="webhooks">
      <h1 class="text-xl font-semibold mb-6">Webhooks</h1>

      {/* Flash message */}
      {flash && <FlashMessage message={flash.message} type={flash.type} />}

      {/* Signing secret shown once after creation */}
      {secret && (
        <div class="bg-emerald-50 text-emerald-800 border border-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:border-emerald-800 rounded-lg px-4 py-3 text-sm mb-4">
          <p class="font-medium mb-1">
            Webhook created — copy the signing secret now, it won't be shown again:
          </p>
          <code class="block bg-emerald-100 dark:bg-emerald-900 px-3 py-2 rounded font-mono text-xs break-all select-all">
            {secret}
          </code>
        </div>
      )}

      {/* Create webhook form */}
      <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4 mb-6">
        <form method="POST" action="/dashboard/webhooks" class="space-y-4">
          <div>
            <label
              for="url"
              class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              URL
            </label>
            <input
              type="url"
              id="url"
              name="url"
              required
              placeholder="https://your-app.com/webhook"
              class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500 focus:border-transparent"
            />
          </div>
          <div>
            <span class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Events
            </span>
            <div class="flex flex-wrap gap-3">
              {WEBHOOK_EVENTS.map((event) => (
                <label class="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                  <input
                    type="checkbox"
                    name="events"
                    value={event}
                    class="rounded border-gray-300 dark:border-gray-600"
                  />
                  {event}
                </label>
              ))}
            </div>
          </div>
          <button
            type="submit"
            class="px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium rounded-lg hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors"
          >
            Create Webhook
          </button>
        </form>
      </div>

      {webhooks.length === 0 ? (
        <EmptyState message="No webhooks yet. Create one above to receive event notifications." />
      ) : (
        /* Webhooks table */
        <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-gray-200 dark:border-gray-800">
                <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  URL
                </th>
                <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  Events
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
              {webhooks.map((webhook) => (
                <tr class="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                  <td
                    class="px-4 py-3 text-gray-700 dark:text-gray-300 truncate max-w-[200px]"
                    safe
                  >
                    {webhook.url}
                  </td>
                  <td class="px-4 py-3">
                    <div class="flex flex-wrap gap-1">
                      {(Array.isArray(webhook.events) ? webhook.events : []).map(
                        (ev: string) => (
                          <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                            {ev}
                          </span>
                        ),
                      )}
                    </div>
                  </td>
                  <td class="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {webhook.createdAt.toLocaleDateString()}
                  </td>
                  <td class="px-4 py-3">
                    <form
                      method="POST"
                      action={`/dashboard/webhooks/${webhook.id}/delete`}
                    >
                      <button
                        type="submit"
                        class="text-xs text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 font-medium"
                        onclick="return confirm('Are you sure you want to delete this webhook?')"
                      >
                        Delete
                      </button>
                    </form>
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
