import { readFileSync } from "fs";
import type { Server as TlsServer } from "tls";
import { SMTPServer } from "smtp-server";
import { config } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";
import { createImplicitTlsListener } from "./smtp-submission-tls.service.ts";
import { submissionDataHandler } from "./smtp-submission-data.service.ts";
import { submissionSessionHandlers } from "./smtp-submission-handlers.service.ts";
import { resetSubmissionLimits } from "./submission-limits.ts";
import {
  describeListenError,
  isListenError,
} from "../../inbound/services/smtp-listen.ts";

/**
 * The SMTP submission server (#120) lets any SMTP-capable app (Infisical,
 * Netbird, Dify, a NestJS/Nodemailer backend, …) send *through* BunMail by
 * pointing its SMTP settings here and authenticating with a `bm_live_` API
 * key as the password. Accepted messages are handed to the normal outbound
 * pipeline via `createEmail` (queue → DKIM → direct-to-MX).
 *
 * This is deliberately distinct from the inbound receiver
 * (`src/modules/inbound/services/smtp-receiver.service.ts`): inbound has
 * AUTH disabled and validates recipient domains (it's an MX receiver);
 * submission *requires* AUTH and relays to any recipient (the open-relay
 * guard here is authentication, not recipient-domain validation).
 */

/**
 * The server's public surface: `start`, `stop` and the message size cap
 * (#387). The rest lives in one file per concern, beside this one:
 *
 *   - `smtp-submission-session.service.ts`: per-connection stats, log context, spans, SMTP errors
 *   - `smtp-submission-tls.service.ts`: the implicit-TLS listener (#349, #351)
 *   - `smtp-submission-handlers.service.ts`: the connect, AUTH, RCPT TO and close handlers
 *   - `smtp-submission-data.service.ts`: the DATA handler, parse and enqueue
 *
 * Importers keep using this module.
 */

/** The size cap of a submitted message without attachments (the inbound cap). */
const BASE_MESSAGE_BYTES = 10 * 1024 * 1024;

/** MIME room per attachment part (boundary, part headers) for up to 10 parts. */
const ATTACHMENT_MIME_OVERHEAD_BYTES = 64 * 1024;

/**
 * Maximum size (bytes) of a submitted message for an attachment budget
 * (#181): advertised via the SIZE ESMTP extension and enforced inside
 * `onData`. The base cap plus the budget as MIME encodes it: base64 (4/3)
 * in 76-character lines with CRLF (78/76), plus the part headers. About
 * 17.4 MB with the default 5 MB budget, 35.2 MB at 18.
 */
export function submissionMaxMessageBytes(attachmentsMaxTotalBytes: number): number {
  return (
    BASE_MESSAGE_BYTES +
    Math.ceil(((attachmentsMaxTotalBytes * 4) / 3) * (78 / 76)) +
    ATTACHMENT_MIME_OVERHEAD_BYTES
  );
}

/** The running server instance, or null when stopped. */
let server: SMTPServer | null = null;

/** The TLS listener in front of `server` in implicit mode (#349), or null. */
let tlsListener: TlsServer | null = null;

/* ─── Server lifecycle ─── */

/**
 * Starts the SMTP submission server on the configured port. Requires
 * AUTH; authenticates the password against the API-keys table. The TLS
 * mode comes from `config.smtpSubmission.tls.mode` (#349):
 *
 * - `implicit`: TLS from the first byte. The runtime's own TLS server
 *   (`tls.createServer`) terminates it and hands each decrypted socket to
 *   smtp-server, which runs as `secure` + `secured` ("TLS done upstream"):
 *   every session is TLS, STARTTLS is not offered, and AUTH is allowed.
 * - `starttls` (Node only, refused at boot under Bun): smtp-server offers
 *   STARTTLS and refuses AUTH before it.
 * - `none`: plaintext, which needs `SMTP_SUBMISSION_ALLOW_INSECURE=true`
 *   (#133) for AUTH, so a trusted-network setup works without a cert.
 */
export function start(portOverride?: number): void {
  const { tls, connectionRateLimit } = config.smtpSubmission;
  /** `portOverride` lets integration tests bind an isolated port. */
  const port = portOverride ?? config.smtpSubmission.port;

  /**
   * The per-IP counters in memory belong to one running server: a server
   * started again (the tests start and stop it per file) begins with none,
   * as a restarted process does, instead of inheriting the previous run's
   * connection and failed-AUTH budget. Counts in Redis (#185) are shared
   * by every replica and stay. Ended windows in memory are swept with every
   * other shared-store counter (`startLocalCounterSweep`).
   */
  resetSubmissionLimits();

  /**
   * Load the TLS material when a mode needs it. A bad path fails loudly at
   * start rather than silently downgrading security.
   */
  let tlsOptions: { key: Buffer; cert: Buffer } | undefined;
  if (tls.mode !== "none") {
    try {
      tlsOptions = {
        cert: readFileSync(tls.certPath),
        key: readFileSync(tls.keyPath),
      };
    } catch (error) {
      throw new Error(
        `[smtp-submission] Failed to read TLS cert/key from ` +
          `SMTP_SUBMISSION_TLS_CERT="${tls.certPath}" / ` +
          `SMTP_SUBMISSION_TLS_KEY="${tls.keyPath}"`,
        { cause: error },
      );
    }
  }

  /**
   * Refuse to accept AUTH credentials in cleartext by default (#133). The
   * password is a full-privilege `bm_live_…` key. Plaintext AUTH is only
   * allowed when the operator has explicitly opted in via
   * `SMTP_SUBMISSION_ALLOW_INSECURE=true` for a trusted-network deployment
   * without TLS. With TLS configured the flag is ignored: AUTH only over TLS.
   * Failing fast here beats silently leaking keys on the wire.
   */
  if (tls.mode === "none" && !config.smtpSubmission.allowInsecureAuth) {
    throw new Error(
      "[smtp-submission] Refusing to start: AUTH would be accepted over a\n" +
        "  plaintext connection, and the password is a full-privilege API key.\n" +
        "  → Configure TLS (SMTP_SUBMISSION_TLS_CERT + SMTP_SUBMISSION_TLS_KEY)\n" +
        "    so clients connect over TLS (port 465), OR set\n" +
        "    SMTP_SUBMISSION_ALLOW_INSECURE=true if the server is only reachable\n" +
        "    over a trusted network (same host / private Docker network).",
    );
  }
  const allowInsecureAuth = tls.mode === "none";
  const implicit = tls.mode === "implicit";

  const maxMessageBytes = submissionMaxMessageBytes(config.attachments.maxTotalBytes);

  const smtp = new SMTPServer({
    /** STARTTLS uses the cert itself; in implicit mode the TLS server holds it. */
    ...(tls.mode === "starttls" ? tlsOptions : {}),
    /**
     * Implicit TLS (#349): the sessions arrive already decrypted from the
     * TLS listener below, so smtp-server treats them as secure (no
     * STARTTLS offer, AUTH allowed) and `secured` says the TLS is done
     * upstream: it never wraps a socket itself (which Bun cannot do) and
     * does not warn about its built-in default certificate.
     */
    secure: implicit,
    secured: implicit,
    /** AUTH is mandatory: this is the open-relay guard for submission. */
    authOptional: false,
    /** Only password-based mechanisms; the password carries the API key. */
    authMethods: ["PLAIN", "LOGIN"],
    /**
     * Allow AUTH over a plaintext connection only without TLS, and the
     * `start()` guard above has already refused to boot unless the operator
     * opted in (#133). With a cert, AUTH needs TLS first (#349).
     */
    allowInsecureAuth,
    size: maxMessageBytes,

    ...submissionSessionHandlers({ connectionRateLimit }),
    ...submissionDataHandler({ maxMessageBytes }),
  });

  server = smtp;

  /** Fail fast if the port can't be bound (#167); see smtp-listen.ts. */
  const onServerError = (err: Error): void => {
    if (isListenError(err)) {
      logger.error(describeListenError("SMTP submission", port, err.code), {
        port,
        code: err.code,
      });
      process.exit(1);
    }
    logger.error("SMTP submission server error", { error: err.message });
  };
  smtp.on("error", onServerError);

  const onListening = (): void => {
    logger.info("SMTP submission server started", { port, tls: tls.mode });
  };

  if (implicit && tlsOptions) {
    tlsListener = createImplicitTlsListener(smtp, tlsOptions);
    tlsListener.on("error", onServerError);
    tlsListener.listen(port, onListening);
  } else {
    smtp.listen(port, onListening);
  }
}

/** Stops the SMTP submission server gracefully (called on shutdown). */
export function stop(): void {
  if (tlsListener) {
    tlsListener.close();
    tlsListener = null;
  }
  if (server) {
    server.close(() => {
      logger.info("SMTP submission server stopped");
    });
    server = null;
  }
}
