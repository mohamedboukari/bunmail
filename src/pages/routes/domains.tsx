import { BaseLayout } from "../layouts/base.tsx";
import { VerificationBadge } from "../components/status-badge.tsx";
import { FlashMessage } from "../components/flash-message.tsx";
import { EmptyState } from "../components/empty-state.tsx";
import type { Domain } from "../../modules/domains/types/domain.types.ts";

/**
 * Props for the domains list page.
 */
interface DomainsPageProps {
  /** All registered domains */
  domains: Domain[];
  /** Optional flash message (e.g. after adding or deleting a domain) */
  flash?: { message: string; type: "success" | "error" };
}

/**
 * Domains page — shows an add form and table of all registered sender domains.
 * Each domain shows SPF/DKIM/DMARC verification status.
 */
export function DomainsPage({ domains, flash }: DomainsPageProps) {
  return (
    <BaseLayout title="Domains" activeNav="domains">
      <h1 class="text-xl font-semibold mb-6">Domains</h1>

      {/* Flash message */}
      {flash && <FlashMessage message={flash.message} type={flash.type} />}

      {/* Add domain form */}
      <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4 mb-6">
        <form method="POST" action="/dashboard/domains" class="flex gap-3">
          <input
            type="text"
            name="name"
            required
            placeholder="Domain name (e.g. example.com)"
            class="flex-1 px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500 focus:border-transparent"
          />
          <button
            type="submit"
            class="px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium rounded-lg hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors whitespace-nowrap"
          >
            Add Domain
          </button>
        </form>
      </div>

      {domains.length === 0 ? (
        <EmptyState message="No domains registered. Add one above to start sending authenticated emails." />
      ) : (
        /* Domains table */
        <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-gray-200 dark:border-gray-800">
                <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  Domain
                </th>
                <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  SPF
                </th>
                <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  DKIM
                </th>
                <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  DMARC
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
              {domains.map((domain) => (
                <tr class="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                  <td class="px-4 py-3 font-medium text-gray-900 dark:text-gray-100">
                    <a
                      href={`/dashboard/domains/${domain.id}`}
                      class="hover:underline"
                      safe
                    >
                      {domain.name}
                    </a>
                  </td>
                  <td class="px-4 py-3">
                    <VerificationBadge verified={domain.spfVerified} label="SPF" />
                  </td>
                  <td class="px-4 py-3">
                    <VerificationBadge verified={domain.dkimVerified} label="DKIM" />
                  </td>
                  <td class="px-4 py-3">
                    <VerificationBadge verified={domain.dmarcVerified} label="DMARC" />
                  </td>
                  <td class="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {domain.createdAt.toLocaleDateString()}
                  </td>
                  <td class="px-4 py-3">
                    <form method="POST" action={`/dashboard/domains/${domain.id}/delete`}>
                      <button
                        type="submit"
                        class="text-xs text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 font-medium"
                        onclick="return confirm('Are you sure you want to delete this domain?')"
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
