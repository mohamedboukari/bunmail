import { BaseLayout } from "../layouts/base.tsx";
import { StatsCard } from "../components/stats-card.tsx";
import type { DashboardStats } from "../../modules/emails/services/stats.service.ts";

/**
 * Dashboard home page — shows an overview grid of stat cards.
 * Displays counts for emails (total, sent, failed, queued), API keys, and domains.
 */
export function HomePage({ stats }: { stats: DashboardStats }) {
  return (
    <BaseLayout title="Dashboard" activeNav="home">
      <h1 class="text-xl font-semibold mb-6">Dashboard</h1>

      {/* 2x3 grid of stat cards */}
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <StatsCard
          label="Total Emails"
          value={stats.totalEmails}
          accent="border-gray-400 dark:border-gray-500"
        />
        <StatsCard label="Sent" value={stats.sentCount} accent="border-emerald-500" />
        <StatsCard label="Failed" value={stats.failedCount} accent="border-red-500" />
        <StatsCard label="Queued" value={stats.queuedCount} accent="border-amber-500" />
        <StatsCard
          label="API Keys"
          value={stats.activeApiKeys}
          accent="border-blue-500"
        />
        <StatsCard
          label="Domains"
          value={stats.totalDomains}
          accent="border-purple-500"
        />
      </div>
    </BaseLayout>
  );
}
