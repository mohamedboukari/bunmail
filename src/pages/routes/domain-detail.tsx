import { BaseLayout } from "../layouts/base.tsx";
import { VerificationBadge } from "../components/status-badge.tsx";
import { FlashMessage } from "../components/flash-message.tsx";
import { BackArrowIcon } from "../assets/icons.tsx";
import { getDkimDnsRecord } from "../../modules/domains/services/domain.service.ts";
import type { Domain } from "../../modules/domains/types/domain.types.ts";

interface DomainDetailPageProps {
  domain: Domain;
  flash?: { message: string; type: "success" | "error" };
}

/**
 * Domain detail page — shows DNS verification status, required DNS records,
 * and a verify button for a single domain.
 */
export function DomainDetailPage({ domain, flash }: DomainDetailPageProps) {
  const dkimRecord = getDkimDnsRecord(domain);

  return (
    <BaseLayout title={domain.name} activeNav="domains">
      <a
        href="/dashboard/domains"
        class="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 inline-flex items-center gap-1 mb-4"
      >
        <BackArrowIcon />
        Back to domains
      </a>

      <div class="flex items-center justify-between mb-6">
        <h1 class="text-xl font-semibold" safe>
          {domain.name}
        </h1>
        <form method="POST" action={`/dashboard/domains/${domain.id}/verify`}>
          <button
            type="submit"
            class="px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium rounded-lg hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors"
          >
            Verify DNS Records
          </button>
        </form>
      </div>

      {flash && <FlashMessage message={flash.message} type={flash.type} />}

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

      {/* DNS Records to add */}
      <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-5 mb-6">
        <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-4">
          Required DNS Records
        </h2>
        <div class="space-y-4">
          <DnsRecordEntry
            type="TXT"
            host={domain.name}
            value={`v=spf1 a mx ip4:<YOUR_SERVER_IP> ~all`}
            label="SPF Record"
          />
          {dkimRecord && (
            <DnsRecordEntry
              type="TXT"
              host={`${domain.dkimSelector}._domainkey.${domain.name}`}
              value={dkimRecord}
              label="DKIM Record"
            />
          )}
          <DnsRecordEntry
            type="TXT"
            host={`_dmarc.${domain.name}`}
            value={`v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain.name}`}
            label="DMARC Record"
          />
        </div>
      </div>

      {/* Domain details */}
      <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-5">
        <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-4">
          Details
        </h2>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
          <DetailField label="ID" value={domain.id} />
          <DetailField label="DKIM Selector" value={domain.dkimSelector} />
          <DetailField label="Created" value={domain.createdAt.toISOString()} />
          {domain.verifiedAt && (
            <DetailField
              label="Last Verified"
              value={domain.verifiedAt.toISOString()}
            />
          )}
        </div>
      </div>
    </BaseLayout>
  );
}

/**
 * Verification card — shows a single DNS record's verification status.
 * Displayed in a 3-column grid on the domain detail page.
 */
function VerificationCard({
  label,
  verified,
}: {
  label: string;
  verified: boolean;
}) {
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
 * DNS record entry — shows host, type, and value for a DNS record the user must add.
 */
function DnsRecordEntry({ type, host, value, label }: { type: string; host: string; value: string; label: string }) {
  return (
    <div class="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
      <p class="text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">{label}</p>
      <div class="space-y-1 text-xs">
        <div class="flex gap-2">
          <span class="text-gray-500 dark:text-gray-400 w-12 shrink-0">Type:</span>
          <span class="font-mono text-gray-900 dark:text-gray-100">{type}</span>
        </div>
        <div class="flex gap-2">
          <span class="text-gray-500 dark:text-gray-400 w-12 shrink-0">Host:</span>
          <span class="font-mono text-gray-900 dark:text-gray-100 break-all" safe>{host}</span>
        </div>
        <div class="flex gap-2">
          <span class="text-gray-500 dark:text-gray-400 w-12 shrink-0">Value:</span>
          <span class="font-mono text-gray-900 dark:text-gray-100 break-all" safe>{value}</span>
        </div>
      </div>
    </div>
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
