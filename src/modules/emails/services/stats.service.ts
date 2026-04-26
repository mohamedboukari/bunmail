import { sql, isNull, isNotNull } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { emails } from "../models/email.schema.ts";
import { apiKeys } from "../../api-keys/models/api-key.schema.ts";
import { domains } from "../../domains/models/domain.schema.ts";
import { templates } from "../../templates/models/template.schema.ts";
import { webhooks } from "../../webhooks/models/webhook.schema.ts";
import { inboundEmails } from "../../inbound/models/inbound-email.schema.ts";
import { logger } from "../../../utils/logger.ts";

/**
 * Dashboard stats — aggregated counts for the home page.
 *
 * All "live" counts exclude soft-deleted (trashed) rows. The trash counts
 * are explicitly trashed-only so the home page can surface them as their
 * own metric.
 */
export interface DashboardStats {
  /** Total non-trashed outbound emails */
  totalEmails: number;
  /** Outbound emails currently with status "sent" */
  sentCount: number;
  /** Outbound emails currently with status "failed" */
  failedCount: number;
  /** Outbound emails currently with status "queued" */
  queuedCount: number;
  /** Outbound emails sent within the last 24h (status = sent) */
  sentLast24h: number;
  /** Outbound emails that failed within the last 24h */
  failedLast24h: number;
  /**
   * Success rate as a fraction in [0, 1]. Sent / (sent + failed). When no
   * email has reached a terminal state yet, this is `null`.
   */
  successRate: number | null;
  /** Total inbound emails (non-trashed) */
  inboundTotal: number;
  /** Inbound emails received within the last 24h */
  inboundLast24h: number;
  /** Outbound emails currently in trash */
  emailsInTrash: number;
  /** Inbound emails currently in trash */
  inboundInTrash: number;
  /** Total API keys (active + revoked) */
  totalApiKeys: number;
  /** Active API keys (not revoked) */
  activeApiKeys: number;
  /** Total registered domains */
  totalDomains: number;
  /** Total saved email templates */
  totalTemplates: number;
  /** Total registered webhooks */
  totalWebhooks: number;
}

/**
 * Fetches every stat displayed on the dashboard home page.
 *
 * Runs all the count queries in parallel so the page renders quickly.
 * The 24h cutoff is computed once and reused across queries to keep
 * the numbers consistent within a single request.
 */
export async function getDashboardStats(): Promise<DashboardStats> {
  logger.debug("Fetching dashboard stats");

  /** Cutoff for "last 24h" metrics — computed once for consistency */
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  /**
   * Email aggregates (non-trashed): total + per-status + last-24h breakdown.
   * Single query using PostgreSQL `count(*) filter (where ...)` to avoid
   * multiple table scans.
   */
  const emailStatsQuery = db
    .select({
      total: sql<number>`count(*)::int`,
      sent: sql<number>`count(*) filter(where ${emails.status} = 'sent')::int`,
      failed: sql<number>`count(*) filter(where ${emails.status} = 'failed')::int`,
      queued: sql<number>`count(*) filter(where ${emails.status} = 'queued')::int`,
      sentLast24h: sql<number>`count(*) filter(where ${emails.status} = 'sent' and ${emails.sentAt} >= ${since24h})::int`,
      failedLast24h: sql<number>`count(*) filter(where ${emails.status} = 'failed' and ${emails.updatedAt} >= ${since24h})::int`,
    })
    .from(emails)
    .where(isNull(emails.deletedAt));

  /** Trash counts — single query, both tables */
  const emailsTrashQuery = db
    .select({ count: sql<number>`count(*)::int` })
    .from(emails)
    .where(isNotNull(emails.deletedAt));

  const inboundTrashQuery = db
    .select({ count: sql<number>`count(*)::int` })
    .from(inboundEmails)
    .where(isNotNull(inboundEmails.deletedAt));

  /** Inbound stats: total + last 24h */
  const inboundStatsQuery = db
    .select({
      total: sql<number>`count(*)::int`,
      last24h: sql<number>`count(*) filter(where ${inboundEmails.receivedAt} >= ${since24h})::int`,
    })
    .from(inboundEmails)
    .where(isNull(inboundEmails.deletedAt));

  const apiKeyStatsQuery = db
    .select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter(where ${apiKeys.isActive} = true)::int`,
    })
    .from(apiKeys);

  const domainCountQuery = db.select({ total: sql<number>`count(*)::int` }).from(domains);

  const templateCountQuery = db
    .select({ total: sql<number>`count(*)::int` })
    .from(templates);

  const webhookCountQuery = db
    .select({ total: sql<number>`count(*)::int` })
    .from(webhooks);

  const [
    emailStats,
    [emailsTrashRow],
    [inboundTrashRow],
    [inboundStats],
    apiKeyStats,
    domainCount,
    templateCount,
    webhookCount,
  ] = await Promise.all([
    emailStatsQuery,
    emailsTrashQuery,
    inboundTrashQuery,
    inboundStatsQuery,
    apiKeyStatsQuery,
    domainCountQuery,
    templateCountQuery,
    webhookCountQuery,
  ]);

  const sent = emailStats[0]?.sent ?? 0;
  const failed = emailStats[0]?.failed ?? 0;
  const terminalCount = sent + failed;

  /** Avoid divide-by-zero — surface as null when nothing terminal yet */
  const successRate = terminalCount > 0 ? sent / terminalCount : null;

  const stats: DashboardStats = {
    totalEmails: emailStats[0]?.total ?? 0,
    sentCount: sent,
    failedCount: failed,
    queuedCount: emailStats[0]?.queued ?? 0,
    sentLast24h: emailStats[0]?.sentLast24h ?? 0,
    failedLast24h: emailStats[0]?.failedLast24h ?? 0,
    successRate,
    inboundTotal: inboundStats?.total ?? 0,
    inboundLast24h: inboundStats?.last24h ?? 0,
    emailsInTrash: emailsTrashRow?.count ?? 0,
    inboundInTrash: inboundTrashRow?.count ?? 0,
    totalApiKeys: apiKeyStats[0]?.total ?? 0,
    activeApiKeys: apiKeyStats[0]?.active ?? 0,
    totalDomains: domainCount[0]?.total ?? 0,
    totalTemplates: templateCount[0]?.total ?? 0,
    totalWebhooks: webhookCount[0]?.total ?? 0,
  };

  logger.debug("Dashboard stats fetched", stats as unknown as Record<string, unknown>);

  return stats;
}
