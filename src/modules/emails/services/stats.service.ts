import { sql } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { emails } from "../models/email.schema.ts";
import { apiKeys } from "../../api-keys/models/api-key.schema.ts";
import { domains } from "../../domains/models/domain.schema.ts";
import { logger } from "../../../utils/logger.ts";

/**
 * Dashboard stats — aggregated counts for the home page overview cards.
 */
export interface DashboardStats {
  /** Total number of emails ever sent through BunMail */
  totalEmails: number;
  /** Emails with status "sent" */
  sentCount: number;
  /** Emails with status "failed" */
  failedCount: number;
  /** Emails with status "queued" */
  queuedCount: number;
  /** Total API keys (active + revoked) */
  totalApiKeys: number;
  /** API keys that are currently active (not revoked) */
  activeApiKeys: number;
  /** Total registered domains */
  totalDomains: number;
}

/**
 * Fetches aggregated stats for the dashboard home page.
 *
 * Runs three parallel count queries — one per table — for optimal performance.
 * Uses PostgreSQL `count(*) filter(where ...)` to get multiple counts in one query.
 *
 * @returns Object with all dashboard stat counts
 */
export async function getDashboardStats(): Promise<DashboardStats> {
  logger.debug("Fetching dashboard stats");

  const [emailStats, apiKeyStats, domainStats] = await Promise.all([
    /** Email counts — total + per-status breakdown in a single query */
    db
      .select({
        total: sql<number>`count(*)::int`,
        sent: sql<number>`count(*) filter(where ${emails.status} = 'sent')::int`,
        failed: sql<number>`count(*) filter(where ${emails.status} = 'failed')::int`,
        queued: sql<number>`count(*) filter(where ${emails.status} = 'queued')::int`,
      })
      .from(emails),

    /** API key counts — total + active in a single query */
    db
      .select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter(where ${apiKeys.isActive} = true)::int`,
      })
      .from(apiKeys),

    /** Domain count */
    db
      .select({
        total: sql<number>`count(*)::int`,
      })
      .from(domains),
  ]);

  const stats: DashboardStats = {
    totalEmails: emailStats[0]?.total ?? 0,
    sentCount: emailStats[0]?.sent ?? 0,
    failedCount: emailStats[0]?.failed ?? 0,
    queuedCount: emailStats[0]?.queued ?? 0,
    totalApiKeys: apiKeyStats[0]?.total ?? 0,
    activeApiKeys: apiKeyStats[0]?.active ?? 0,
    totalDomains: domainStats[0]?.total ?? 0,
  };

  logger.debug("Dashboard stats fetched", stats as unknown as Record<string, unknown>);

  return stats;
}
