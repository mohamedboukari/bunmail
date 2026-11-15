import { TimeDisplay } from "../components/time-display.tsx";
import type {
  BimiArea,
  BimiCheck,
  BimiFinding,
  BimiSeverity,
  BimiStatus,
} from "../../modules/domains/types/bimi.types.ts";
import { bimiRecordHost } from "../../modules/domains/services/bimi-record.ts";
import type { Domain } from "../../modules/domains/types/domain.types.ts";

/**
 * The domain page's BIMI section (#415): what BIMI needs, the record to
 * publish, the Check BIMI button (admins only) and the last check's
 * findings. Everything in a finding can come from the domain's DNS or its
 * logo, so it is escaped; the logo itself is never rendered.
 */

/** Area headings, in display order. */
const AREAS: ReadonlyArray<{ area: BimiArea; label: string }> = [
  { area: "record", label: "Record" },
  { area: "dmarc", label: "DMARC" },
  { area: "logo", label: "Logo" },
  { area: "certificate", label: "Certificate" },
];

/** The verdict in a few words, with its colour. */
function statusLabel(status: BimiStatus): { text: string; tone: string } {
  switch (status) {
    case "ready":
      return {
        text: "Ready",
        tone: "bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200",
      };
    case "not-ready":
      return {
        text: "Not ready",
        tone: "bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-200",
      };
    case "declined":
      return {
        text: "Declined",
        tone: "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300",
      };
    case "missing":
      return {
        text: "No record",
        tone: "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300",
      };
    case "error":
      return {
        text: "Check failed",
        tone: "bg-amber-100 dark:bg-amber-900 text-amber-800 dark:text-amber-200",
      };
  }
}

/** A finding's marker and colour. */
function severityLabel(severity: BimiSeverity): { text: string; tone: string } {
  switch (severity) {
    case "pass":
      return { text: "Pass", tone: "text-green-700 dark:text-green-400" };
    case "fail":
      return { text: "Fail", tone: "text-red-600 dark:text-red-400" };
    case "warn":
      return { text: "Warning", tone: "text-amber-700 dark:text-amber-400" };
    case "info":
      return { text: "Note", tone: "text-gray-500 dark:text-gray-400" };
  }
}

/** One finding: its marker, then its text. */
function FindingRow({ finding }: { finding: BimiFinding }) {
  const label = severityLabel(finding.severity);
  return (
    <li class="flex gap-2">
      <span class={`shrink-0 w-16 font-medium ${label.tone}`} safe>
        {label.text}
      </span>
      <span class="text-gray-700 dark:text-gray-300 break-words" safe>
        {finding.text}
      </span>
    </li>
  );
}

/** The last check: verdict, summary, time, then the findings by area. */
function BimiResult({ check }: { check: BimiCheck }) {
  const status = statusLabel(check.status);
  return (
    <div class="mt-4">
      <div class="flex flex-wrap items-center gap-2 mb-2">
        <span
          class={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${status.tone}`}
          safe
        >
          {status.text}
        </span>
        <span class="text-sm text-gray-700 dark:text-gray-300" safe>
          {check.summary}
        </span>
      </div>
      <p class="text-xs text-gray-500 dark:text-gray-400 mb-4">
        Checked <TimeDisplay value={new Date(check.checkedAt)} />. Kept for 30 minutes on
        this server.
      </p>
      {AREAS.map(({ area, label }) => {
        const findings = check.findings.filter((finding) => finding.area === area);
        if (findings.length === 0) return "";
        return (
          <div class="mb-3">
            <h3
              class="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1"
              safe
            >
              {label}
            </h3>
            <ul class="text-sm space-y-1">
              {findings.map((finding) => (
                <FindingRow finding={finding} />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The BIMI section: the explanation, the record to publish, the Check
 * BIMI button, and the last check of this domain when one is still kept.
 */
export function BimiPanel({
  domain,
  check,
}: {
  domain: Pick<Domain, "id" | "name">;
  /** The last check (`lastBimiCheck`), or null when none is kept. */
  check: BimiCheck | null;
}) {
  const host = bimiRecordHost(domain.name);
  const example = `v=BIMI1; l=https://${domain.name}/bimi/logo.svg; a=https://${domain.name}/bimi/vmc.pem`;
  return (
    <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-5 mb-6">
      <div class="flex items-center justify-between gap-4 mb-1">
        <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
          BIMI
        </h2>
        <form method="POST" action={`/dashboard/domains/${domain.id}/bimi`}>
          <button
            type="submit"
            class="px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-700 text-gray-900 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors whitespace-nowrap"
          >
            Check BIMI
          </button>
        </form>
      </div>
      <p class="text-sm text-gray-500 dark:text-gray-400 mb-2">
        BIMI lets mailbox providers show your logo next to your mail. It needs a TXT
        record, a DMARC policy that enforces (p=quarantine or p=reject, pct=100), and an
        SVG Tiny PS logo served over https. Gmail and Apple Mail also need a Verified Mark
        Certificate (VMC) or Common Mark Certificate (CMC) at a=. BunMail sends nothing
        differently: Check BIMI looks up the record and DMARC and fetches the logo to
        check it. It does not validate the certificate.
      </p>
      <p class="text-sm text-gray-500 dark:text-gray-400 mb-2">
        Record to publish (replace the URLs with where you host the logo and the
        certificate; leave a= empty without a certificate):
      </p>
      <div class="grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs mb-2">
        <span class="text-gray-500 dark:text-gray-400">TXT</span>
        <code class="font-mono text-gray-900 dark:text-gray-100 break-all" safe>
          {host}
        </code>
        <span class="text-gray-500 dark:text-gray-400">Value</span>
        <code
          class="font-mono text-gray-900 dark:text-gray-100 break-all select-all bg-gray-50 dark:bg-gray-950 rounded px-2 py-1"
          safe
        >
          {example}
        </code>
      </div>
      {check === null ? (
        <p class="text-sm text-gray-500 dark:text-gray-400 mt-4">
          Not checked in the last 30 minutes.
        </p>
      ) : (
        <BimiResult check={check} />
      )}
    </div>
  );
}
