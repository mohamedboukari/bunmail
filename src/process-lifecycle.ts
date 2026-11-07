/**
 * Process-level hooks of `src/index.ts` (#387, split from it): the crash
 * logger for uncaught errors and unhandled rejections, registered first,
 * and the graceful shutdown on SIGINT and SIGTERM, registered last.
 */
import type { startApp } from "./app.ts";
import { logger } from "./utils/logger.ts";
import * as queueService from "./modules/emails/services/queue.service.ts";
import * as smtpReceiver from "./modules/inbound/services/smtp-receiver.service.ts";
import * as smtpSubmission from "./modules/smtp-submission/services/smtp-submission.service.ts";
import * as trashPurge from "./modules/trash/services/purge.service.ts";
import * as webhookDeliveryWorker from "./modules/webhooks/services/webhook-delivery-worker.service.ts";
import * as domainReverify from "./modules/domains/services/domain-reverify.service.ts";
import * as sendingIpDnsbl from "./modules/domains/services/sending-ip-dnsbl.service.ts";
import { stopRateLimitCleanup } from "./middleware/rate-limit.ts";
import { stopLoginRateLimitCleanup } from "./middleware/login-rate-limit.ts";
import { loggableError } from "./utils/db-error.ts";
import { closeSharedStore, stopLocalCounterSweep } from "./utils/shared-store.ts";
import { stopTracing } from "./utils/tracing.ts";

/**
 * Last-resort crash lines. Without these, an uncaught error or an
 * unhandled rejection kills the process with Bun's raw stack trace on
 * stderr: not JSON, no level, no context, so a log store drops or
 * mangles the one line a postmortem needs. Each writes one structured
 * line, then exits 1 exactly like Bun's default, so Docker's restart
 * policy still brings the app back. Registered before the boot steps
 * below so a failed boot step is logged the same way.
 */
function logCrashAndExit(
  kind: "uncaughtException" | "unhandledRejection",
  error: unknown,
): never {
  logger.error("Process crashed", {
    kind,
    errorName: error instanceof Error ? error.name : typeof error,
    /** Sanitized: a drizzle query error's message embeds the query parameters. */
    error: loggableError(error),
    /** Frames only: the stack's first lines repeat the (unsanitized) message. */
    stack:
      error instanceof Error && error.stack !== undefined
        ? error.stack
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.startsWith("at "))
            .slice(0, 20)
        : undefined,
  });
  process.exit(1);
}

export function registerCrashHandlers(): void {
  process.on("uncaughtException", (error) => logCrashAndExit("uncaughtException", error));
  process.on("unhandledRejection", (reason) =>
    logCrashAndExit("unhandledRejection", reason),
  );
}

export function registerShutdownHandlers(app: ReturnType<typeof startApp>): void {
  /**
   * Graceful shutdown handler.
   * Stops the queue processor first (no new emails picked up),
   * then stops the HTTP server.
   */
  function shutdown() {
    logger.info("Shutting down...");
    queueService.stop();
    /** Hand this process's in-flight emails back before exiting (#180),
     *  instead of leaving them leased for 15 minutes. Best effort. */
    void queueService
      .releaseOwnLeases()
      .catch((error: unknown) => {
        /** Still best effort, but a postmortem needs to know why emails sat leased. */
        logger.warn(
          "Could not release email leases on shutdown; they expire on their own",
          {
            error: loggableError(error),
          },
        );
      })
      .finally(() => finishShutdown());
  }

  function finishShutdown() {
    smtpReceiver.stop();
    smtpSubmission.stop();
    trashPurge.stop();
    webhookDeliveryWorker.stop();
    domainReverify.stop();
    sendingIpDnsbl.stop();
    stopRateLimitCleanup();
    stopLoginRateLimitCleanup();
    stopLocalCounterSweep();
    closeSharedStore();
    void app.stop();
    /** Export the last spans (#363), waiting at most 5 s, then exit. Never rejects. */
    void stopTracing().finally(() => process.exit(0));
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
