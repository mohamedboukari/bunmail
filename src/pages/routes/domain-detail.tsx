import { BaseLayout } from "../layouts/base.tsx";
import { VerificationBadge } from "../components/status-badge.tsx";
import { FlashMessage } from "../components/flash-message.tsx";
import { TimeDisplay } from "../components/time-display.tsx";
import { BackArrowIcon } from "../assets/icons.tsx";
import {
  PREVIOUS_DKIM_SELECTOR_ADVICE,
  dkimRecordHost,
} from "../../modules/domains/services/dkim-keys.ts";
import {
  mailFlowFeatures,
  type DomainDnsStatus,
} from "../../modules/domains/services/domain-dns-status.service.ts";
import type { MxStatus } from "../../modules/bounces/services/return-path-mx.ts";
import type {
  DmarcCheck,
  Domain,
  RequiredDnsRecord,
} from "../../modules/domains/types/domain.types.ts";

interface DomainDetailPageProps {
  domain: Domain;
  /** The records to publish (#250), from `getRequiredDnsRecords`. */
  dnsRecords: RequiredDnsRecord[];
  /** The live DMARC check and MX status (#250). */
  dns: DomainDnsStatus;
  /** `SMTP_ENABLED`: with the MX, decides which mail flows are active. */
  smtpEnabled: boolean;
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
                Last Verified
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

/**
 * Verification card: shows a single DNS record's verification status.
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

/** A DMARC policy value, or a dash. */
function policyText(value: string | null): string {
  return value ?? "-";
}

/**
 * The DMARC check (#250): status, where the record lives, the effective
 * policy and the parsed tags. Every value from DNS is escaped.
 */
function DmarcPanel({ dmarc }: { dmarc: DmarcCheck }) {
  return (
    <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-5 mb-6">
      <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
        DMARC Policy
      </h2>
      <p
        class={`text-sm mb-4 ${dmarc.ok ? "text-gray-700 dark:text-gray-300" : "text-red-600 dark:text-red-400"}`}
        safe
      >
        {dmarc.reason}
      </p>
      {dmarc.recordDomain != null && dmarc.status !== "multiple" && (
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm mb-4">
          <DetailField
            label="Record"
            value={`_dmarc.${dmarc.recordDomain}${dmarc.inherited ? " (inherited)" : ""}`}
          />
          <DetailField
            label="Effective policy"
            value={policyText(dmarc.effectivePolicy)}
          />
          <DetailField label="p" value={policyText(dmarc.policy)} />
          <DetailField label="sp" value={policyText(dmarc.subdomainPolicy)} />
          <DetailField label="pct" value={dmarc.pct === null ? "-" : String(dmarc.pct)} />
          <DetailField label="adkim" value={dmarc.adkim ?? "-"} />
          <DetailField label="aspf" value={dmarc.aspf ?? "-"} />
          <DetailField
            label="rua"
            value={dmarc.rua.length > 0 ? dmarc.rua.join(", ") : "-"}
          />
        </div>
      )}
      {dmarc.warnings.length > 0 && (
        <ul class="list-disc pl-5 text-sm text-amber-700 dark:text-amber-400 space-y-1 mb-2">
          {dmarc.warnings.map((warning) => (
            <li safe>{warning}</li>
          ))}
        </ul>
      )}
      {dmarc.problems.length > 0 && (
        <ul class="list-disc pl-5 text-sm text-red-600 dark:text-red-400 space-y-1">
          {dmarc.problems.map((problem) => (
            <li safe>{problem}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One record to publish: type, host, a selectable value, purpose and note. */
function DnsRecordRow({ record }: { record: RequiredDnsRecord }) {
  return (
    <tr class="border-b border-gray-100 dark:border-gray-800 align-top">
      <td class="px-2 py-3 font-mono text-gray-900 dark:text-gray-100">{record.type}</td>
      <td class="px-2 py-3 font-mono text-gray-900 dark:text-gray-100 break-all" safe>
        {record.host}
      </td>
      <td class="px-2 py-3 min-w-64">
        <code
          class="block font-mono text-gray-900 dark:text-gray-100 break-all select-all bg-gray-50 dark:bg-gray-950 rounded px-2 py-1"
          safe
        >
          {record.value}
        </code>
      </td>
      <td class="px-2 py-3 text-gray-600 dark:text-gray-400">
        <p>
          <span safe>{record.purpose}</span>
          {record.optional && (
            <span class="ml-1 inline-flex px-1.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400">
              optional
            </span>
          )}
          {record.pending === true && (
            <span class="ml-1 inline-flex px-1.5 rounded bg-amber-100 dark:bg-amber-900 text-amber-800 dark:text-amber-200">
              pending
            </span>
          )}
        </p>
        {record.note != null && (
          <p class="mt-1 text-gray-500 dark:text-gray-500" safe>
            {record.note}
          </p>
        )}
      </td>
    </tr>
  );
}

/** Classes of a small action button in the DKIM key panel. */
const PANEL_BUTTON =
  "px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-700 text-gray-900 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors whitespace-nowrap";

/**
 * The DKIM key and its rotation (#250): the active selector, a pending
 * rotation with Complete and Cancel, or a button to start one, and the
 * previous selector with what to do with its record. Each button asks
 * for confirmation; the routes are admin-only.
 */
function DkimKeyPanel({ domain }: { domain: Domain }) {
  const pending = domain.dkimPendingSelector;
  const previous = domain.dkimPreviousSelector;
  return (
    <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-5 mb-6">
      <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
        DKIM Key
      </h2>
      <p class="text-sm text-gray-700 dark:text-gray-300 mb-4">
        Mail is signed with selector{" "}
        <code class="font-mono" safe>
          {domain.dkimSelector}
        </code>
        {domain.dkimRotatedAt != null && (
          <span>
            {" "}
            since <TimeDisplay value={domain.dkimRotatedAt} />
          </span>
        )}
        .
      </p>

      {pending == null ? (
        <div class="flex flex-col sm:flex-row sm:items-center gap-3">
          <p class="text-sm text-gray-500 dark:text-gray-400 flex-1">
            Rotating creates a new key under a dated selector. Mail stays signed with the
            current key until you publish the new record and complete the rotation.
          </p>
          <form method="POST" action={`/dashboard/domains/${domain.id}/dkim/rotate`}>
            <button
              type="submit"
              class={PANEL_BUTTON}
              data-confirm="Start a DKIM key rotation? A new key is created; mail stays signed with the current key until you complete the rotation."
            >
              Rotate DKIM key
            </button>
          </form>
        </div>
      ) : (
        <div class="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950 p-4">
          <p class="text-sm text-amber-900 dark:text-amber-200 mb-1">
            Rotation pending: selector{" "}
            <code class="font-mono" safe>
              {pending}
            </code>
            {domain.dkimPendingCreatedAt != null && (
              <span>
                , started <TimeDisplay value={domain.dkimPendingCreatedAt} />
              </span>
            )}
            .
          </p>
          <p class="text-sm text-amber-900 dark:text-amber-200 mb-3">
            Publish the TXT record at{" "}
            <code class="font-mono break-all" safe>
              {dkimRecordHost(pending, domain.name)}
            </code>{" "}
            (listed under Required DNS Records as pending), wait for it to resolve, then
            complete the rotation. Completing checks the record first.
          </p>
          <div class="flex flex-wrap gap-3">
            <form
              method="POST"
              action={`/dashboard/domains/${domain.id}/dkim/rotate/complete`}
            >
              <button
                type="submit"
                class={PANEL_BUTTON}
                data-confirm="Switch to the new DKIM key? Mail is signed with it from now on."
              >
                Complete rotation
              </button>
            </form>
            <form
              method="POST"
              action={`/dashboard/domains/${domain.id}/dkim/rotate/cancel`}
            >
              <button
                type="submit"
                class={PANEL_BUTTON}
                data-confirm="Cancel the DKIM key rotation? The pending key is discarded."
              >
                Cancel rotation
              </button>
            </form>
          </div>
        </div>
      )}

      {previous != null && (
        <p class="text-sm text-gray-500 dark:text-gray-400 mt-4">
          Previous selector{" "}
          <code class="font-mono" safe>
            {previous}
          </code>{" "}
          (
          <code class="font-mono break-all" safe>
            {dkimRecordHost(previous, domain.name)}
          </code>
          ), no longer used to sign. <span>{PREVIOUS_DKIM_SELECTOR_ADVICE}</span>
        </p>
      )}
    </div>
  );
}

/** What the MX status means, in one line. */
function mxSummary(mx: MxStatus): string {
  switch (mx.status) {
    case "here":
      return "The MX points at this server.";
    case "elsewhere":
      return "The MX points at another mail host. That is fine for sending; it decides where replies and bounces go.";
    case "none":
      return "The domain has no MX record. Sending works without one.";
    case "error":
      return "The MX lookup failed. Sending is unaffected; reload in a few minutes.";
  }
}

/**
 * Where the domain's MX points and which mail flows BunMail handles for it
 * (#250). Informational: nothing here gates sending.
 */
function MailFlowPanel({ mx, smtpEnabled }: { mx: MxStatus; smtpEnabled: boolean }) {
  return (
    <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-5 mb-6">
      <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
        MX and Mail Flow
      </h2>
      <p class="text-sm text-gray-700 dark:text-gray-300 mb-1" safe>
        {mxSummary(mx)}
      </p>
      {mx.hosts.length > 0 && (
        <p class="text-xs font-mono text-gray-500 dark:text-gray-400 break-all mb-4" safe>
          {`MX: ${mx.hosts.join(", ")}`}
        </p>
      )}
      <ul class="space-y-2 text-sm mt-3">
        {mailFlowFeatures(mx, smtpEnabled).map((feature) => (
          <li class="flex gap-2">
            <span
              class={`shrink-0 w-14 text-xs font-medium ${feature.active ? "text-emerald-700 dark:text-emerald-400" : "text-gray-500 dark:text-gray-400"}`}
            >
              {feature.active ? "Active" : "Off"}
            </span>
            <span>
              <span class="font-medium text-gray-900 dark:text-gray-100" safe>
                {feature.name}
              </span>
              <span class="text-gray-600 dark:text-gray-400" safe>
                {`: ${feature.explanation}`}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Detail field: label + value pair used in the details grid.
 */
function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p
        class="text-gray-500 dark:text-gray-400 text-xs uppercase tracking-wide mb-0.5"
        safe
      >
        {label}
      </p>
      <p class="text-gray-900 dark:text-gray-100 break-all" safe>
        {value}
      </p>
    </div>
  );
}
