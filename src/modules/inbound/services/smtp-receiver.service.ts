/**
 * The inbound SMTP receiver's public surface: `start`, `stop` and
 * `storeInboundEmail` (#387). The rest lives in one file per concern,
 * beside this one:
 *
 *   - `smtp-receiver-session.service.ts`: per-connection stats, log context, spans, SMTP errors
 *   - `smtp-receiver-handlers.service.ts`: the connect, MAIL FROM, RCPT TO and close handlers
 *   - `smtp-receiver-data.service.ts`: the DATA handler and its branches
 *   - `smtp-receiver-store.service.ts`: the stored message and its `email.received` event
 *
 * Importers keep using this module.
 */
import { SMTPServer } from "smtp-server";
export { storeInboundEmail } from "./smtp-receiver-store.service.ts";
import { inboundNotifyDeps, type InboundNotifyDeps } from "./inbound-notify.service.ts";
import { selfTestDnsbl } from "./dnsbl.service.ts";
import { receiverSessionHandlers } from "./smtp-receiver-handlers.service.ts";
import { describeListenError, isListenError } from "./smtp-listen.ts";
import { MAX_MESSAGE_BYTES, receiverDataHandler } from "./smtp-receiver-data.service.ts";
import { config } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";

/** Reference to the running SMTP server instance */
let server: SMTPServer | null = null;

/** Interval handle for the inbound notification budget cleanup */
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the inbound SMTP server.
 *
 * Listens on the configured SMTP_PORT (default 2525) and accepts
 * incoming emails. Each message is parsed, stored in the database,
 * and forwarded to webhooks as an `email.received` event.
 *
 * Three spam protection layers run before message processing:
 * 1. Per-IP rate limiting (shared store: memory, or Redis, #185; see
 *    `connection-limit.ts`)
 * 2. DNSBL IP check (async DNS lookup against Spamhaus ZEN)
 * 3. Recipient domain validation (DB check against registered domains)
 */

/**
 * Starts the receiver. `notifyDeps` are the inbound notification
 * dependencies (mailer, clock, throttle), injectable for tests.
 */
export function start(notifyDeps: InboundNotifyDeps = inboundNotifyDeps()): void {
  const port = config.smtp.port;
  const { spamProtection } = config.smtp;

  /** Does the DNSBL zone answer through this resolver? One line at boot, never fatal. */
  if (spamProtection.dnsblEnabled) void selfTestDnsbl(spamProtection.dnsblZone);

  server = new SMTPServer({
    secure: false,
    authOptional: true,
    disabledCommands: ["STARTTLS", "AUTH"],

    /**
     * Maximum message size (bytes). The SMTP server advertises this via
     * the `SIZE` ESMTP extension at the EHLO greeting and rejects
     * `MAIL FROM` with `SIZE=` exceeding it. We also belt-and-suspenders
     * the cap inside `onData` against streams that don't pre-declare size.
     */
    size: MAX_MESSAGE_BYTES,

    ...receiverSessionHandlers({ spamProtection }),
    ...receiverDataHandler({ notifyDeps }),
  });

  server.listen(port, () => {
    logger.info("Inbound SMTP server started", { port });

    /** Log which protection layers are active */
    logger.info("SMTP spam protection", {
      dnsbl: spamProtection.dnsblEnabled ? spamProtection.dnsblZone : "disabled",
      recipientValidation: spamProtection.recipientValidationEnabled,
      rateLimit: spamProtection.rateLimitEnabled
        ? `${spamProtection.rateLimitMax}/${spamProtection.rateLimitWindowSec}s`
        : "disabled",
    });
  });

  server.on("error", (err) => {
    /**
     * Fail fast if the port can't be bound (#167). Logging and carrying on
     * left the HTTP side (and its health check) up while no mail could
     * arrive; exiting makes the outage a visible restart loop instead.
     */
    if (isListenError(err)) {
      logger.error(describeListenError("Inbound SMTP", port, err.code), {
        port,
        code: err.code,
      });
      process.exit(1);
    }
    logger.error("SMTP server error", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  /**
   * Periodic cleanup of the inbound notification budget (#250), every 5
   * minutes. The per-IP connection counts are swept with every other
   * shared-store counter (`startLocalCounterSweep`).
   */
  cleanupInterval = setInterval(
    () => {
      notifyDeps.throttle.prune(notifyDeps.now());
    },
    5 * 60 * 1000,
  );
}

/**
 * Stops the inbound SMTP server gracefully.
 * Called during application shutdown (SIGINT / SIGTERM).
 */
export function stop(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }

  if (server) {
    server.close(() => {
      logger.info("Inbound SMTP server stopped");
    });
    server = null;
  }
}
