import { BaseLayout } from "../layouts/base.tsx";
import { VerificationBadge } from "../components/status-badge.tsx";
import type { Domain } from "../../modules/domains/types/domain.types.ts";

/**
 * Domain detail page — shows DNS verification status for a single domain.
 * Displays SPF, DKIM, DMARC verification status and timestamps.
 */
export function DomainDetailPage({ domain }: { domain: Domain }) {
  return (
    <BaseLayout title={domain.name} activeNav="domains">
      {/* Back link */}
      <a
        href="/dashboard/domains"
        class="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 inline-flex items-center gap-1 mb-4"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
        </svg>
        Back to domains
      </a>

      {/* Domain name heading */}
      <h1 class="text-xl font-semibold mb-6" safe>{domain.name}</h1>

      {/* Verification status grid */}
      <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-5 mb-6">
        <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-4">
          DNS Verification
        </h2>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-6">
          <VerificationCard label="SPF" verified={domain.spfVerified} />
          <VerificationCard label="DKIM" verified={domain.dkimVerified} />
          <VerificationCard label="DMARC" verified={domain.dmarcVerified} />
        </div>
      </div>

      {/* Domain details */}
      <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-5 mb-6">
        <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-4">
          Details
        </h2>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
          <DetailField label="ID" value={domain.id} />
          <DetailField label="DKIM Selector" value={domain.dkimSelector} />
          <DetailField label="Created" value={domain.createdAt.toISOString()} />
          {domain.verifiedAt && (
            <DetailField label="Last Verified" value={domain.verifiedAt.toISOString()} />
          )}
        </div>
      </div>

      {/* Info note about future DNS verification */}
      <div class="bg-blue-50 text-blue-800 border border-blue-200 dark:bg-blue-950 dark:text-blue-200 dark:border-blue-800 rounded-lg px-4 py-3 text-sm">
        DNS verification coming in a future update. Once available, you'll be able to verify SPF, DKIM, and DMARC records for this domain.
      </div>
    </BaseLayout>
  );
}

/**
 * Verification card — shows a single DNS record's verification status.
 * Displayed in a 3-column grid on the domain detail page.
 */
function VerificationCard({ label, verified }: { label: string; verified: boolean }) {
  return (
    <div class="text-center">
      <div class="mb-2">
        <VerificationBadge verified={verified} label={label} />
      </div>
      <p class="text-xs text-gray-500 dark:text-gray-400">
        {verified ? "Verified" : "Not verified"}
      </p>
    </div>
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
