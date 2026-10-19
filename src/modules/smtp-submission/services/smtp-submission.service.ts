import { readFileSync } from "fs";
import { SMTPServer } from "smtp-server";
import type {
  SMTPServerAuthentication,
  SMTPServerSession,
  SMTPServerAuthenticationResponse,
  SMTPServerDataStream,
} from "smtp-server";
import { simpleParser } from "mailparser";
import type { AddressObject } from "mailparser";
import { config } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";
import { runWithLogContext, type LogContext } from "../../../utils/log-context.ts";
import { redactEmail } from "../../../utils/redact.ts";
import { hashApiKey } from "../../../utils/crypto.ts";
import { findByHash } from "../../api-keys/services/api-key.service.ts";
import { createEmail } from "../../emails/services/email.service.ts";
import { MAX_ADDRESS_LENGTH } from "../../../utils/recipients.ts";
import { SuppressedRecipientError } from "../../suppressions/errors.ts";
import { EmailSendRejectedError } from "../../emails/errors.ts";
import { InactiveApiKeyError, UnauthorizedSenderError } from "../../api-keys/errors.ts";
import type { SendEmailInput } from "../../emails/types/email.types.ts";
import {
  buildSubmissionInput,
  selectRelayHeaders,
  submissionCategory,
  submissionFromName,
} from "../message-mapper.ts";
import { SubmissionRejectedError } from "../errors.ts";
import { recordOutcome, releaseReservation, reserveAccepted } from "./usage.service.ts";
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
 * Maximum size (bytes) of a submitted message: advertised via the SIZE
 * ESMTP extension and enforced inside `onData`. Matches the inbound cap.
 */
const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

/**
 * Maximum recipients accepted per transaction. A submission client that
 * blows past this is almost certainly misbehaving; legitimate
 * transactional mail rarely exceeds a handful.
 */
const MAX_RECIPIENTS_PER_TRANSACTION = 50;

/**
 * Dropped custom headers named in one log line (#177); `droppedCount`
 * still has the total. A client adding hundreds of `X-` headers must not
 * produce a huge log line.
 */
const MAX_LOGGED_DROPPED_HEADERS = 20;

/** The running server instance, or null when stopped. */
let server: SMTPServer | null = null;

/** Interval handle for the periodic rate-limit map cleanup. */
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

/* ─── Per-IP fixed-window counters ─── */

interface WindowEntry {
  /** Number of events in the current window. */
  count: number;
  /** Timestamp (ms) when the current window started. */
  windowStart: number;
}

/** IP → connection-count state (connection rate limiting). */
const connectionMap = new Map<string, WindowEntry>();
/** IP → failed-AUTH-count state (key brute-force throttle). */
const authFailureMap = new Map<string, WindowEntry>();

/**
 * Counts one event for `ip` in its fixed window and returns the count so
 * far. A fresh window starts on the first event or after the previous one
 * expired. The counter alone (#190); {@link hitWindow} is the limiter.
 */
function countInWindow(
  map: Map<string, WindowEntry>,
  ip: string,
  windowSec: number,
): number {
  const now = Date.now();
  const entry = map.get(ip);

  if (!entry || now - entry.windowStart >= windowSec * 1000) {
    map.set(ip, { count: 1, windowStart: now });
    return 1;
  }

  entry.count += 1;
  return entry.count;
}

/**
 * Counts one event for `ip` and returns true once it is over `max`
 * events within `windowSec`.
 */
function hitWindow(
  map: Map<string, WindowEntry>,
  ip: string,
  max: number,
  windowSec: number,
): boolean {
  return countInWindow(map, ip, windowSec) > max;
}

/**
 * Read-only check of whether an IP is currently over the failed-AUTH
 * limit, without recording a new failure. Used to reject before the key
 * lookup so a locked-out IP can't keep probing keys.
 */
function isAuthLockedOut(ip: string): boolean {
  const { maxAttempts, windowSec } = config.smtpSubmission.authRateLimit;
  const entry = authFailureMap.get(ip);
  if (!entry || Date.now() - entry.windowStart >= windowSec * 1000) return false;
  return entry.count >= maxAttempts;
}

/**
 * Records a failed AUTH for an IP. Failures only expire with their
 * window: a successful AUTH does not clear them (#190), or anyone holding
 * one valid key could reset their own count between guesses at others.
 */
function recordAuthFailure(ip: string): void {
  const { windowSec } = config.smtpSubmission.authRateLimit;
  countInWindow(authFailureMap, ip, windowSec);
}

/* ─── Message parsing helpers ─── */

/**
 * Flattens a mailparser address field (single object or array) into a flat
 * list of raw addresses. Shaping (dedup, To/Cc/BCC assignment) is handled
 * by the pure `message-mapper` module.
 */
function extractAddresses(field: AddressObject | AddressObject[] | undefined): string[] {
  if (!field) return [];
  const objs = Array.isArray(field) ? field : [field];
  const out: string[] = [];
  for (const obj of objs) {
    for (const a of obj.value ?? []) {
      const addr = a.address?.trim();
      if (!addr) continue;
      /** RFC 5321 cap, applied at ingestion so an over-long (and possibly
       *  pathological) address never reaches storage or the recipient
       *  parser. Dropped, like an address that fails the shape check. */
      if (addr.length > MAX_ADDRESS_LENGTH) {
        logger.warn("SMTP submission: dropping over-long header address", {
          length: addr.length,
        });
        continue;
      }
      out.push(addr);
    }
  }
  return out;
}

/**
 * Maps an SMTP error to a response with a specific SMTP status code so the
 * submitting client sees a real rejection instead of a generic failure.
 */
function smtpError(message: string, responseCode: number): Error {
  /** `Object.assign` widens the type structurally, so no cast is needed. */
  return Object.assign(new Error(message), { responseCode });
}

/* ─── Server lifecycle ─── */

/**
 * Per live connection, by `smtp-server` session id: when it started and how
 * many messages it sent, for the close summary (#284). Removed on close.
 */
const sessionStats = new Map<string, { startedAt: number; messages: number }>();

/** The log context of one submission SMTP connection (#284). */
function sessionContext(session: { id: string }): LogContext {
  return { smtpSessionId: session.id, listener: "submission" };
}

/**
 * Starts the SMTP submission server on the configured port. Requires
 * AUTH; authenticates the password against the API-keys table. STARTTLS is
 * advertised when a cert/key pair is configured; plaintext AUTH is allowed
 * (`allowInsecureAuth`) so the common same-host / private-network setup
 * works with zero TLS configuration.
 */
export function start(portOverride?: number): void {
  const { tls, connectionRateLimit } = config.smtpSubmission;
  /** `portOverride` lets integration tests bind an isolated port. */
  const port = portOverride ?? config.smtpSubmission.port;

  /**
   * Load TLS material if both a cert and key path are configured. When
   * present, smtp-server advertises STARTTLS backed by this cert. A bad
   * path fails loudly at start rather than silently downgrading security.
   */
  let tlsOptions: { key: Buffer; cert: Buffer } | undefined;
  if (tls.certPath && tls.keyPath) {
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
   * allowed when TLS is configured (clients STARTTLS first) or the operator
   * has explicitly opted in via `SMTP_SUBMISSION_ALLOW_INSECURE=true` for a
   * trusted-network deployment. Failing fast here beats silently leaking
   * keys on the wire.
   */
  const allowInsecureAuth = config.smtpSubmission.allowInsecureAuth;
  if (!tlsOptions && !allowInsecureAuth) {
    throw new Error(
      "[smtp-submission] Refusing to start: AUTH would be accepted over a\n" +
        "  plaintext connection, and the password is a full-privilege API key.\n" +
        "  → Configure TLS (SMTP_SUBMISSION_TLS_CERT + SMTP_SUBMISSION_TLS_KEY)\n" +
        "    so clients STARTTLS before AUTH, OR set\n" +
        "    SMTP_SUBMISSION_ALLOW_INSECURE=true if the server is only reachable\n" +
        "    over a trusted network (same host / private Docker network).",
    );
  }

  server = new SMTPServer({
    ...tlsOptions,
    secure: false,
    /** AUTH is mandatory: this is the open-relay guard for submission. */
    authOptional: false,
    /** Only password-based mechanisms; the password carries the API key. */
    authMethods: ["PLAIN", "LOGIN"],
    /**
     * Allow AUTH over a plaintext connection only when opted in (#133).
     * `false` by default; the `start()` guard above already refuses to boot
     * with neither TLS nor the explicit opt-in, so reaching here with
     * `false` means TLS is configured and clients STARTTLS before AUTH.
     */
    allowInsecureAuth,
    size: MAX_MESSAGE_BYTES,

    /**
     * One summary line per connection when it closes (#284): who, how many
     * messages, how long. Runs in the session's log context.
     */
    onClose(session) {
      const stats = sessionStats.get(session.id);
      sessionStats.delete(session.id);
      runWithLogContext(sessionContext(session), () => {
        logger.info("SMTP session closed", {
          remoteAddress: session.remoteAddress,
          messages: stats?.messages ?? 0,
          durationMs:
            stats === undefined ? null : Math.round(performance.now() - stats.startedAt),
        });
      });
    },

    /**
     * Per-IP connection rate limiting (instant, no I/O). Runs before AUTH
     * to blunt connection churn. SMTP 421 = temporary rejection.
     */
    onConnect(session: SMTPServerSession, callback: (err?: Error) => void) {
      runWithLogContext(sessionContext(session), () => {
        sessionStats.set(session.id, { startedAt: performance.now(), messages: 0 });
        const ip = session.remoteAddress;
        if (
          connectionRateLimit.enabled &&
          hitWindow(
            connectionMap,
            ip,
            connectionRateLimit.max,
            connectionRateLimit.windowSec,
          )
        ) {
          logger.warn("SMTP submission connection rate limited", { ip });
          return callback(smtpError("Too many connections, try again later", 421));
        }
        callback();
      });
    },

    /**
     * Authenticate the client. The password (falling back to the username
     * for clients that only fill one field) is treated as a `bm_live_` API
     * key: SHA-256 hashed and looked up. A per-IP failed-AUTH throttle
     * blunts key brute-forcing; failures expire only with their window (#190).
     */
    onAuth(
      auth: SMTPServerAuthentication,
      session: SMTPServerSession,
      callback: (
        err: Error | null | undefined,
        response?: SMTPServerAuthenticationResponse,
      ) => void,
    ) {
      runWithLogContext(sessionContext(session), () => {
        const ip = session.remoteAddress;
        const { authRateLimit } = config.smtpSubmission;

        if (authRateLimit.enabled && isAuthLockedOut(ip)) {
          logger.warn("SMTP submission AUTH rate limited", { ip });
          /** 454 = temporary auth failure; client should back off. */
          return callback(smtpError("Too many failed authentication attempts", 454));
        }

        /** Password is the API key; some clients only set the username. */
        const candidate = auth.password || auth.username || "";
        if (!candidate) {
          if (authRateLimit.enabled) recordAuthFailure(ip);
          return callback(smtpError("Authentication credentials required", 535));
        }

        findByHash(hashApiKey(candidate))
          .then((apiKey) => {
            if (!apiKey || !apiKey.isActive) {
              if (authRateLimit.enabled) recordAuthFailure(ip);
              logger.warn("SMTP submission AUTH failed: invalid or inactive key", { ip });
              return callback(smtpError("Invalid API key", 535));
            }
            /**
             * Success: stash the key id. The IP's failure count stays until
             * its window expires (#190, see `recordAuthFailure`).
             */
            logger.info("SMTP submission client authenticated", {
              ip,
              apiKeyId: apiKey.id,
            });
            callback(null, { user: apiKey.id });
          })
          .catch((error) => {
            logger.error("SMTP submission AUTH lookup failed", {
              ip,
              error: error instanceof Error ? error.message : String(error),
            });
            /** 451 = local error; don't leak details, don't count as a guess. */
            callback(smtpError("Temporary authentication failure", 451));
          });
      });
    },

    /**
     * Cap recipients per transaction (open-relay-fanout defence). Unlike
     * the inbound receiver we do NOT validate the recipient domain:
     * submission legitimately sends to arbitrary external recipients; AUTH
     * is what prevents abuse.
     */
    onRcptTo(
      _address: { address: string },
      session: SMTPServerSession,
      callback: (err?: Error) => void,
    ) {
      runWithLogContext(sessionContext(session), () => {
        const acceptedSoFar = session.envelope.rcptTo?.length ?? 0;
        if (acceptedSoFar >= MAX_RECIPIENTS_PER_TRANSACTION) {
          logger.warn("SMTP submission RCPT TO rejected: too many recipients", {
            acceptedSoFar,
            ip: session.remoteAddress,
          });
          return callback(
            smtpError(
              `Too many recipients (max ${MAX_RECIPIENTS_PER_TRANSACTION} per transaction)`,
              452,
            ),
          );
        }
        callback();
      });
    },

    /**
     * Parse the submitted message and enqueue it via the outbound
     * pipeline, attributed to the authenticated API key.
     */
    onData(
      stream: SMTPServerDataStream,
      session: SMTPServerSession,
      callback: (err?: Error) => void,
    ) {
      runWithLogContext(sessionContext(session), () => {
        const stats = sessionStats.get(session.id);
        if (stats) stats.messages += 1;
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        let aborted = false;

        stream.on("data", (chunk: Buffer) => {
          runWithLogContext(sessionContext(session), () => {
            if (aborted) return;
            totalBytes += chunk.length;
            if (totalBytes > MAX_MESSAGE_BYTES) {
              aborted = true;
              logger.warn("SMTP submission DATA rejected: message exceeds size cap", {
                ip: session.remoteAddress,
                totalBytes,
                cap: MAX_MESSAGE_BYTES,
              });
              chunks.length = 0;
              stream.unpipe();
              stream.resume();
              callback(smtpError("Message size exceeds limit", 552));
              return;
            }
            chunks.push(chunk);
          });
        });

        stream.on("end", () => {
          runWithLogContext(sessionContext(session), () => {
            /** The listener must return void; the body is guarded by its own
             *  try/catch, and `void` keeps a rejected promise from escaping
             *  as an unhandled rejection. */
            void (async () => {
              if (aborted) return;

              /** onAuth stashed the API key id here; guard defensively. */
              const apiKeyId = session.user;
              if (!apiKeyId) {
                logger.error("SMTP submission DATA without an authenticated session");
                callback(smtpError("Authentication required", 530));
                return;
              }

              /**
               * The UTC day this message took a quota slot on, while it holds
               * one (#190); a rejection hands the slot back.
               */
              let reservedDay: string | null = null;

              try {
                /**
                 * Per-key daily quota (#123). Taken before the send, in one
                 * atomic statement (#190), so an over-quota key never queues
                 * and concurrent sessions cannot all pass a stale count. `452`
                 * is temporary: the quota window resets at the next UTC day,
                 * so the client should retry later rather than treat it as a
                 * permanent failure.
                 */
                const { dailyQuota } = config.smtpSubmission;
                if (dailyQuota > 0) {
                  reservedDay = await reserveAccepted(apiKeyId, dailyQuota);
                  if (reservedDay === null) {
                    logger.warn("SMTP submission rejected: daily quota exceeded", {
                      apiKeyId,
                      dailyQuota,
                    });
                    await recordOutcome(apiKeyId, "rejected");
                    callback(
                      smtpError(
                        `Daily send quota of ${dailyQuota} reached for this API key; resets at 00:00 UTC`,
                        452,
                      ),
                    );
                    return;
                  }
                }

                /** Raw bytes, not a UTF-8 string: each part keeps its charset (#250). */
                const parsed = await simpleParser(Buffer.concat(chunks)).catch(
                  (parseError: unknown) => {
                    logger.warn("SMTP submission message did not parse", {
                      apiKeyId,
                      error:
                        parseError instanceof Error ? parseError.name : typeof parseError,
                    });
                    throw new SubmissionRejectedError("Message could not be parsed");
                  },
                );

                /**
                 * Attachments are not supported yet: refuse the message rather
                 * than deliver it without them (#250). A recipient silently
                 * missing an attachment is worse than a clear rejection.
                 */
                if (parsed.attachments.length > 0) {
                  logger.warn("SMTP submission rejected: attachments not supported", {
                    apiKeyId,
                    attachments: parsed.attachments.length,
                  });
                  throw new SubmissionRejectedError(
                    "Attachments are not supported: send the message without them",
                  );
                }

                const envelopeFrom =
                  session.envelope.mailFrom &&
                  typeof session.envelope.mailFrom === "object"
                    ? session.envelope.mailFrom.address
                    : undefined;

                /**
                 * Custom headers to relay (#177): `In-Reply-To`, `References`
                 * and `X-*`, checked by the send API's rules. Failing ones are
                 * dropped, not refused; the log names them, never the values.
                 */
                const relayed = selectRelayHeaders(parsed.headerLines);
                if (relayed.dropped.length > 0) {
                  logger.warn("SMTP submission dropped custom headers", {
                    apiKeyId,
                    droppedCount: relayed.dropped.length,
                    dropped: relayed.dropped.slice(0, MAX_LOGGED_DROPPED_HEADERS),
                  });
                }

                /**
                 * `X-BunMail-Category` (#250): consumed here, never relayed; a
                 * value other than transactional or marketing is refused (550).
                 */
                const category = submissionCategory(parsed.headerLines);

                /**
                 * Display name of the `From:` header (#250), through the send
                 * API's rules. One that fails is dropped, not refused; the log
                 * names the field and the rule, never the value.
                 */
                const fromMailbox = parsed.from?.value?.[0];
                const submittedName = fromMailbox?.address
                  ? submissionFromName(fromMailbox.name)
                  : {};
                if (submittedName.problem) {
                  logger.warn("SMTP submission dropped the From display name", {
                    apiKeyId,
                    field: "fromName",
                    problem: submittedName.problem,
                  });
                }

                /** Delegate all shaping (sender resolution, BCC merge, To fallback). */
                const input: SendEmailInput = buildSubmissionInput({
                  fromHeader: fromMailbox?.address,
                  envelopeFrom,
                  toHeader: extractAddresses(parsed.to),
                  ccHeader: extractAddresses(parsed.cc),
                  replyToHeader: extractAddresses(parsed.replyTo),
                  envelopeRecipients: (session.envelope.rcptTo ?? []).map(
                    (r) => r.address,
                  ),
                  subject: parsed.subject ?? "",
                  html: typeof parsed.html === "string" ? parsed.html : undefined,
                  text: typeof parsed.text === "string" ? parsed.text : undefined,
                  headers: relayed.headers,
                  fromName: submittedName.fromName,
                  category,
                });

                /**
                 * Tag the row as SMTP-sourced so the dashboard can filter it
                 * (#137). SMTP has no channel for the sender-domain warnings
                 * (#245): `createEmail` logs them at `warn` with the email id.
                 */
                const { email } = await createEmail(input, apiKeyId, "smtp");
                /** With a quota, the reservation already counted it. */
                if (reservedDay === null) await recordOutcome(apiKeyId, "accepted");
                reservedDay = null;

                logger.info("SMTP submission accepted: email queued", {
                  id: email.id,
                  apiKeyId,
                  from: redactEmail(input.from),
                  to: redactEmail(input.to),
                });

                callback();
              } catch (error) {
                /**
                 * Post-auth rejection: count it against the key's daily usage,
                 * handing back the quota slot it took, if any (#190).
                 */
                const recorded =
                  reservedDay === null
                    ? recordOutcome(apiKeyId, "rejected")
                    : releaseReservation(apiKeyId, reservedDay);
                await recorded.catch((usageError: unknown) => {
                  logger.warn("SMTP submission usage not recorded", {
                    apiKeyId,
                    error:
                      usageError instanceof Error
                        ? usageError.message
                        : String(usageError),
                  });
                });
                if (error instanceof SuppressedRecipientError) {
                  logger.warn("SMTP submission rejected: recipient suppressed", {
                    apiKeyId,
                    suppressionId: error.suppressionId,
                  });
                  callback(smtpError(error.message, 550));
                  return;
                }
                /**
                 * Sender domain not registered or not DKIM-verified, missing
                 * subject (#245): permanent, the client must fix its config.
                 */
                if (error instanceof EmailSendRejectedError) {
                  logger.warn("SMTP submission rejected", { apiKeyId, code: error.code });
                  callback(smtpError(error.message, 550));
                  return;
                }
                /** Refusals the client must not retry: 550 with their (fixed) message. */
                if (
                  error instanceof UnauthorizedSenderError ||
                  error instanceof InactiveApiKeyError ||
                  error instanceof SubmissionRejectedError
                ) {
                  logger.warn("SMTP submission rejected", {
                    apiKeyId,
                    reason: error.name,
                  });
                  callback(smtpError(error.message, 550));
                  return;
                }
                /**
                 * Anything else is unexpected (a database error, a bug): logged
                 * in full (the logger strips query parameters), answered with a
                 * fixed 451 so the client retries later and no internal text
                 * reaches it.
                 */
                logger.error("SMTP submission failed unexpectedly", {
                  apiKeyId,
                  error: error instanceof Error ? error.message : String(error),
                });
                callback(smtpError("Local error in processing, try again later", 451));
              }
            })();
          });
        });
      });
    },
  });

  server.listen(port, () => {
    logger.info("SMTP submission server started", {
      port,
      tls: tlsOptions ? "STARTTLS available" : "plaintext (allowInsecureAuth)",
    });
  });

  server.on("error", (err: Error) => {
    /** Fail fast if the port can't be bound (#167); see smtp-listen.ts. */
    if (isListenError(err)) {
      logger.error(describeListenError("SMTP submission", port, err.code), {
        port,
        code: err.code,
      });
      process.exit(1);
    }
    logger.error("SMTP submission server error", { error: err.message });
  });

  /** Periodic sweep of expired rate-limit entries (every 5 minutes). */
  cleanupInterval = setInterval(
    () => {
      const now = Date.now();
      const connMs = connectionRateLimit.windowSec * 1000;
      const authMs = config.smtpSubmission.authRateLimit.windowSec * 1000;
      for (const [ip, entry] of connectionMap) {
        if (now - entry.windowStart >= connMs) connectionMap.delete(ip);
      }
      for (const [ip, entry] of authFailureMap) {
        if (now - entry.windowStart >= authMs) authFailureMap.delete(ip);
      }
    },
    5 * 60 * 1000,
  );
}

/** Stops the SMTP submission server gracefully (called on shutdown). */
export function stop(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  if (server) {
    server.close(() => {
      logger.info("SMTP submission server stopped");
    });
    server = null;
  }
}
