import { BaseLayout } from "../layouts/base.tsx";
import { FlashMessage } from "../components/flash-message.tsx";
import type { Template } from "../../modules/templates/types/template.types.ts";

interface TemplateDetailPageProps {
  template: Template;
  flash?: { message: string; type: "success" | "error" };
}

/**
 * Template detail page — view and edit a single email template.
 */
export function TemplateDetailPage({ template, flash }: TemplateDetailPageProps) {
  const variablesValue = template.variables && template.variables.length > 0
    ? template.variables.join(", ")
    : "";

  return (
    <BaseLayout title="Template Detail" activeNav="templates">
      <a
        href="/dashboard/templates"
        class="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 inline-flex items-center gap-1 mb-4"
      >
        <svg
          class="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          stroke-width="1.5"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18"
          />
        </svg>
        Back to templates
      </a>

      <h1 class="text-xl font-semibold mb-6" safe>
        {template.name}
      </h1>

      {flash && <FlashMessage message={flash.message} type={flash.type} />}

      {/* Edit form */}
      <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4 mb-6">
        <form method="POST" action={`/dashboard/templates/${template.id}/edit`} class="space-y-4">
          <div>
            <label for="name" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Name
            </label>
            <input
              type="text"
              id="name"
              name="name"
              required
              value={template.name}
              placeholder="e.g. Welcome Email"
              class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500 focus:border-transparent"
            />
          </div>
          <div>
            <label for="subject" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Subject
            </label>
            <input
              type="text"
              id="subject"
              name="subject"
              required
              value={template.subject}
              placeholder="e.g. Welcome to {{company}}"
              class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500 focus:border-transparent"
            />
          </div>
          <div>
            <label for="html" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              HTML
            </label>
            <textarea
              id="html"
              name="html"
              rows="6"
              placeholder={'<p>Hello {{name}}, welcome!</p>'}
              class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500 focus:border-transparent font-mono"
            >
              {template.html ?? ""}
            </textarea>
          </div>
          <div>
            <label for="text" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Plain Text (optional)
            </label>
            <textarea
              id="text"
              name="text"
              rows="3"
              placeholder="Plain text fallback"
              class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500 focus:border-transparent"
            >
              {template.textContent ?? ""}
            </textarea>
          </div>
          <div>
            <label for="variables" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Variables (optional)
            </label>
            <input
              type="text"
              id="variables"
              name="variables"
              value={variablesValue}
              placeholder="comma-separated: name, company, link"
              class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500 focus:border-transparent"
            />
          </div>
          <div class="flex gap-3">
            <button
              type="submit"
              class="px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium rounded-lg hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors"
            >
              Save Changes
            </button>
          </div>
        </form>

        <form method="POST" action={`/dashboard/templates/${template.id}/delete`} class="mt-4 pt-4 border-t border-gray-200 dark:border-gray-800">
          <button
            type="submit"
            class="text-xs text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 font-medium"
            onclick="return confirm('Are you sure you want to delete this template?')"
          >
            Delete Template
          </button>
        </form>
      </div>
    </BaseLayout>
  );
}
