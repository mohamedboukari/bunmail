import { BaseLayout } from "../layouts/base.tsx";

/**
 * 429 page for a CSV export refused by the per-user budget (#430).
 * Rendered inside the dashboard layout so the admin can navigate on.
 * `retryAfterMinutes` is computed by BunMail, escaped anyway.
 */
export function ExportLimitedPage({ retryAfterMinutes }: { retryAfterMinutes: number }) {
  return (
    <BaseLayout title="Too many exports">
      <h1 class="text-xl font-semibold mb-6">Too many exports</h1>
      <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-8">
        <p class="text-sm text-gray-700 dark:text-gray-300 mb-3" safe>
          {`You have reached the CSV export limit. Try again in about ${retryAfterMinutes} minute${retryAfterMinutes === 1 ? "" : "s"}.`}
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
