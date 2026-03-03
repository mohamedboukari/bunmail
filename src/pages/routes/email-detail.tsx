import { BaseLayout } from "../layouts/base.tsx";
import { StatusBadge } from "../components/status-badge.tsx";
import type { Email } from "../../modules/emails/types/email.types.ts";

/**
 * Email detail page — shows all fields of a single email.
 * Includes HTML preview, text content, and full metadata.
 */
export function EmailDetailPage({ email }: { email: Email }) {
  return (
    <BaseLayout title={`Email ${email.id}`} activeNav="emails">
      {/* Back link */}
      <a
        href="/dashboard/emails"
        class="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 inline-flex items-center gap-1 mb-4"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
        </svg>
        Back to emails
      </a>

      {/* Header with status */}
      <div class="flex items-center gap-3 mb-6">
        <h1 class="text-xl font-semibold" safe>{email.subject}</h1>
        <StatusBadge status={email.status} />
      </div>

      {/* Details grid */}
      <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-5 mb-6">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
          <DetailField label="ID" value={email.id} />
          <DetailField label="Status" value={email.status} />
          <DetailField label="From" value={email.fromAddress} />
          <DetailField label="To" value={email.toAddress} />
          {email.cc && <DetailField label="CC" value={email.cc} />}
          {email.bcc && <DetailField label="BCC" value={email.bcc} />}
          <DetailField label="Attempts" value={String(email.attempts)} />
          {email.lastError && <DetailField label="Last Error" value={email.lastError} />}
          {email.messageId && <DetailField label="Message ID" value={email.messageId} />}
          <DetailField label="Created" value={email.createdAt.toISOString()} />
          {email.sentAt && <DetailField label="Sent At" value={email.sentAt.toISOString()} />}
        </div>
      </div>

      {/* HTML preview */}
      {email.html && (
        <div class="mb-6">
          <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">HTML Preview</h2>
          <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4 overflow-auto max-h-96">
            {/* Render HTML content in a sandboxed iframe */}
            <iframe
              srcdoc={email.html}
              class="w-full min-h-[200px] border-0"
              sandbox=""
              title="Email HTML preview"
            ></iframe>
          </div>
        </div>
      )}

      {/* Text content */}
      {email.textContent && (
        <div>
          <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">Text Content</h2>
          <pre class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4 text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap" safe>
            {email.textContent}
          </pre>
        </div>
      )}
    </BaseLayout>
  );
}

/**
 * Detail field — label + value pair used in the details grid.
 */
function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p class="text-gray-500 dark:text-gray-400 text-xs uppercase tracking-wide mb-0.5">{label}</p>
      <p class="text-gray-900 dark:text-gray-100 break-all" safe>{value}</p>
    </div>
  );
}
