import { BaseLayout } from "../layouts/base.tsx";
import { HtmlPreview, HtmlPreviewScript } from "../components/html-preview.tsx";
import { BackArrowIcon } from "../assets/icons.tsx";
import type { InboundEmail } from "../../modules/inbound/types/inbound.types.ts";

/**
 * Props for the inbound email detail page.
 */
interface InboundDetailPageProps {
  email: InboundEmail;
}

/**
 * Inbound email detail page — shows full metadata, HTML preview, and text content.
 */
export function InboundDetailPage({ email }: InboundDetailPageProps) {
  return (
    <BaseLayout title="Inbound Email" activeNav="inbound">
      {/* Back link */}
      <a
        href="/dashboard/inbound"
        class="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 inline-flex items-center gap-1 mb-4"
      >
        <BackArrowIcon />
        Back to inbound
      </a>

      <h1 class="text-xl font-semibold mb-6" safe>
        {email.subject ?? "(No subject)"}
      </h1>

      {/* Details card */}
      <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-5 mb-6">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
          <DetailField label="From" value={email.fromAddress} />
          <DetailField label="To" value={email.toAddress} />
          <DetailField label="Subject" value={email.subject ?? "(No subject)"} />
          <DetailField label="Received At" value={email.receivedAt.toISOString()} />
        </div>
      </div>

      {/* HTML content */}
      {email.html && (
        <div class="mb-6">
          <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">
            HTML Content
          </h2>
          <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4 overflow-auto">
            <HtmlPreview html={email.html} title="Inbound email HTML preview" />
          </div>
          <HtmlPreviewScript />
        </div>
      )}

      {/* Text content */}
      {email.textContent && (
        <div>
          <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">
            Text Content
          </h2>
          <pre
            class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4 text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap"
            safe
          >
            {email.textContent}
          </pre>
        </div>
      )}

      {!email.html && !email.textContent && (
        <p class="text-sm text-gray-500 dark:text-gray-400">No body content.</p>
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
      <p class="text-gray-500 dark:text-gray-400 text-xs uppercase tracking-wide mb-0.5">
        {label}
      </p>
      <p class="text-gray-900 dark:text-gray-100 break-all" safe>
        {value}
      </p>
    </div>
  );
}
