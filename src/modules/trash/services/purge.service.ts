import { and, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { emails } from "../../emails/models/email.schema.ts";
import { inboundEmails } from "../../inbound/models/inbound-email.schema.ts";
import {
  deleteEmailsWithTombstones,
  purgeOldTombstones,
} from "../../emails/services/tombstone.service.ts";
import { config } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";

/**
 * How often the purge runs once started, in milliseconds. We hit it
 * on boot and then every 6 hours — frequent enough to keep the table
 * pruned, infrequent enough not to thrash a busy DB.
 */
const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Reference to the setInterval timer — used to stop the purge loop. */
let purgeTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Permanently removes trashed emails / inbound emails older than
 * `TRASH_RETENTION_DAYS`. Returns the counts purged from each table.
 *
 * Outbound emails route through `deleteEmailsWithTombstones` (#34) so
 * a forensic snapshot is preserved past the hard-delete. Tombstones
 * themselves are aged out separately by `runTombstoneRetention` on the
 * same poll cadence (different — much longer — retention window).
 *
 * Exported so tests / one-off scripts can run a single pass without
 * starting the interval.
 */
export async function runTrashPurge(): Promise<{
  emailsPurged: number;
  inboundPurged: number;
}> {
  const cutoff = new Date(Date.now() - config.trash.retentionDays * 24 * 60 * 60 * 1000);

  logger.debug("Running trash purge", {
    retentionDays: config.trash.retentionDays,
    cutoff: cutoff.toISOString(),
  });

  const [emailRows, inboundRows] = await Promise.all([
    deleteEmailsWithTombstones(
      and(isNotNull(emails.deletedAt), lt(emails.deletedAt, cutoff)),
    ),
    db
      .delete(inboundEmails)
      .where(and(isNotNull(inboundEmails.deletedAt), lt(inboundEmails.deletedAt, cutoff)))
      .returning({ id: inboundEmails.id }),
  ]);

  const emailsPurged = emailRows.length;
  const inboundPurged = inboundRows.length;

  if (emailsPurged + inboundPurged > 0) {
    logger.info("Trash purge completed", { emailsPurged, inboundPurged });
  }

  return { emailsPurged, inboundPurged };
}

/**
 * Sweeps tombstones older than `TOMBSTONE_RETENTION_DAYS` (#34).
 * Runs alongside `runTrashPurge` on the same 6h cadence — the cutoff
 * is much longer (90 days default) so most calls find nothing to do.
 */
export async function runTombstoneRetention(): Promise<{ deleted: number }> {
  const cutoff = new Date(
    Date.now() - config.trash.tombstoneRetentionDays * 24 * 60 * 60 * 1000,
  );
  logger.debug("Running tombstone retention sweep", {
    retentionDays: config.trash.tombstoneRetentionDays,
    cutoff: cutoff.toISOString(),
  });
  const result = await purgeOldTombstones({ olderThan: cutoff });
  if (result.deleted > 0) {
    logger.info("Tombstone retention sweep completed", { deleted: result.deleted });
  }
  return result;
}

/**
 * Starts the trash purge loop — runs once immediately, then every 6 hours.
 * Safe to call multiple times: subsequent calls are no-ops if already running.
 */
export function start(): void {
  if (purgeTimer) {
    logger.debug("Trash purge already running");
    return;
  }

  logger.info("Starting trash purge", {
    retentionDays: config.trash.retentionDays,
    intervalHours: PURGE_INTERVAL_MS / (60 * 60 * 1000),
  });

  /** Initial run on boot — catches anything that aged out while server
   *  was down. Runs both sweeps; tombstone retention is cheap when the
   *  cutoff is 90 days out and the table is small. */
  Promise.allSettled([runTrashPurge(), runTombstoneRetention()]).then((results) => {
    for (const r of results) {
      if (r.status === "rejected") {
        logger.error("Initial trash purge cycle failed", {
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
      }
    }
  });

  purgeTimer = setInterval(() => {
    Promise.allSettled([runTrashPurge(), runTombstoneRetention()]).then((results) => {
      for (const r of results) {
        if (r.status === "rejected") {
          logger.error("Scheduled trash purge cycle failed", {
            error: r.reason instanceof Error ? r.reason.message : String(r.reason),
          });
        }
      }
    });
  }, PURGE_INTERVAL_MS);
}

/**
 * Stops the trash purge loop — used during graceful shutdown.
 */
export function stop(): void {
  if (purgeTimer) {
    clearInterval(purgeTimer);
    purgeTimer = null;
    logger.info("Trash purge stopped");
  }
}

/**
 * Returns rough statistics about what's currently in trash.
 * Used by the dashboard to decide whether to show "Empty trash" buttons.
 */
export async function getTrashStats(): Promise<{
  emailsInTrash: number;
  inboundInTrash: number;
}> {
  const [emailCount, inboundCount] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(emails)
      .where(isNotNull(emails.deletedAt)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(inboundEmails)
      .where(isNotNull(inboundEmails.deletedAt)),
  ]);

  return {
    emailsInTrash: emailCount[0]?.count ?? 0,
    inboundInTrash: inboundCount[0]?.count ?? 0,
  };
}
