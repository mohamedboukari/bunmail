import { BaseLayout } from "../layouts/base.tsx";

/**
 * 403 page for a signed-in user whose role or session assurance is below
 * what the route requires (#222). Rendered inside the dashboard layout so
 * the user can navigate on. `message` is built from code constants (role
 * and assurance names), but it is escaped like any other value.
 */
export function ForbiddenPage({ message }: { message: string }) {
  return (
    <BaseLayout title="Forbidden">
      <h1 class="text-xl font-semibold mb-6">Forbidden</h1>
      <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-8">
        <p class="text-sm text-gray-700 dark:text-gray-300 mb-3" safe>
          {message}
        </p>
        <p class="text-sm text-gray-500 dark:text-gray-400">
          Ask the owner of this BunMail instance if you need this access.
        </p>
        <a
          href="/dashboard"
          class="inline-block mt-6 text-sm font-medium px-4 py-2 rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors"
        >
          Back to the dashboard
        </a>
      </div>
    </BaseLayout>
  );
}
