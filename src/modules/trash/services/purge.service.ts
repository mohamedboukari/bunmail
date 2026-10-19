import { and, isNotNull, lt } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { emails } from "../../emails/models/email.schema.ts";
import { inboundEmails } from "../../inbound/models/inbound-email.schema.ts";
import {
  deleteEmailsWithTombstones,
  purgeOldTombstones,
} from "../../emails/services/tombstone.service.ts";
import { purgeExpiredSessions } from "../../users/services/session.service.ts";
import { purgeStaleUserDevices } from "../../users/services/user-device.service.ts";
import {
  purgeOldAuditEvents,
  recordAuditEvent,
} from "../../audit/services/audit.service.ts";
import { purgeExpiredIdempotencyKeys } from "../../emails/services/idempotency.service.ts";
import { config } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";
import { runWithLogContext } from "../../../utils/log-context.ts";

/**
 * How often the purge runs once started, in milliseconds. We hit it
 * on boot and then every 6 hours: frequent enough to keep the table
 * pruned, infrequent enough not to thrash a busy DB.
 */
const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Reference to the setInterval timer: used to stop the purge loop. */
let purgeTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Permanently removes trashed emails / inbound emails older than
 * `TRASH_RETENTION_DAYS`. Returns the counts purged from each table.
 *
 * Outbound emails route through `deleteEmailsWithTombstones` (#34) so
 * a forensic snapshot is preserved past the hard-delete. Tombstones
 * themselves are aged out separately by `runTombstoneRetention` on the
 * same poll cadence (different, much longer, retention window).
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
 * Runs alongside `runTrashPurge` on the same 6h cadence: the cutoff
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
 * Deletes expired dashboard sessions (#216). Housekeeping only: the
 * dashboard guard enforces expiry itself, so security never depends on
 * this sweep; it keeps the `sessions` table small.
 */
export async function runSessionSweep(): Promise<{ deleted: number }> {
  const deleted = await purgeExpiredSessions();
  if (deleted > 0) {
    logger.info("Expired session sweep completed", { deleted });
  }
  return { deleted };
}

/**
 * Deletes the sign-in devices (#282) not seen for 400 days, alongside the
 * session sweep. Such a browser counts as new again at its next sign-in.
 */
export async function runDeviceSweep(): Promise<{ deleted: number }> {
  const deleted = await purgeStaleUserDevices();
  if (deleted > 0) {
    logger.info("Stale sign-in device sweep completed", { deleted });
  }
  return { deleted };
}

/**
 * Deletes audit events older than `AUDIT_LOG_RETENTION_DAYS` (#221), in
 * batches. The only delete the audit log ever sees; when it removed
 * anything, the purge itself is recorded (by BunMail, with the count), so
 * the log shows when history was dropped and under which retention.
 */
export async function runAuditRetention(): Promise<{ deleted: number }> {
  const { retentionDays } = config.auditLog;
  const deleted = await purgeOldAuditEvents(retentionDays);
  if (deleted > 0) {
    logger.info("Audit log retention sweep completed", { deleted, retentionDays });
    await recordAuditEvent({
      action: "audit_log.purged",
      actor: { type: "system", label: "retention purge" },
      target: { type: "audit_log", id: null, label: null },
      metadata: { deleted, retentionDays },
    });
  }
  return { deleted };
}

/**
 * Deletes idempotency keys (#188) past `IDEMPOTENCY_KEY_TTL_HOURS`, in
 * batches. Housekeeping only: the send API already treats an expired key
 * as absent.
 */
export async function runIdempotencyKeySweep(): Promise<{ deleted: number }> {
  const deleted = await purgeExpiredIdempotencyKeys();
  if (deleted > 0) {
    logger.info("Expired idempotency key sweep completed", {
      deleted,
      ttlHours: config.idempotency.keyTtlHours,
    });
  }
  return { deleted };
}

/**
 * One purge cycle (trash, tombstone retention, expired sessions, stale
 * sign-in devices, audit log retention, expired idempotency keys) in its
 * own log context (#284), so every line it writes carries `job: "purge"`.
 */
function runCycle(): Promise<PromiseSettledResult<unknown>[]> {
  return runWithLogContext({ job: "purge" }, () =>
    Promise.allSettled([
      runTrashPurge(),
      runTombstoneRetention(),
      runSessionSweep(),
      runDeviceSweep(),
      runAuditRetention(),
      runIdempotencyKeySweep(),
    ]),
  );
}

/**
 * Starts the trash purge loop: runs once immediately, then every 6 hours.
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

  /** Initial run on boot: catches anything that aged out while server
   *  was down. Runs every sweep; tombstone retention is cheap when the
   *  cutoff is 90 days out and the table is small, and the session sweep
   *  is one indexed DELETE. */
  void runCycle().then((results) => {
    for (const r of results) {
      if (r.status === "rejected") {
        logger.error("Initial trash purge cycle failed", {
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
      }
    }
  });

  purgeTimer = setInterval(() => {
    void runCycle().then((results) => {
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
 * Stops the trash purge loop: used during graceful shutdown.
 */
export function stop(): void {
  if (purgeTimer) {
    clearInterval(purgeTimer);
    purgeTimer = null;
    logger.info("Trash purge stopped");
  }
}
