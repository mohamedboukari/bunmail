import { BaseLayout } from "../layouts/base.tsx";
import { FlashMessage } from "../components/flash-message.tsx";
import { TimeDisplay } from "../components/time-display.tsx";
import { BackArrowIcon } from "../assets/icons.tsx";
import type { DomainDnsStatus } from "../../modules/domains/services/domain-dns-status.service.ts";
import type {
  Domain,
  RequiredDnsRecord,
} from "../../modules/domains/types/domain.types.ts";
import {
  DetailField,
  DmarcPanel,
  DnsRecordRow,
  FailingBanner,
  VerificationCard,
  isFailing,
} from "./domain-detail-dns.tsx";
import { DkimKeyPanel } from "./domain-detail-dkim.tsx";
import { MailFlowPanel } from "./domain-detail-mail-flow.tsx";
import { TrackingPanel } from "./domain-detail-tracking.tsx";

interface DomainDetailPageProps {
  domain: Domain;
  /** The records to publish (#250), from `getRequiredDnsRecords`. */
  dnsRecords: RequiredDnsRecord[];
  /** The live DMARC check and MX status (#250). */
  dns: DomainDnsStatus;
  /** `SMTP_ENABLED`: with the MX, decides which mail flows are active. */
  smtpEnabled: boolean;
  /** `TRACKING_ENABLED` (#187): the tracking panel says when it keeps everything off. */
  trackingEnabled: boolean;
  flash?: { message: string; type: "success" | "error" };
}

/**
 * Domain detail page: shows DNS verification status, the DMARC policy,
 * the DNS records to publish, where the MX points, and a verify button.
 */
export function DomainDetailPage({
  domain,
  dnsRecords,
  dns,
  smtpEnabled,
  trackingEnabled,
  flash,
}: DomainDetailPageProps) {
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

      {flash != null && <FlashMessage message={flash.message} type={flash.type} />}

      {isFailing(domain) && (
        <FailingBanner consecutiveFailures={domain.consecutiveFailures} />
      )}

      {/* Verification status grid */}
      <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-5 mb-6">
        <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
          DNS Verification
        </h2>
        <p class="text-sm text-gray-500 dark:text-gray-400 mb-4">
          {domain.lastCheckedAt == null ? (
            "Not checked yet."
          ) : (
            <span>
              Last checked <TimeDisplay value={domain.lastCheckedAt} />.
            </span>
          )}{" "}
          Checked again automatically about once a day, hourly while a check fails.
        </p>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-6">
          <VerificationCard
            label="SPF"
            verified={domain.spfVerified}
            check={domain.lastCheckResult?.spf ?? null}
          />
          <VerificationCard
            label="DKIM"
            verified={domain.dkimVerified}
            check={domain.lastCheckResult?.dkim ?? null}
          />
          <VerificationCard
            label="DMARC"
            verified={domain.dmarcVerified}
            check={domain.lastCheckResult?.dmarc ?? null}
          />
        </div>
      </div>

      <DmarcPanel dmarc={dns.dmarc} />

      {/* DNS records to publish (#250) */}
      <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-5 mb-6">
        <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
          Required DNS Records
        </h2>
        <p class="text-sm text-gray-500 dark:text-gray-400 mb-4">
          Publish these at your DNS provider. Click a value to select it for copying.
          Verify checks SPF, DKIM and DMARC; the server records are checked at boot.
        </p>
        <div class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead>
              <tr class="border-b border-gray-200 dark:border-gray-800 text-left text-gray-500 dark:text-gray-400">
                <th class="px-2 py-2 font-medium">Type</th>
                <th class="px-2 py-2 font-medium">Host</th>
                <th class="px-2 py-2 font-medium">Value</th>
                <th class="px-2 py-2 font-medium">Purpose</th>
              </tr>
            </thead>
            <tbody>
              {dnsRecords.map((record) => (
                <DnsRecordRow record={record} />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <DkimKeyPanel domain={domain} />

      <MailFlowPanel mx={dns.mx} smtpEnabled={smtpEnabled} />

      {/* Inbound notifications (#106) */}
      <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-5 mb-6">
        <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
          Inbound Notifications
        </h2>
        <p class="text-sm text-gray-500 dark:text-gray-400 mb-4">
          Get a summary email when mail is received for this domain. Leave empty to
          disable. Use an external mailbox (not an address on this domain).
        </p>
        <form
          method="POST"
          action={`/dashboard/domains/${domain.id}/notify-email`}
          class="flex flex-col sm:flex-row gap-3 sm:items-center"
        >
          <input
            type="email"
            name="notifyEmail"
            value={domain.notifyEmail ?? ""}
            placeholder="ops@yourcompany.com"
            class="flex-1 px-3 py-2 text-sm bg-white dark:bg-gray-950 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-gray-100 focus:outline-hidden focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-600"
          />
          <button
            type="submit"
            class="px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium rounded-lg hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors whitespace-nowrap"
          >
            Save
          </button>
        </form>
      </div>

      {/* List-Unsubscribe overrides (#243) */}
      <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-5 mb-6">
        <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
          Unsubscribe
        </h2>
        <p class="text-sm text-gray-500 dark:text-gray-400 mb-4">
          Every email carries a List-Unsubscribe header. Leave the mailbox empty to use
          unsubscribe@ this domain. Add an https URL to enable one-click unsubscribe (RFC
          8058), which Gmail and Yahoo expect from bulk senders.
        </p>
        <form
          method="POST"
          action={`/dashboard/domains/${domain.id}/unsubscribe`}
          class="flex flex-col gap-3"
        >
          <input
            type="email"
            name="unsubscribeEmail"
            value={domain.unsubscribeEmail ?? ""}
            placeholder="unsubscribe@yourcompany.com"
            class="px-3 py-2 text-sm bg-white dark:bg-gray-950 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-gray-100 focus:outline-hidden focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-600"
          />
          <input
            type="url"
            name="unsubscribeUrl"
            value={domain.unsubscribeUrl ?? ""}
            placeholder="https://yourcompany.com/unsubscribe"
            class="px-3 py-2 text-sm bg-white dark:bg-gray-950 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-gray-100 focus:outline-hidden focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-600"
          />
          <button
            type="submit"
            class="self-start px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium rounded-lg hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors whitespace-nowrap"
          >
            Save
          </button>
        </form>
      </div>

      {/* Open and click tracking opt-in (#187) */}
      <TrackingPanel domain={domain} trackingEnabled={trackingEnabled} />

      {/* Domain details */}
      <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-5">
        <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-4">
          Details
        </h2>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
          <DetailField label="ID" value={domain.id} />
          <DetailField label="DKIM Selector" value={domain.dkimSelector} />
          <div>
            <p class="text-gray-500 dark:text-gray-400 text-xs uppercase tracking-wide mb-0.5">
              Created
            </p>
            <p class="text-gray-900 dark:text-gray-100 break-all">
              <TimeDisplay value={domain.createdAt} />
            </p>
          </div>
          {domain.verifiedAt != null && (
            <div>
              <p class="text-gray-500 dark:text-gray-400 text-xs uppercase tracking-wide mb-0.5">
                Verified Since
              </p>
              <p class="text-gray-900 dark:text-gray-100 break-all">
                <TimeDisplay value={domain.verifiedAt} />
              </p>
            </div>
          )}
        </div>
      </div>
    </BaseLayout>
  );
}
