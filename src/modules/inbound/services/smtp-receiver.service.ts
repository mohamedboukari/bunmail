import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import { db } from "../../../db/index.ts";
import { inboundEmails } from "../models/inbound-email.schema.ts";
import { generateId } from "../../../utils/id.ts";
import { enqueueEvent } from "../../webhooks/services/webhook-dispatch.service.ts";
import { domainExistsByName } from "../../domains/services/domain.service.ts";
import {
  inboundNotifyDeps,
  notifyInboundReceived,
  type InboundNotifyDeps,
} from "./inbound-notify.service.ts";
import { isBlacklistedIp } from "./dnsbl.service.ts";
import { describeListenError, isListenError } from "./smtp-listen.ts";
import { parseBounce } from "../../bounces/services/bounce-parser.service.ts";
import {
  handleParsedBounce,
  resolveReturnPath,
  type ReturnPathBinding,
} from "../../bounces/services/bounce-handler.service.ts";
import { isReturnPathAddress } from "../../bounces/services/return-path.ts";
import { persistDmarcReportFromInbound } from "../../dmarc-reports/services/dmarc-handler.service.ts";
import { isFeedbackReport } from "./arf-parser.service.ts";
import { handleInboundFeedbackReport } from "./feedback-handler.service.ts";
import { threadingColumnsFor } from "./reply-threading.service.ts";
import { config } from "../../../config.ts";
import { MAX_ADDRESS_LENGTH } from "../../../utils/recipients.ts";
import { logger } from "../../../utils/logger.ts";
import { loggableError } from "../../../utils/db-error.ts";
import { runWithLogContext, type LogContext } from "../../../utils/log-context.ts";
import { redactEmail } from "../../../utils/redact.ts";
import { tokenFromUnsubscribeAddress } from "../../suppressions/services/unsubscribe-token.ts";
import {
  resolveUnsubscribeToken,
  unsubscribe,
  type UnsubscribeTarget,
} from "../../suppressions/services/unsubscribe.service.ts";

/**
 * Maximum size (bytes) of any single inbound message: RFC 5321 SIZE
 * extension value advertised on connect, and the upper bound enforced
 * inside `onData`. 10 MB matches typical receiving-MTA defaults.
 */
const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

/**
 * Maximum number of recipients accepted per SMTP transaction. Without
 * a cap a single connection can RCPT-bomb us into using the server as
 * a fan-out relay; legitimate transactional inbound rarely exceeds 5.
 */
const MAX_RECIPIENTS_PER_TRANSACTION = 50;

/**
 * Permissive RFC-5321-ish address validator: rejects obviously broken
 * envelopes (`MAIL FROM:<>` is allowed for bounces, see `onMailFrom`).
 * We don't enforce full RFC 5321 here because real-world senders are
 * varied and a strict regex would drop legitimate mail.
 */
/** Linear form (domain labels exclude the dot, so nothing overlaps); see
 *  `EMAIL_RE` in src/utils/recipients.ts for why the previous shape
 *  backtracked quadratically. */
const BASIC_ADDRESS_RE = /^[^\s@<>]+@[^\s@<>.]+(?:\.[^\s@<>.]+)+$/;

/** Reference to the running SMTP server instance */
let server: SMTPServer | null = null;

/** Interval handle for rate limit map cleanup */
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

/* ─── Per-IP SMTP connection rate limiting ─── */

/** Tracks connection count and window start per IP */
interface SmtpRateLimitEntry {
  /** Number of connections in the current window */
  count: number;
  /** Timestamp (ms) when the current window started */
  windowStart: number;
}

/** In-memory map of IP → rate limit state */
const rateLimitMap = new Map<string, SmtpRateLimitEntry>();

/**
 * Checks and increments the per-IP SMTP connection counter.
 * Returns true if the IP has exceeded the configured limit.
 *
 * Uses a sliding window identical to the HTTP rate limiter pattern
 * in src/middleware/rate-limit.ts.
 *
 * @param ip - The connecting client's IP address
 */
function isRateLimited(ip: string): boolean {
  const { rateLimitMax, rateLimitWindowSec } = config.smtp.spamProtection;
  const windowMs = rateLimitWindowSec * 1000;
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  /** New IP or expired window: start fresh */
  if (!entry || now - entry.windowStart >= windowMs) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return false;
  }

  entry.count += 1;
  return entry.count > rateLimitMax;
}

/**
 * Starts the inbound SMTP server.
 *
 * Listens on the configured SMTP_PORT (default 2525) and accepts
 * incoming emails. Each message is parsed, stored in the database,
 * and forwarded to webhooks as an `email.received` event.
 *
 * Three spam protection layers run before message processing:
 * 1. Per-IP rate limiting (in-memory, instant)
 * 2. DNSBL IP check (async DNS lookup against Spamhaus ZEN)
 * 3. Recipient domain validation (DB check against registered domains)
 */

/**
 * Per live connection, by `smtp-server` session id: when it started and how
 * many messages it sent, for the close summary (#284). Removed on close.
 */
const sessionStats = new Map<string, { startedAt: number; messages: number }>();

/** The log context of one inbound SMTP connection (#284). */
function sessionContext(session: { id: string }): LogContext {
  return { smtpSessionId: session.id, listener: "inbound" };
}

/**
 * Verifies an `unsub+<token>@<domain>` recipient (#249): the token must be
 * valid and the domain must be the sender domain of the email it names.
 * `null` for anything else.
 */
async function resolveUnsubscribeRecipient(
  token: string,
  address: string,
): Promise<UnsubscribeTarget | null> {
  const target = await resolveUnsubscribeToken(token);
  const domain = address.split("@")[1]?.trim().toLowerCase();
  return target && domain === target.senderDomain ? target : null;
}

/**
 * Stores a received message and enqueues `email.received` for admin keys'
 * webhooks in one transaction (#184): the row and its event commit
 * together, or neither does. A failure is thrown; the receiver then
 * answers `451`, so the sending MTA delivers the message again later
 * instead of BunMail keeping it without its event.
 */
export async function storeInboundEmail(
  row: typeof inboundEmails.$inferInsert & { id: string },
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await tx.insert(inboundEmails).values(row);
      await enqueueEvent(
        tx,
        "email.received",
        {
          inboundEmailId: row.id,
          from: row.fromAddress,
          to: row.toAddress,
          subject: row.subject ?? null,
        },
        { adminOnly: true },
      );
    });
  } catch (error) {
    logger.error("Inbound email not stored: transaction rolled back", {
      id: row.id,
      error: loggableError(error),
    });
    throw error;
  }
}

/**
 * Builds the error shape `smtp-server` callbacks expect: a standard
 * `Error` carrying the SMTP reply code the library writes back to the
 * client. `Object.assign` widens the type structurally, so call sites
 * don't need an `as Error & { responseCode: number }` cast.
 */
function smtpError(message: string, responseCode: number): Error {
  return Object.assign(new Error(message), { responseCode });
}

/**
 * Starts the receiver. `notifyDeps` are the inbound notification
 * dependencies (mailer, clock, throttle), injectable for tests.
 */
export function start(notifyDeps: InboundNotifyDeps = inboundNotifyDeps()): void {
  const port = config.smtp.port;
  const { spamProtection } = config.smtp;

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
     * Called when a client connects.
     * Runs rate limiting (instant) and DNSBL check (async DNS)
     * to reject bad IPs before they can send any data.
     */
    onConnect(session, callback) {
      runWithLogContext(sessionContext(session), () => {
        sessionStats.set(session.id, { startedAt: performance.now(), messages: 0 });
        const ip = session.remoteAddress;

        /** Layer 2: Per-IP rate limiting (runs first, instant, no I/O) */
        if (spamProtection.rateLimitEnabled && isRateLimited(ip)) {
          logger.warn("SMTP connection rate limited", { ip });
          return callback(smtpError("Too many connections, try again later", 421));
        }

        /** Layer 1: DNSBL check (async DNS lookup) */
        if (!spamProtection.dnsblEnabled) {
          return callback();
        }

        isBlacklistedIp(ip, spamProtection.dnsblZone)
          .then((listed) => {
            if (listed) {
              logger.warn("SMTP connection rejected: IP blacklisted", { ip });
              return callback(
                smtpError("Connection rejected: your IP is blacklisted", 554),
              );
            }
            callback();
          })
          .catch(() => {
            /** DNS lookup failed: allow connection (fail open) */
            callback();
          });
      });
    },

    /**
     * Called for each MAIL FROM command. Performs cheap envelope-level
     * validation only: sender authenticity is enforced via SPF/DKIM
     * later (and via DNSBL in `onConnect`). The empty envelope sender
     * `<>` is explicitly allowed because it's how DSN bounces address
     * themselves per RFC 3464.
     */
    onMailFrom(address, session, callback) {
      runWithLogContext(sessionContext(session), () => {
        const value = address.address;

        /** Empty envelope sender = legitimate DSN bounce; let it through. */
        if (value === "") {
          return callback();
        }

        if (value.length > MAX_ADDRESS_LENGTH || !BASIC_ADDRESS_RE.test(value)) {
          logger.warn("SMTP MAIL FROM rejected: malformed address", {
            address: redactEmail(value),
          });
          return callback(smtpError("Sender address is not a valid email address", 553));
        }

        callback();
      });
    },

    /**
     * Called for each RCPT TO command.
     * Validates that the recipient's domain is registered in BunMail
     * and that the transaction hasn't blown past the per-transaction
     * recipient cap (open-relay defence).
     * Rejects mail to unknown domains with SMTP 550.
     */
    onRcptTo(address, session, callback) {
      runWithLogContext(sessionContext(session), () => {
        /**
         * Cap recipients per transaction. `session.envelope.rcptTo` is the
         * already-accepted list; this hook fires before the new address is
         * appended, so reject when the existing length is at or above the
         * cap. SMTP 452 = "too many recipients" (RFC 5321 §3.5).
         */
        const acceptedSoFar = session.envelope.rcptTo?.length ?? 0;
        if (acceptedSoFar >= MAX_RECIPIENTS_PER_TRANSACTION) {
          logger.warn("SMTP RCPT TO rejected: too many recipients", {
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

        /**
         * Per-recipient unsubscribe mailbox (#249), `unsub+<token>@<domain>`,
         * whatever recipient validation says. The token is checked here: an
         * invalid one is refused in the SMTP session (550), so nothing is
         * stored and no bounce of ours goes to a possibly forged sender (the
         * sending MTA tells its own user). A valid one is accepted and acted
         * on once the message is in (see `onData`).
         */
        const unsubscribeToken = tokenFromUnsubscribeAddress(address.address);
        if (unsubscribeToken !== null) {
          resolveUnsubscribeRecipient(unsubscribeToken, address.address)
            .then((target) => {
              if (target) return callback();
              logger.warn("SMTP RCPT TO rejected: unsubscribe address not valid", {
                domain: address.address.split("@")[1] ?? null,
                ip: session.remoteAddress,
              });
              callback(smtpError("No such recipient", 550));
            })
            .catch((error: unknown) => {
              logger.error("Unsubscribe address check failed during RCPT TO", {
                error: error instanceof Error ? error.message : String(error),
              });
              callback(smtpError("Temporary failure, try again later", 451));
            });
          return;
        }

        /**
         * Signed return path (#236), `b+<id>.<index>.<MAC>@<domain>`,
         * whatever recipient validation says: the `b+` local part is
         * reserved. Accepted only when it verifies against the email it
         * names (MAC, recipient index, sender domain); anything else is
         * refused here (550), so a forged or mistyped address never reaches
         * DATA and nothing is stored. A valid one is acted on in `onData`.
         */
        if (isReturnPathAddress(address.address)) {
          resolveReturnPath(address.address)
            .then((binding) => {
              if (binding) return callback();
              logger.warn("SMTP RCPT TO rejected: return path not valid", {
                domain: address.address.split("@")[1] ?? null,
                ip: session.remoteAddress,
              });
              callback(smtpError("No such recipient", 550));
            })
            .catch((error: unknown) => {
              logger.error("Return path check failed during RCPT TO", {
                error: error instanceof Error ? error.message : String(error),
              });
              callback(smtpError("Temporary failure, try again later", 451));
            });
          return;
        }

        if (!spamProtection.recipientValidationEnabled) {
          return callback();
        }

        const recipientAddress = address.address;
        const domain = recipientAddress.split("@")[1]?.toLowerCase();

        if (!domain) {
          logger.warn("SMTP RCPT TO rejected: invalid address", {
            address: redactEmail(recipientAddress),
          });
          return callback(smtpError("Invalid recipient address", 550));
        }

        domainExistsByName(domain)
          .then((exists) => {
            if (!exists) {
              logger.warn("SMTP RCPT TO rejected: unknown domain", {
                address: redactEmail(recipientAddress),
                domain,
                ip: session.remoteAddress,
              });
              return callback(
                smtpError(`Recipient domain "${domain}" is not handled here`, 550),
              );
            }
            callback();
          })
          .catch((error) => {
            /** DB query failed: allow through (fail open) */
            logger.error("Domain lookup failed during RCPT TO check", {
              error: error instanceof Error ? error.message : String(error),
            });
            callback();
          });
      });
    },

    /**
     * Called for each incoming email.
     * Parses the RFC 822 message, inserts it into `inbound_emails`,
     * and fires an `email.received` webhook event.
     */
    onData(stream, session, callback) {
      runWithLogContext(sessionContext(session), () => {
        const stats = sessionStats.get(session.id);
        if (stats) stats.messages += 1;
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        /**
         * Tracks whether we've already aborted this stream because of the
         * size cap; needed because `data` events keep arriving briefly
         * after we call `stream.unpipe()` / `destroy()`.
         */
        let aborted = false;

        stream.on("data", (chunk: Buffer) => {
          runWithLogContext(sessionContext(session), () => {
            if (aborted) return;
            totalBytes += chunk.length;

            /**
             * Belt-and-suspenders: even though `SMTPServer({ size })` already
             * advertises and enforces the cap at the protocol level, an
             * over-cooperative client can ignore the SIZE extension and just
             * push bytes anyway. Drain the rest, log, and reject with 552.
             */
            if (totalBytes > MAX_MESSAGE_BYTES) {
              aborted = true;
              logger.warn("SMTP DATA rejected: message exceeds size cap", {
                ip: session.remoteAddress,
                totalBytes,
                cap: MAX_MESSAGE_BYTES,
              });
              /** Drop accumulated chunks to free memory before the error. */
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
              try {
                /**
                 * Unsubscribe branch (#249): every `unsub+<token>` recipient
                 * (already verified at RCPT TO, checked again here) is
                 * suppressed. Signed return paths (#236) are collected for
                 * the branch below. Such a message is never stored as inbound
                 * mail and triggers no notification; when it was also
                 * addressed to other mailboxes, only those carry on below.
                 */
                const envelopeRecipients = (session.envelope.rcptTo ?? []).map(
                  (r) => r.address,
                );
                const otherRecipients: string[] = [];
                /** Verified signed return paths this message was sent to (#236). */
                const returnPaths: ReturnPathBinding[] = [];
                for (const recipient of envelopeRecipients) {
                  if (isReturnPathAddress(recipient)) {
                    /** Verified at RCPT TO; checked again here. */
                    const binding = await resolveReturnPath(recipient);
                    if (binding) returnPaths.push(binding);
                    else logger.warn("Return path mail dropped: address not valid");
                    continue;
                  }
                  const token = tokenFromUnsubscribeAddress(recipient);
                  if (token === null) {
                    otherRecipients.push(recipient);
                    continue;
                  }
                  const target = await resolveUnsubscribeRecipient(token, recipient);
                  if (target) await unsubscribe(target, "mailto");
                  else logger.warn("Unsubscribe mail dropped: address not valid");
                }

                const rawBytes = Buffer.concat(chunks);
                const rawMessage = rawBytes.toString("utf-8");
                /** Pure; `null` for anything that is not a DSN, ARF reports included. */
                const bounce = parseBounce(rawMessage);

                /**
                 * Return-path branch (#236). A DSN that arrived at a verified
                 * return path applies to exactly the email and recipient that
                 * address names, whatever its body says. Anything else sent
                 * there (an auto-reply, a vacation notice, a complaint report)
                 * is acknowledged and dropped. Either way, return-path mail is
                 * never stored as inbound mail and never notified.
                 */
                if (returnPaths.length > 0) {
                  for (const binding of returnPaths) {
                    if (bounce) {
                      const result = await handleParsedBounce(bounce, binding);
                      logger.debug("Bounce branch handled inbound message", { result });
                    } else {
                      logger.info(
                        "Return path mail dropped: not a delivery status notification",
                        {
                          emailId: binding.email.id,
                        },
                      );
                    }
                  }
                }

                /** Nothing left for a regular mailbox (#249, #236). */
                if (otherRecipients.length === 0 && envelopeRecipients.length > 0) {
                  callback();
                  return;
                }

                /**
                 * Feedback-loop branch (#191), before the bounce parser: an
                 * ARF complaint report (`multipart/report;
                 * report-type=feedback-report`) suppresses the recipient who
                 * complained and fires `email.complained`, when it links to
                 * an email we sent. Whatever the outcome (linked, dropped,
                 * unparseable), the report is acknowledged, never stored as
                 * inbound mail and never notified: it is machine mail about
                 * our sending, and it can carry a copy of a customer's
                 * message.
                 */
                if (isFeedbackReport(rawMessage)) {
                  const feedback = await handleInboundFeedbackReport(
                    rawMessage,
                    rawBytes,
                  );
                  logger.debug("Feedback branch handled inbound message", {
                    outcome: feedback.outcome,
                    emailId: feedback.emailId,
                  });
                  callback();
                  return;
                }

                /**
                 * MIME parsing gets the raw bytes (#250): decoding them as UTF-8
                 * first corrupted 8-bit parts in other charsets before
                 * mailparser could apply each part's own charset.
                 */
                const parsed = await simpleParser(rawBytes);

                /**
                 * A DSN sent to a regular address, not to a signed return path
                 * (#236). Every bounce of mail BunMail sends goes to that
                 * mail's return path, so this one is unauthenticated: it may
                 * be a late DSN for mail sent before return paths were on, or
                 * a forged one naming a co-recipient. It has no effect, and,
                 * as before, a DSN is never stored as inbound mail (operators
                 * would otherwise get noise from every mistyped address).
                 */
                if (bounce) {
                  /** Already handled above when it also went to a return path. */
                  if (returnPaths.length === 0) {
                    logger.warn("Bounce dropped: not sent to a signed return path", {
                      recipient: redactEmail(bounce.recipient),
                      status: bounce.status,
                      source: bounce.source,
                    });
                  }
                  callback();
                  return;
                }

                /**
                 * DMARC aggregate (rua) report branch (#41). If the message
                 * looks like a DMARC report from a remote receiver, parse the
                 * compressed XML attachment and store as `dmarc_reports` +
                 * `dmarc_records` rows. Skip the regular `inbound_emails`
                 * insert: daily DMARC reports would otherwise pile up in
                 * the inbox view and obscure real customer mail.
                 */
                const attachments = (parsed.attachments ?? []).map((att) => ({
                  filename: att.filename,
                  contentType: att.contentType,
                  content: new Uint8Array(att.content),
                }));
                const dmarcResult = await persistDmarcReportFromInbound(
                  rawMessage,
                  attachments,
                  typeof parsed.text === "string" ? parsed.text : null,
                );
                if (
                  dmarcResult.outcome === "stored" ||
                  dmarcResult.outcome === "duplicate"
                ) {
                  logger.debug("DMARC branch handled inbound message", {
                    outcome: dmarcResult.outcome,
                    reportId: dmarcResult.reportId,
                    recordCount: dmarcResult.recordCount,
                  });
                  callback();
                  return;
                }

                const mailFrom = session.envelope.mailFrom;
                const from =
                  parsed.from?.value?.[0]?.address ??
                  (mailFrom && typeof mailFrom === "object"
                    ? mailFrom.address
                    : undefined) ??
                  "unknown";

                const to = parsed.to
                  ? ((Array.isArray(parsed.to)
                      ? parsed.to[0]?.value?.[0]?.address
                      : parsed.to.value?.[0]?.address) ?? "")
                  : (session.envelope.rcptTo?.[0]?.address ?? "unknown");

                const id = generateId("inb");

                /**
                 * Threading ids (#192), validated, and the email of ours this
                 * replies to, scoped to the envelope recipients' domains
                 * (never the spoofable `To:` header).
                 */
                const threading = await threadingColumnsFor(
                  parsed.headerLines,
                  otherRecipients,
                );

                await storeInboundEmail({
                  id,
                  fromAddress: from,
                  toAddress: to,
                  subject: parsed.subject ?? null,
                  html: typeof parsed.html === "string" ? parsed.html : null,
                  textContent: parsed.text ?? null,
                  rawMessage,
                  ...threading,
                });

                /**
                 * No subject or body: they are message content (#250). The
                 * subject's length is enough to tell messages apart while
                 * investigating.
                 */
                logger.info("Inbound email received and stored", {
                  id,
                  from: redactEmail(from),
                  to: redactEmail(to),
                  bytes: rawBytes.length,
                });
                logger.debug("Inbound email subject", {
                  id,
                  subjectLength: parsed.subject?.length ?? 0,
                });

                /**
                 * Send the per-domain inbound notification (#106), fire-and-forget.
                 * Sits after the feedback/bounce/DMARC early-returns, so ARF
                 * reports, DSNs and DMARC reports never trigger it. NOT
                 * awaited: a slow notification
                 * (DNS/MX resolution) must never delay the SMTP ack below, which
                 * would risk the upstream MTA timing out and redelivering.
                 *
                 * Domain resolution keys off the **envelope** RCPT TO (the
                 * addresses actually validated + accepted in `onRcptTo`), not the
                 * spoofable `To:` header, so BCC / list mail still notifies the
                 * domain it was received for, and a forged header can't steer
                 * the signing identity. `notifyInboundReceived` never throws; the
                 * `.catch` is a redundant belt.
                 */
                if (config.inboundNotify.enabled) {
                  void notifyInboundReceived(
                    {
                      inboundId: id,
                      from,
                      /** Without the unsubscribe addresses handled above (#249). */
                      recipients: otherRecipients,
                      subject: parsed.subject ?? null,
                      text: parsed.text ?? null,
                      /** For the automatic-mail check (#250). */
                      headerLines: parsed.headerLines,
                      returnPath:
                        mailFrom && typeof mailFrom === "object" ? mailFrom.address : "",
                      sizeBytes: rawBytes.length,
                    },
                    notifyDeps,
                  ).catch((err) => {
                    logger.error("Inbound notification dispatch failed", {
                      id,
                      error: err instanceof Error ? err.message : String(err),
                    });
                  });
                }

                callback();
              } catch (error) {
                logger.error("Failed to process inbound email", {
                  error: error instanceof Error ? error.message : String(error),
                });
                callback(smtpError("Failed to process message", 451));
              }
            })();
          });
        });
      });
    },
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

  /** Periodic cleanup of expired rate limit entries (every 5 minutes) */
  cleanupInterval = setInterval(
    () => {
      const now = Date.now();
      const windowMs = spamProtection.rateLimitWindowSec * 1000;
      for (const [ip, entry] of rateLimitMap) {
        if (now - entry.windowStart >= windowMs) {
          rateLimitMap.delete(ip);
        }
      }
      /** Same sweep for the inbound notification budget (#250). */
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
