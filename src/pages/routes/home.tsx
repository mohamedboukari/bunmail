import { BaseLayout } from "../layouts/base.tsx";
import { StatsCard } from "../components/stats-card.tsx";
import type { DashboardStats } from "../../modules/emails/services/stats.service.ts";
import type { ReverseDnsStatus } from "../../modules/domains/services/sending-ips.service.ts";
import { TimeDisplay } from "../components/time-display.tsx";

/**
 * Bounce rate above which the home page warns (#250): 2%, a common ceiling
 * before mailbox providers start filtering a sender's mail.
 */
export const BOUNCE_RATE_WARNING_THRESHOLD = 0.02;

/**
 * Dashboard home page: shows an overview grid of stat cards.
 *
 * Stats are grouped into three sections:
 *   1. Outbound: totals + per-status, last-24h activity, success rate.
 *   2. Inbound: total received, last 24h, trash counts.
 *   3. Configuration: API keys, domains, templates, webhooks.
 *
 * Admins and the owner also get a link to the Invitations page (#217):
 * the sidebar is shared by every role and does not know the viewer's.
 *
 * Admins and the owner also see the Server identity card (#248): the
 * sending IPs and whether their reverse DNS names `MAIL_HOSTNAME`.
 *
 * @param canInvite True when the viewer may open the Invitations page.
 * @param serverIdentity The cached reverse DNS result, for admins only.
 */
export function HomePage({
  stats,
  canInvite = false,
  serverIdentity,
}: {
  stats: DashboardStats;
  canInvite?: boolean;
  serverIdentity?: { status: ReverseDnsStatus | null };
}) {
  /** Format the success rate as a percentage with one decimal: null = no data yet */
  const successRateDisplay =
    stats.successRate === null ? "n/a" : `${(stats.successRate * 100).toFixed(1)}%`;
  /** Bounce rate (#250): 0 when nothing was sent or bounced yet. */
  const bounceRateDisplay = `${(stats.bounceRate * 100).toFixed(1)}%`;
  const bounceRateHigh = stats.bounceRate > BOUNCE_RATE_WARNING_THRESHOLD;

  return (
    <BaseLayout title="Dashboard" activeNav="home">
      <div class="flex items-center justify-between mb-6">
        <h1 class="text-xl font-semibold">Dashboard</h1>
        {canInvite && (
          <a
            href="/dashboard/invitations"
            class="text-sm font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 underline"
          >
            Invite teammates
          </a>
        )}
      </div>

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
          label="Bounced"
          value={stats.bouncedCount}
          accent="border-orange-500"
        />
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
          hint="sent ÷ (sent + failed + bounced)"
        />
        <StatsCard
          label="Bounce Rate"
          value={0}
          displayValue={bounceRateDisplay}
          accent={bounceRateHigh ? "border-red-600" : "border-orange-400"}
          hint="bounced ÷ (sent + bounced)"
          warning={
            bounceRateHigh
              ? `Above ${BOUNCE_RATE_WARNING_THRESHOLD * 100}%: remove bounced and stale addresses from your lists.`
              : undefined
          }
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

      {serverIdentity !== undefined && (
        <ServerIdentityCard status={serverIdentity.status} />
      )}
    </BaseLayout>
  );
}

/**
 * Server identity (#248): forward-confirmed reverse DNS of each sending IP.
 * Gmail rejects mail from an IP whose PTR does not name the sending host
 * and resolve back to it; the PTR is set at the hosting provider.
 */
function ServerIdentityCard({ status }: { status: ReverseDnsStatus | null }) {
  return (
    <>
      <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3 mt-8">
        Server identity
      </h2>
      <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-5">
        {status === null ? (
          <p class="text-sm text-gray-500 dark:text-gray-400">
            Checking reverse DNS... reload in a moment.
          </p>
        ) : (
          <>
            <p class="text-sm mb-3">
              Sending as <code safe>{status.hostname}</code> from{" "}
              {status.source === "MAIL_PUBLIC_IP"
                ? "MAIL_PUBLIC_IP"
                : "the A/AAAA records of MAIL_HOSTNAME"}
              , checked <TimeDisplay value={status.checkedAt} />.
            </p>
            {status.checks.length === 0 ? (
              <p class="text-sm text-red-600 dark:text-red-400">
                No sending IP found: set MAIL_PUBLIC_IP or give MAIL_HOSTNAME an A or AAAA
                record.
              </p>
            ) : (
              <ul class="space-y-2">
                {status.checks.map((check) => (
                  <li class="text-sm flex flex-wrap items-baseline gap-2">
                    <span
                      class={
                        check.ok
                          ? "text-xs font-medium px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
                          : "text-xs font-medium px-2 py-0.5 rounded bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300"
                      }
                    >
                      {check.ok ? "PTR ok" : "PTR problem"}
                    </span>
                    <code safe>{check.ip}</code>
                    <span class="text-gray-600 dark:text-gray-400" safe>
                      {check.reason}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-3">
              Behind NAT the server cannot see its real egress address: set MAIL_PUBLIC_IP
              to it.
            </p>
          </>
        )}
      </div>
    </>
  );
}
