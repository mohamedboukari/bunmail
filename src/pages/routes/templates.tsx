import { BaseLayout } from "../layouts/base.tsx";
import { FlashMessage } from "../components/flash-message.tsx";
import { EmptyState } from "../components/empty-state.tsx";
import type { Template } from "../../modules/templates/types/template.types.ts";

interface TemplatesPageProps {
  templates: Template[];
  flash?: { message: string; type: "success" | "error" };
}

/**
 * Templates page — shows a create form and table of all email templates.
 */
export function TemplatesPage({ templates, flash }: TemplatesPageProps) {
  return (
    <BaseLayout title="Templates" activeNav="templates">
      <h1 class="text-xl font-semibold mb-6">Templates</h1>

      {flash && <FlashMessage message={flash.message} type={flash.type} />}

      {/* Create template form */}
      <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4 mb-6">
        <form method="POST" action="/dashboard/templates" class="space-y-4">
          <div>
            <label
              for="name"
              class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              Name
            </label>
            <input
              type="text"
              id="name"
              name="name"
              required
              placeholder="e.g. Welcome Email"
              class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500 focus:border-transparent"
            />
          </div>
          <div>
            <label
              for="subject"
              class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              Subject
            </label>
            <input
              type="text"
              id="subject"
              name="subject"
              required
              placeholder="e.g. Welcome to {{company}}"
              class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500 focus:border-transparent"
            />
          </div>
          <div>
            <label
              for="html"
              class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              HTML
            </label>
            <textarea
              id="html"
              name="html"
              rows="6"
              placeholder={"<p>Hello {{name}}, welcome!</p>"}
              class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500 focus:border-transparent font-mono"
            />
          </div>
          <div>
            <label
              for="text"
              class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              Plain Text (optional)
            </label>
            <textarea
              id="text"
              name="text"
              rows="3"
              placeholder="Plain text fallback"
              class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500 focus:border-transparent"
            />
          </div>
          <div>
            <label
              for="variables"
              class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              Variables (optional)
            </label>
            <input
              type="text"
              id="variables"
              name="variables"
              placeholder="comma-separated: name, company, link"
              class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500 focus:border-transparent"
            />
          </div>
          <button
            type="submit"
            class="px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium rounded-lg hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors"
          >
            Create Template
          </button>
        </form>
      </div>

      {templates.length === 0 ? (
        <EmptyState message="No templates yet. Create one above to get started." />
      ) : (
        <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-gray-200 dark:border-gray-800">
                <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  Name
                </th>
                <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  Subject
                </th>
                <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  Variables
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
              {templates.map((template) => (
                <tr class="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                  <td class="px-4 py-3 font-medium text-gray-900 dark:text-gray-100">
                    <a
                      href={`/dashboard/templates/${template.id}`}
                      class="hover:underline"
                      safe
                    >
                      {template.name}
                    </a>
                  </td>
                  <td
                    class="px-4 py-3 text-gray-700 dark:text-gray-300 truncate max-w-[200px]"
                    safe
                  >
                    {template.subject}
                  </td>
                  <td class="px-4 py-3 text-gray-500 dark:text-gray-400">
                    {template.variables && template.variables.length > 0
                      ? template.variables.join(", ")
                      : "—"}
                  </td>
                  <td class="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {template.createdAt.toLocaleDateString()}
                  </td>
                  <td class="px-4 py-3">
                    <form
                      method="POST"
                      action={`/dashboard/templates/${template.id}/delete`}
                    >
                      <button
                        type="submit"
                        class="text-xs text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 font-medium"
                        onclick="return confirm('Are you sure you want to delete this template?')"
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
