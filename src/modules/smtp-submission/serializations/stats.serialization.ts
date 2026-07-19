import type { UsageStats } from "../services/usage.service.ts";

/** Public response shape for the submission stats endpoint (#123). */
export interface SerializedSubmissionStats {
  window: { days: number };
  /**
   * Quota status for the calling key. `daily` is null when quotas are
   * disabled (`SMTP_SUBMISSION_DAILY_QUOTA=0`); `remaining` is null too in
   * that case (there's no ceiling to count down from).
   */
  quota: {
    daily: number | null;
    usedToday: number;
    remaining: number | null;
  };
  totals: { accepted: number; rejected: number };
  daily: Array<{ day: string; accepted: number; rejected: number }>;
}

/**
 * Shapes the usage aggregate + quota context into the API response.
 * `dailyQuota` of 0 (unlimited) is surfaced as `daily: null` so clients
 * don't misread a literal 0 as "no sends allowed".
 */
export function serializeSubmissionStats(args: {
  stats: UsageStats;
  dailyQuota: number;
  usedToday: number;
}): SerializedSubmissionStats {
  const { stats, dailyQuota, usedToday } = args;
  const unlimited = dailyQuota <= 0;
  return {
    window: { days: stats.days },
    quota: {
      daily: unlimited ? null : dailyQuota,
      usedToday,
      remaining: unlimited ? null : Math.max(0, dailyQuota - usedToday),
    },
    totals: stats.totals,
    daily: stats.daily,
  };
}
