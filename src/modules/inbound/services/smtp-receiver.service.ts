/**
 * The inbound SMTP receiver's public surface: `start`, `stop`,
 * `listeningPort` (#443) and `storeInboundEmail` (#387). The rest lives in one file per concern,
 * beside this one:
 *
 *   - `smtp-receiver-session.service.ts`: per-connection stats, log context, spans, SMTP errors
 *   - `smtp-receiver-handlers.service.ts`: the connect, MAIL FROM, RCPT TO and close handlers
 *   - `smtp-receiver-data.service.ts`: the DATA handler and its branches
 *   - `smtp-receiver-store.service.ts`: the stored message and its `email.received` event
 *
 * Importers keep using this module.
 */
import { readFileSync } from "fs";
import { SMTPServer } from "smtp-server";
export { storeInboundEmail } from "./smtp-receiver-store.service.ts";
import { inboundNotifyDeps, type InboundNotifyDeps } from "./inbound-notify.service.ts";
import { selfTestDnsbl } from "./dnsbl.service.ts";
import { receiverSessionHandlers } from "./smtp-receiver-handlers.service.ts";
import {
  boundPort,
  describeListenError,
  isListenError,
  tlsSocketError,
} from "./smtp-listen.ts";
import { MAX_MESSAGE_BYTES, receiverDataHandler } from "./smtp-receiver-data.service.ts";
import { config } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";

/** Reference to the running SMTP server instance */
let server: SMTPServer | null = null;

/** Client TLS errors already logged; smtp-server can emit one twice (#414). */
const reportedTlsErrors = new WeakSet<Error>();

/** Interval handle for the inbound notification budget cleanup */
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Resolves with the bound port once the running server listens (#443), or
 * null when stopped. Read through `listeningPort()`.
 */
let listening: Promise<number> | null = null;

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
 * Reads the STARTTLS certificate and key (#414). A bad path fails the
 * start loudly rather than silently running without STARTTLS.
 */
function readTlsMaterial(tls: { certPath: string; keyPath: string }): {
  key: Buffer;
  cert: Buffer;
} {
  try {
    return { cert: readFileSync(tls.certPath), key: readFileSync(tls.keyPath) };
  } catch (error) {
    throw new Error(
      `[smtp] Failed to read the inbound TLS cert/key from ` +
        `SMTP_TLS_CERT="${tls.certPath}" / SMTP_TLS_KEY="${tls.keyPath}"`,
      { cause: error },
    );
  }
}

/**
 * Starts the receiver. `notifyDeps` are the inbound notification
 * dependencies (mailer, clock, throttle), injectable for tests.
 *
 * With `SMTP_TLS_CERT` / `SMTP_TLS_KEY` set (#414), STARTTLS is offered
 * (RFC 3207): opportunistic, never required, as an MX must take mail from
 * senders without TLS. smtp-server upgrades the connection itself and
 * forgets everything said before the handshake (EHLO, the transaction),
 * and discards plaintext pipelined after `STARTTLS`. This needs Bun 1.4.4
 * or later; the config refuses to boot with a cert on an older Bun.
 */
export function start(notifyDeps: InboundNotifyDeps = inboundNotifyDeps()): void {
  const port = config.smtp.port;
  const { spamProtection, tls } = config.smtp;

  /** Does the DNSBL zone answer through this resolver? One line at boot, never fatal. */
  if (spamProtection.dnsblEnabled) void selfTestDnsbl(spamProtection.dnsblZone);

  const tlsMaterial = tls === null ? null : readTlsMaterial(tls);

  const smtp = new SMTPServer({
    secure: false,
    /** The certificate STARTTLS presents; without one STARTTLS is disabled below. */
    ...tlsMaterial,
    authOptional: true,
    disabledCommands: tlsMaterial === null ? ["STARTTLS", "AUTH"] : ["AUTH"],

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
  server = smtp;

  /** Settles `listening` from the listen callback below. */
  let resolveListening: (bound: number) => void = () => undefined;
  listening = new Promise<number>((resolve) => {
    resolveListening = resolve;
  });

  smtp.listen(port, () => {
    /**
     * The port actually bound: SMTP_PORT in production, the OS's pick when
     * a test sets the port to `0` (#443).
     */
    const bound = boundPort(smtp.server, port);
    logger.info("Inbound SMTP server started", {
      port: bound,
      starttls: tlsMaterial !== null,
    });
    resolveListening(bound);

    /** Log which protection layers are active */
    logger.info("SMTP spam protection", {
      dnsbl: spamProtection.dnsblEnabled ? spamProtection.dnsblZone : "disabled",
      recipientValidation: spamProtection.recipientValidationEnabled,
      rateLimit: spamProtection.rateLimitEnabled
        ? `${spamProtection.rateLimitMax}/${spamProtection.rateLimitWindowSec}s`
        : "disabled",
    });
  });

  smtp.on("error", (err) => {
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
    /**
     * A client's TLS error (#414: a failed STARTTLS handshake, or a broken
     * record later) is expected on a public port: one `warn` per error
     * (smtp-server can report the same one twice), with the client's IP,
     * the TLS error code and whether it was a STARTTLS connection.
     */
    const tlsError = tlsSocketError(err);
    if (tlsError !== null) {
      if (reportedTlsErrors.has(err)) return;
      reportedTlsErrors.add(err);
      logger.warn("Inbound SMTP TLS error", {
        ip: tlsError.ip,
        code: tlsError.code,
        starttls: tlsError.starttls,
      });
      return;
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
 * The port the running receiver is bound to, once it listens (#443). Lets
 * the integration tests set `config.smtp.port` to `0` (a free port the OS
 * picks) and point their client at the real one. Rejects when stopped.
 */
export function listeningPort(): Promise<number> {
  if (listening === null) {
    return Promise.reject(new Error("[smtp-receiver] the server is not started"));
  }
  return listening;
}

/**
 * Stops the inbound SMTP server gracefully.
 * Called during application shutdown (SIGINT / SIGTERM).
 */
export function stop(): void {
  listening = null;
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
