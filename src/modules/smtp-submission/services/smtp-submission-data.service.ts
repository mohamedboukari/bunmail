import type {
  SMTPServerOptions,
  SMTPServerDataStream,
  SMTPServerSession,
} from "smtp-server";
import { simpleParser } from "mailparser";
import type { AddressObject } from "mailparser";
import { config } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";
import { redactEmail } from "../../../utils/redact.ts";
import { createEmail } from "../../emails/services/email.service.ts";
import { splitToList } from "../../emails/services/recipient-limits.ts";
import { MAX_ADDRESS_LENGTH } from "../../../utils/recipients.ts";
import { SuppressedRecipientError } from "../../suppressions/errors.ts";
import { AttachmentsTooLargeError, EmailSendRejectedError } from "../../emails/errors.ts";
import { InactiveApiKeyError, UnauthorizedSenderError } from "../../api-keys/errors.ts";
import type { SendEmailInput } from "../../emails/types/email.types.ts";
import {
  buildSubmissionInput,
  submissionAttachments,
  selectRelayHeaders,
  submissionCategory,
  submissionTags,
  submissionFromName,
} from "../message-mapper.ts";
import { SubmissionRejectedError } from "../errors.ts";
import { recordOutcome, releaseReservation, reserveAccepted } from "./usage.service.ts";
import { recordSmtpMessageAccepted } from "../../metrics/services/metrics.service.ts";
import {
  inSession,
  sessionSpans,
  sessionStats,
  smtpError,
} from "./smtp-submission-session.service.ts";

/**
 * Dropped custom headers named in one log line (#177); `droppedCount`
 * still has the total. A client adding hundreds of `X-` headers must not
 * produce a huge log line.
 */
const MAX_LOGGED_DROPPED_HEADERS = 20;

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
 * The DATA handler of the submission server, for `start()` to spread into
 * its `SMTPServer` options. `maxMessageBytes` is the size cap `start()`
 * advertises.
 */
export function submissionDataHandler({
  maxMessageBytes,
}: {
  maxMessageBytes: number;
}): Pick<SMTPServerOptions, "onData"> {
  return {
    /**
     * Parse the submitted message and enqueue it via the outbound
     * pipeline, attributed to the authenticated API key.
     */
    onData(
      stream: SMTPServerDataStream,
      session: SMTPServerSession,
      smtpCallback: (err?: Error) => void,
    ) {
      /** Ends the message's trace span (#363) with the reply, then replies. */
      const callback = sessionSpans.message(
        session.id,
        session.envelope.rcptTo?.length ?? 0,
        smtpCallback,
      );
      inSession(session, () => {
        const stats = sessionStats.get(session.id);
        if (stats) stats.messages += 1;
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        let aborted = false;

        stream.on("data", (chunk: Buffer) => {
          inSession(session, () => {
            if (aborted) return;
            totalBytes += chunk.length;
            if (totalBytes > maxMessageBytes) {
              aborted = true;
              logger.warn("SMTP submission DATA rejected: message exceeds size cap", {
                ip: session.remoteAddress,
                totalBytes,
                cap: maxMessageBytes,
              });
              chunks.length = 0;
              stream.unpipe();
              stream.resume();
              callback(smtpError("Message size exceeds limit", 552, "too_large"));
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

              /** onAuth stashed the API key id here; guard defensively. */
              const apiKeyId = session.user;
              if (!apiKeyId) {
                logger.error("SMTP submission DATA without an authenticated session");
                callback(smtpError("Authentication required", 530, "auth_required"));
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
                        "quota",
                      ),
                    );
                    return;
                  }
                }

                /**
                 * Raw bytes, not a UTF-8 string: each part keeps its charset
                 * (#250). `keepCidLinks`: the HTML's `cid:` references stay as
                 * they are (#181), pointing at the inline parts relayed with
                 * their Content-ID, instead of being inlined as data URLs.
                 */
                const parsed = await simpleParser(Buffer.concat(chunks), {
                  keepCidLinks: true,
                }).catch((parseError: unknown) => {
                  logger.warn("SMTP submission message did not parse", {
                    apiKeyId,
                    error:
                      parseError instanceof Error ? parseError.name : typeof parseError,
                  });
                  throw new SubmissionRejectedError("Message could not be parsed");
                });

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
                 * `X-BunMail-Tag: key=value` (#189): consumed here, never
                 * relayed; an invalid tag or more than 10 is refused (550).
                 */
                const tags = submissionTags(parsed.headerLines);

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
                  tags,
                  attachments: submissionAttachments(parsed.attachments),
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

                /** The first `to` address and the count, never the list (#178). */
                const toList = splitToList(email.toAddress);
                logger.info("SMTP submission accepted: email queued", {
                  id: email.id,
                  apiKeyId,
                  from: redactEmail(input.from),
                  to: redactEmail(toList[0]),
                  toCount: toList.length,
                });

                recordSmtpMessageAccepted("submission");
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
                  callback(smtpError(error.message, 550, "suppressed"));
                  return;
                }
                /**
                 * Sender domain not registered or not DKIM-verified, missing
                 * subject (#245): permanent, the client must fix its config.
                 */
                if (error instanceof EmailSendRejectedError) {
                  logger.warn("SMTP submission rejected", { apiKeyId, code: error.code });
                  /** Attachments over the size budget (#181): 552, exceeded storage allocation. */
                  callback(
                    smtpError(
                      error.message,
                      error instanceof AttachmentsTooLargeError ? 552 : 550,
                      error instanceof AttachmentsTooLargeError
                        ? "too_large"
                        : "rejected",
                    ),
                  );
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
                  callback(
                    smtpError(
                      error.message,
                      550,
                      error instanceof UnauthorizedSenderError
                        ? "sender_not_allowed"
                        : "rejected",
                    ),
                  );
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
                callback(
                  smtpError(
                    "Local error in processing, try again later",
                    451,
                    "temporary",
                  ),
                );
              }
            })();
          });
        });
      });
    },
  };
}
