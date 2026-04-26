import { BaseLayout } from "../layouts/base.tsx";
import { StatsCard } from "../components/stats-card.tsx";
import type { DashboardStats } from "../../modules/emails/services/stats.service.ts";

/**
 * Dashboard home page — shows an overview grid of stat cards.
 *
 * Stats are grouped into three sections:
 *   1. Outbound — totals + per-status, last-24h activity, success rate.
 *   2. Inbound — total received, last 24h, trash counts.
 *   3. Configuration — API keys, domains, templates, webhooks.
 */
export function HomePage({ stats }: { stats: DashboardStats }) {
  /** Format the success rate as a percentage with one decimal — null = no data yet */
  const successRateDisplay =
    stats.successRate === null ? "—" : `${(stats.successRate * 100).toFixed(1)}%`;

  return (
    <BaseLayout title="Dashboard" activeNav="home">
      <h1 class="text-xl font-semibold mb-6">Dashboard</h1>

      {/* ── Outbound emails ── */}
      <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
        Outbound
      </h2>
      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 mb-8">
        <StatsCard
          label="Total Emails"
          value={stats.totalEmails}
          accent="border-gray-400 dark:border-gray-500"
        />
        <StatsCard label="Sent" value={stats.sentCount} accent="border-emerald-500" />
        <StatsCard label="Failed" value={stats.failedCount} accent="border-red-500" />
        <StatsCard label="Queued" value={stats.queuedCount} accent="border-amber-500" />
        <StatsCard
          label="Sent (last 24h)"
          value={stats.sentLast24h}
          accent="border-emerald-400"
          hint="rolling 24-hour window"
        />
        <StatsCard
          label="Failed (last 24h)"
          value={stats.failedLast24h}
          accent="border-red-400"
          hint="rolling 24-hour window"
        />
        <StatsCard
          label="Success Rate"
          value={0}
          displayValue={successRateDisplay}
          accent="border-emerald-600"
          hint="sent ÷ (sent + failed)"
        />
        <StatsCard
          label="Trashed Emails"
          value={stats.emailsInTrash}
          accent="border-gray-400"
          hint="auto-purged after retention"
        />
      </div>

      {/* ── Inbound emails ── */}
      <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
        Inbound
      </h2>
      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 mb-8">
        <StatsCard
          label="Inbound Total"
          value={stats.inboundTotal}
          accent="border-sky-500"
        />
        <StatsCard
          label="Inbound (last 24h)"
          value={stats.inboundLast24h}
          accent="border-sky-400"
          hint="rolling 24-hour window"
        />
        <StatsCard
          label="Trashed Inbound"
          value={stats.inboundInTrash}
          accent="border-gray-400"
          hint="auto-purged after retention"
        />
      </div>

      {/* ── Configuration ── */}
      <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
        Configuration
      </h2>
      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        <StatsCard
          label="Active API Keys"
          value={stats.activeApiKeys}
          accent="border-blue-500"
          hint={`${stats.totalApiKeys} total`}
        />
        <StatsCard
          label="Domains"
          value={stats.totalDomains}
          accent="border-purple-500"
        />
        <StatsCard
          label="Templates"
          value={stats.totalTemplates}
          accent="border-indigo-500"
        />
        <StatsCard
          label="Webhooks"
          value={stats.totalWebhooks}
          accent="border-pink-500"
        />
      </div>
    </BaseLayout>
  );
}
