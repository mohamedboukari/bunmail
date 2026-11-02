import type { SMTPServerOptions } from "smtp-server";
import { simpleParser } from "mailparser";
import { storeInboundEmail } from "./smtp-receiver-store.service.ts";
import { generateId } from "../../../utils/id.ts";
import { resolveUnsubscribeRecipient } from "./smtp-receiver-handlers.service.ts";
import {
  notifyInboundReceived,
  type InboundNotifyDeps,
} from "./inbound-notify.service.ts";
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
import { logger } from "../../../utils/logger.ts";
import { redactEmail } from "../../../utils/redact.ts";
import { tokenFromUnsubscribeAddress } from "../../suppressions/services/unsubscribe-token.ts";
import { unsubscribe } from "../../suppressions/services/unsubscribe.service.ts";
import { recordSmtpMessageAccepted } from "../../metrics/services/metrics.service.ts";
import {
  inSession,
  sessionSpans,
  sessionStats,
  smtpError,
} from "./smtp-receiver-session.service.ts";

/**
 * Maximum size (bytes) of any single inbound message: RFC 5321 SIZE
 * extension value advertised on connect, and the upper bound enforced
 * inside `onData`. 10 MB matches typical receiving-MTA defaults.
 */
export const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

/**
 * The DATA handler of the inbound receiver, for `start()` to spread into its
 * `SMTPServer` options. `notifyDeps` are the ones `start()` was given.
 */
export function receiverDataHandler({
  notifyDeps,
}: {
  notifyDeps: InboundNotifyDeps;
}): Pick<SMTPServerOptions, "onData"> {
  return {
    /**
     * Called for each incoming email.
     * Parses the RFC 822 message, inserts it into `inbound_emails`,
     * and fires an `email.received` webhook event.
     */
    onData(stream, session, callback) {
      /** The message's trace span (#363), ended with the reply it gets. */
      const reply = sessionSpans.message(
        session.id,
        session.envelope.rcptTo?.length ?? 0,
        callback,
      );
      /** Every outcome goes through here; a success counts as an accepted message (#362). */
      const done = (error?: Error | null): void => {
        if (!error) recordSmtpMessageAccepted("inbound");
        reply(error);
      };
      inSession(session, () => {
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
          inSession(session, () => {
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
              done(smtpError("Message size exceeds limit", 552, "too_large"));
              return;
            }

            chunks.push(chunk);
          });
        });

        stream.on("end", () => {
          inSession(session, () => {
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
                  done();
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
                  done();
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
                  done();
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
                  done();
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

                done();
              } catch (error) {
                logger.error("Failed to process inbound email", {
                  error: error instanceof Error ? error.message : String(error),
                });
                done(smtpError("Failed to process message", 451, "temporary"));
              }
            })();
          });
        });
      });
    },
  };
}
