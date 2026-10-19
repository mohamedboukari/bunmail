import { BaseLayout } from "../layouts/base.tsx";
import { StatsCard } from "../components/stats-card.tsx";
import type { DashboardStats } from "../../modules/emails/services/stats.service.ts";
import type { ReverseDnsStatus } from "../../modules/domains/services/sending-ips.service.ts";
import {
  DNSBL_ZONES,
  PUBLIC_RESOLVER_HINT,
  type AddressCheck,
  type DnsblStatus,
  type ZoneCheck,
} from "../../modules/domains/services/sending-ip-dnsbl.service.ts";
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
 * sending IPs and whether their reverse DNS names `MAIL_HOSTNAME`; and
 * next to it the Blocklists card (#250): the latest DNSBL self-check.
 *
 * @param canInvite True when the viewer may open the Invitations page.
 * @param serverIdentity The cached reverse DNS result, for admins only.
 * @param blocklists The latest DNSBL self-check, for admins only.
 */
export function HomePage({
  stats,
  canInvite = false,
  serverIdentity,
  blocklists,
}: {
  stats: DashboardStats;
  canInvite?: boolean;
  serverIdentity?: { status: ReverseDnsStatus | null };
  blocklists?: DnsblStatus;
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

      {(serverIdentity !== undefined || blocklists !== undefined) && (
        <div class="grid gap-x-4 lg:grid-cols-2">
          {serverIdentity !== undefined && (
            <ServerIdentityCard status={serverIdentity.status} />
          )}
          {blocklists !== undefined && <BlocklistsCard status={blocklists} />}
        </div>
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
    <section>
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
    </section>
  );
}

/** Badge classes per result. */
const BADGE = {
  red: "text-xs font-medium px-2 py-0.5 rounded bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  amber:
    "text-xs font-medium px-2 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  green:
    "text-xs font-medium px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  gray: "text-xs font-medium px-2 py-0.5 rounded bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
} as const;

/** One zone's result for one address. */
function ZoneRow({ check }: { check: ZoneCheck }) {
  const { result } = check;
  if (result.status === "listed") {
    const policyOnly = result.codes.every((code) => code.policy);
    return (
      <li class="text-sm">
        <div class="flex flex-wrap items-baseline gap-2">
          <span class={policyOnly ? BADGE.amber : BADGE.red}>
            {policyOnly ? "policy listing" : "listed"}
          </span>
          <span class="font-medium" safe>
            {check.name}
          </span>
          <a
            href={check.removalUrl}
            rel="noopener noreferrer"
            target="_blank"
            class="text-xs underline text-gray-600 dark:text-gray-400"
          >
            Look up and request removal
          </a>
        </div>
        <ul class="ml-4 mt-1 text-xs text-gray-600 dark:text-gray-400">
          {result.codes.map((code) => (
            <li>
              <code safe>{code.code}</code>: <span safe>{code.meaning}</span>
            </li>
          ))}
        </ul>
        {policyOnly && (
          <p class="ml-4 mt-1 text-xs text-gray-600 dark:text-gray-400">
            Not a sign of abuse, but some receivers refuse mail sent directly from such a
            range. If this server is meant to send mail, ask for the address to be removed
            from the PBL.
          </p>
        )}
      </li>
    );
  }
  return (
    <li class="text-sm flex flex-wrap items-baseline gap-2">
      {result.status === "not-listed" ? (
        <span class={BADGE.green}>not listed</span>
      ) : result.status === "unavailable" ? (
        <span class={BADGE.gray}>unavailable</span>
      ) : (
        <span class={BADGE.gray}>unknown</span>
      )}
      <span class="font-medium" safe>
        {check.name}
      </span>
      {result.status === "unavailable" && (
        <span class="text-xs text-gray-600 dark:text-gray-400">
          the zone refused the query (<code safe>{result.code}</code>)
        </span>
      )}
      {result.status === "unknown" && (
        <span class="text-xs text-gray-600 dark:text-gray-400" safe>
          {result.reason}
        </span>
      )}
    </li>
  );
}

/** One sending address and its results. */
function AddressRow({ address }: { address: AddressCheck }) {
  /** Zones that do not list this address family (IPv6 on IPv4-only zones). */
  const notQueried = DNSBL_ZONES.filter(
    (zone) => !address.zones.some((check) => check.zone === zone.zone),
  ).map((zone) => zone.name);
  return (
    <li>
      <code class="text-sm" safe>
        {address.ip}
      </code>
      {address.skipped ? (
        <p class="text-xs text-gray-500 dark:text-gray-400">
          Not publicly routable: not checked.
        </p>
      ) : (
        <>
          <ul class="mt-1 space-y-1">
            {address.zones.map((check) => (
              <ZoneRow check={check} />
            ))}
          </ul>
          {notQueried.length > 0 && (
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Not queried on <span safe>{notQueried.join(", ")}</span>: they do not list
              IPv6 addresses.
            </p>
          )}
        </>
      )}
    </li>
  );
}

/**
 * Blocklists (#250): the latest DNSBL self-check of each sending IP on
 * Spamhaus ZEN, Barracuda and SpamCop. Information only: a listing never
 * holds or refuses mail.
 */
function BlocklistsCard({ status }: { status: DnsblStatus }) {
  const { enabled, snapshot } = status;
  const anyUnavailable =
    snapshot?.addresses.some((address) =>
      address.zones.some((check) => check.result.status === "unavailable"),
    ) ?? false;
  return (
    <section>
      <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3 mt-8">
        Blocklists
      </h2>
      <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-5">
        {!enabled ? (
          <p class="text-sm text-gray-500 dark:text-gray-400">
            The DNSBL self-check is off (SENDING_IP_DNSBL_CHECK=false).
          </p>
        ) : snapshot === null ? (
          <p class="text-sm text-gray-500 dark:text-gray-400">
            Not checked yet: the first check runs about a minute after start, then daily.
          </p>
        ) : (
          <>
            <p class="text-sm mb-3">
              Sending IPs checked on Spamhaus ZEN, Barracuda and SpamCop, last checked{" "}
              <TimeDisplay value={snapshot.checkedAt} />.
            </p>
            {snapshot.addresses.length === 0 ? (
              <p class="text-sm text-red-600 dark:text-red-400">
                No sending IP found: set MAIL_PUBLIC_IP or give MAIL_HOSTNAME an A or AAAA
                record.
              </p>
            ) : (
              <ul class="space-y-3">
                {snapshot.addresses.map((address) => (
                  <AddressRow address={address} />
                ))}
              </ul>
            )}
            {anyUnavailable && (
              <p class="text-xs text-amber-700 dark:text-amber-400 mt-3">
                {PUBLIC_RESOLVER_HINT}.
              </p>
            )}
          </>
        )}
        <p class="text-xs text-gray-500 dark:text-gray-400 mt-3">
          Information only: a listing never holds or refuses mail.
        </p>
      </div>
    </section>
  );
}
