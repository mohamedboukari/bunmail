import { BaseLayout } from "../layouts/base.tsx";

/**
 * 410 page for an attachment whose bytes are no longer stored (#181):
 * BunMail drops them once the email reaches a final state (sent, failed,
 * bounced) and keeps only the metadata. The email id comes from a stored
 * row, and is escaped like any other value.
 */
export function AttachmentGonePage({ emailId }: { emailId: string }) {
  return (
    <BaseLayout title="Attachment no longer stored" activeNav="emails">
      <h1 class="text-xl font-semibold mb-6">Attachment no longer stored</h1>
      <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-8">
        <p class="text-sm text-gray-700 dark:text-gray-300 mb-3">
          BunMail keeps attachment files only until the email is sent, fails or bounces.
          Its name, type and size are still shown on the email page.
        </p>
        <a
          href={`/dashboard/emails/${encodeURIComponent(emailId)}`}
          class="inline-block mt-6 text-sm font-medium px-4 py-2 rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors"
        >
          Back to the email
        </a>
      </div>
    </BaseLayout>
  );
}
