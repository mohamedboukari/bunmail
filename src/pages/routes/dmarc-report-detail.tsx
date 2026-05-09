import { BaseLayout } from "../layouts/base.tsx";
import type {
  DmarcReport,
  DmarcRecord,
} from "../../modules/dmarc-reports/types/dmarc-report.types.ts";

interface DmarcReportDetailPageProps {
  report: DmarcReport;
  records: DmarcRecord[];
}

/**
 * DMARC report detail — summary header + per-source-IP records table +
 * computed alignment totals. The table is the most useful artefact here:
 * misaligned source IPs are how operators discover spoofing attempts or
 * unauthorised third-party senders claiming to be their domain.
 */
export function DmarcReportDetailPage({ report, records }: DmarcReportDetailPageProps) {
  /** Pre-compute totals — same shape the API serializer emits. */
  const totals = records.reduce(
    (acc, r) => {
      acc.messages += r.count;
      if (r.dkimAligned) acc.dkimAligned += r.count;
      if (r.spfAligned) acc.spfAligned += r.count;
      if (r.dkimAligned && r.spfAligned) acc.bothAligned += r.count;
      return acc;
    },
    { messages: 0, dkimAligned: 0, spfAligned: 0, bothAligned: 0 },
  );

  const pct = (n: number, d: number) => (d === 0 ? "—" : `${Math.round((n / d) * 100)}%`);

  return (
    <BaseLayout title={`DMARC: ${report.domain}`} activeNav="dmarc-reports">
      <div class="mb-4">
        <a
          href="/dashboard/dmarc-reports"
          class="text-sm text-gray-600 dark:text-gray-400 hover:underline"
        >
          ← All reports
        </a>
      </div>

      <h1 class="text-xl font-semibold mb-1">{report.orgName}</h1>
      <p class="text-sm text-gray-600 dark:text-gray-400 mb-6">
        Report for <span class="font-mono">{report.domain}</span> ·{" "}
        {report.dateBegin.toISOString().slice(0, 10)} →{" "}
        {report.dateEnd.toISOString().slice(0, 10)} · policy{" "}
        <span class="font-mono">p={report.policyP}</span> (pct={report.policyPct})
      </p>

      {/* Summary cards */}
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <div class="border border-gray-200 dark:border-gray-800 rounded-lg p-4">
          <div class="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            Messages
          </div>
          <div class="text-2xl font-semibold mt-1">{totals.messages}</div>
        </div>
        <div class="border border-gray-200 dark:border-gray-800 rounded-lg p-4">
          <div class="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            DKIM aligned
          </div>
          <div class="text-2xl font-semibold mt-1">
            {pct(totals.dkimAligned, totals.messages)}
          </div>
          <div class="text-xs text-gray-500 mt-1">
            {totals.dkimAligned} / {totals.messages}
          </div>
        </div>
        <div class="border border-gray-200 dark:border-gray-800 rounded-lg p-4">
          <div class="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            SPF aligned
          </div>
          <div class="text-2xl font-semibold mt-1">
            {pct(totals.spfAligned, totals.messages)}
          </div>
          <div class="text-xs text-gray-500 mt-1">
            {totals.spfAligned} / {totals.messages}
          </div>
        </div>
        <div class="border border-gray-200 dark:border-gray-800 rounded-lg p-4">
          <div class="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            Both aligned
          </div>
          <div class="text-2xl font-semibold mt-1">
            {pct(totals.bothAligned, totals.messages)}
          </div>
          <div class="text-xs text-gray-500 mt-1">
            {totals.bothAligned} / {totals.messages}
          </div>
        </div>
      </div>

      {/* Per-source-IP records */}
      <h2 class="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-3">
        Source IPs
      </h2>
      <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 dark:bg-gray-800/50 text-left">
            <tr>
              <th class="px-4 py-3 font-medium text-gray-700 dark:text-gray-300">
                Source IP
              </th>
              <th class="px-4 py-3 font-medium text-gray-700 dark:text-gray-300">
                Count
              </th>
              <th class="px-4 py-3 font-medium text-gray-700 dark:text-gray-300">
                Disposition
              </th>
              <th class="px-4 py-3 font-medium text-gray-700 dark:text-gray-300">DKIM</th>
              <th class="px-4 py-3 font-medium text-gray-700 dark:text-gray-300">SPF</th>
              <th class="px-4 py-3 font-medium text-gray-700 dark:text-gray-300">
                DKIM auth
              </th>
              <th class="px-4 py-3 font-medium text-gray-700 dark:text-gray-300">
                SPF auth
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-200 dark:divide-gray-800">
            {records.map((r) => {
              const aligned = r.dkimAligned && r.spfAligned;
              return (
                <tr class={!aligned ? "bg-amber-50 dark:bg-amber-950/20" : ""}>
                  <td class="px-4 py-3 font-mono text-xs">{r.sourceIp}</td>
                  <td class="px-4 py-3">{r.count}</td>
                  <td class="px-4 py-3">
                    <span class="px-2 py-0.5 text-xs rounded bg-gray-100 dark:bg-gray-800">
                      {r.disposition}
                    </span>
                  </td>
                  <td class="px-4 py-3">
                    <AlignmentBadge ok={r.dkimAligned} />
                  </td>
                  <td class="px-4 py-3">
                    <AlignmentBadge ok={r.spfAligned} />
                  </td>
                  <td class="px-4 py-3 text-xs text-gray-600 dark:text-gray-400">
                    {r.dkimAuthDomain ? (
                      <>
                        <span class="font-mono">{r.dkimAuthDomain}</span>
                        {r.dkimSelector ? <> · {r.dkimSelector}</> : null}{" "}
                        <span class="text-gray-400">{r.dkimResult}</span>
                      </>
                    ) : (
                      <span class="text-gray-400">—</span>
                    )}
                  </td>
                  <td class="px-4 py-3 text-xs text-gray-600 dark:text-gray-400">
                    {r.spfAuthDomain ? (
                      <>
                        <span class="font-mono">{r.spfAuthDomain}</span>{" "}
                        <span class="text-gray-400">{r.spfResult}</span>
                      </>
                    ) : (
                      <span class="text-gray-400">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Raw XML */}
      <details class="mt-6">
        <summary class="cursor-pointer text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100">
          Raw XML
        </summary>
        <pre class="mt-2 p-4 text-xs bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded overflow-x-auto">
          {report.rawXml}
        </pre>
      </details>
    </BaseLayout>
  );
}

function AlignmentBadge({ ok }: { ok: boolean }) {
  return ok ? (
    <span class="px-2 py-0.5 text-xs rounded bg-green-100 dark:bg-green-950 text-green-800 dark:text-green-300">
      pass
    </span>
  ) : (
    <span class="px-2 py-0.5 text-xs rounded bg-red-100 dark:bg-red-950 text-red-800 dark:text-red-300">
      fail
    </span>
  );
}
