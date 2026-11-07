import { VerificationBadge } from "../components/status-badge.tsx";
import type {
  DmarcCheck,
  Domain,
  RequiredDnsRecord,
} from "../../modules/domains/types/domain.types.ts";
import type {
  DnsCheckOutcome,
  DnsCheckStatus,
} from "../../modules/domains/types/domain-check.types.ts";
import { FLIP_AFTER_FAILURES } from "../../modules/domains/services/domain-check-state.ts";

/**
 * The DNS parts of the domain detail page (`domain-detail.tsx`, #387):
 * the failing banner, the verification cards, the DMARC panel, the
 * records to publish, and the label and value field they share.
 */

/**
 * Whether a domain's checks keep failing (#250): after `FLIP_AFTER_FAILURES`
 * definitive failures in a row it is not verified, and a send can be refused.
 */
export function isFailing(domain: Domain): boolean {
  return domain.verifiedAt == null && domain.consecutiveFailures >= FLIP_AFTER_FAILURES;
}

/** The banner of a domain whose checks keep failing (#250). */
export function FailingBanner({ consecutiveFailures }: { consecutiveFailures: number }) {
  return (
    <div
      class="rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950 p-4 mb-6 text-sm text-red-800 dark:text-red-200"
      role="alert"
    >
      <p class="font-medium mb-1">DNS verification is failing</p>
      <p>
        The last {consecutiveFailures} checks found a record missing or wrong (see below),
        so this domain is not verified. While its DKIM record fails and
        REQUIRE_VERIFIED_DOMAIN is on, sends from this domain are refused. Fix the
        records, then click Verify DNS Records.
      </p>
    </div>
  );
}

/** What the last check of one record found, in a few words. */
function checkStatusText(status: DnsCheckStatus): string {
  switch (status) {
    case "pass":
      return "Last check: passed";
    case "fail":
      return "Last check: failed";
    case "unknown":
      return "Last check: DNS lookup failed (nothing changed)";
  }
}

/**
 * Verification card: shows a single DNS record's verification status and
 * what its last check found (#250). Displayed in a 3-column grid on the
 * domain detail page. The reason may quote DNS names: escaped.
 */
export function VerificationCard({
  label,
  verified,
  check,
}: {
  label: string;
  verified: boolean;
  check: DnsCheckOutcome | null;
}) {
  return (
    <div class="text-center">
      <div class="mb-2">
        <VerificationBadge verified={verified} label={label} />
      </div>
      <p class="text-xs text-gray-500 dark:text-gray-400">
        {verified ? "Verified" : "Not verified"}
      </p>
      {check != null && (
        <p
          class={`text-xs mt-1 ${check.status === "fail" ? "text-red-600 dark:text-red-400" : "text-gray-500 dark:text-gray-400"}`}
          safe
        >
          {`${checkStatusText(check.status)}: ${check.reason}`}
        </p>
      )}
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
export function DmarcPanel({ dmarc }: { dmarc: DmarcCheck }) {
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
export function DnsRecordRow({ record }: { record: RequiredDnsRecord }) {
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

/**
 * Detail field: label + value pair used in the details grid.
 */
export function DetailField({ label, value }: { label: string; value: string }) {
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
