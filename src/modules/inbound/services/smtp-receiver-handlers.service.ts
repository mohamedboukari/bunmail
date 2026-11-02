import type { SMTPServerOptions } from "smtp-server";
import type { config } from "../../../config.ts";
import { domainExistsByName } from "../../domains/services/domain.service.ts";
import { isBlacklistedIp } from "./dnsbl.service.ts";
import { takeInboundConnection } from "./connection-limit.ts";
import { resolveReturnPath } from "../../bounces/services/bounce-handler.service.ts";
import { isReturnPathAddress } from "../../bounces/services/return-path.ts";
import { MAX_ADDRESS_LENGTH } from "../../../utils/recipients.ts";
import { logger } from "../../../utils/logger.ts";
import { loggableError } from "../../../utils/db-error.ts";
import { sharedStoreErrorCode } from "../../../utils/shared-store.ts";
import { redactEmail } from "../../../utils/redact.ts";
import { tokenFromUnsubscribeAddress } from "../../suppressions/services/unsubscribe-token.ts";
import {
  resolveUnsubscribeToken,
  type UnsubscribeTarget,
} from "../../suppressions/services/unsubscribe.service.ts";
import { recordSmtpConnection } from "../../metrics/services/metrics.service.ts";
import {
  inSession,
  sessionSpans,
  sessionStats,
  smtpError,
} from "./smtp-receiver-session.service.ts";

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

/**
 * Verifies an `unsub+<token>@<domain>` recipient (#249): the token must be
 * valid and the domain must be the sender domain of the email it names.
 * `null` for anything else.
 */
export async function resolveUnsubscribeRecipient(
  token: string,
  address: string,
): Promise<UnsubscribeTarget | null> {
  const target = await resolveUnsubscribeToken(token);
  const domain = address.split("@")[1]?.trim().toLowerCase();
  return target && domain === target.senderDomain ? target : null;
}

/**
 * The connection, MAIL FROM and RCPT TO handlers of the inbound receiver,
 * for `start()` to spread into its `SMTPServer` options. `spamProtection`
 * is the one `start()` read from the config.
 */
export function receiverSessionHandlers({
  spamProtection,
}: {
  spamProtection: typeof config.smtp.spamProtection;
}): Pick<SMTPServerOptions, "onClose" | "onConnect" | "onMailFrom" | "onRcptTo"> {
  return {
    /**
     * One summary line per connection when it closes (#284): who, how many
     * messages, how long. Runs in the session's log context.
     */
    onClose(session) {
      const stats = sessionStats.get(session.id);
      sessionStats.delete(session.id);
      inSession(session, () => {
        logger.info("SMTP session closed", {
          remoteAddress: session.remoteAddress,
          messages: stats?.messages ?? 0,
          durationMs:
            stats === undefined ? null : Math.round(performance.now() - stats.startedAt),
        });
      });
      sessionSpans.close(session.id, stats?.messages ?? 0);
    },

    /**
     * Called when a client connects.
     * Runs rate limiting (memory, or one Redis round trip) and the DNSBL
     * check (async DNS) to reject bad IPs before they can send any data.
     */
    onConnect(session, callback) {
      sessionSpans.open(session.id);
      inSession(session, () => {
        sessionStats.set(session.id, { startedAt: performance.now(), messages: 0 });
        recordSmtpConnection("inbound");
        const ip = session.remoteAddress;

        /** Layer 1: DNSBL check (async DNS lookup) */
        const checkDnsbl = (): void => {
          if (!spamProtection.dnsblEnabled) return callback();
          isBlacklistedIp(ip, spamProtection.dnsblZone)
            .then((listed) => {
              if (listed) {
                logger.warn("SMTP connection rejected: IP blacklisted", { ip });
                return callback(
                  smtpError("Connection rejected: your IP is blacklisted", 554, "dnsbl"),
                );
              }
              callback();
            })
            .catch(() => {
              /** DNS lookup failed: allow connection (fail open) */
              callback();
            });
        };

        /** Layer 2: Per-IP rate limiting (runs first, before any DNS) */
        if (!spamProtection.rateLimitEnabled) return checkDnsbl();
        takeInboundConnection(
          ip,
          spamProtection.rateLimitMax,
          spamProtection.rateLimitWindowSec,
        )
          .then(
            (limited) => {
              if (!limited) return checkDnsbl();
              logger.warn("SMTP connection rate limited", { ip });
              callback(
                smtpError("Too many connections, try again later", 421, "rate_limited"),
              );
            },
            (error: unknown) => {
              /**
               * Unexpected: the store falls back to memory on a Redis error.
               * Fail open like the DNSBL layer: inbound mail keeps arriving.
               */
              logger.error("SMTP connection limit failed: connection allowed", {
                ip,
                code: sharedStoreErrorCode(error),
              });
              checkDnsbl();
            },
          )
          /**
           * A throw inside a handler above (the reply already went out, or
           * never will): logged only, no second reply, and never an
           * unhandled rejection, which would end the process.
           */
          .catch((error: unknown) => {
            logger.error("SMTP connect handler failed", {
              ip,
              error: loggableError(error),
            });
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
      inSession(session, () => {
        const value = address.address;

        /** Empty envelope sender = legitimate DSN bounce; let it through. */
        if (value === "") {
          return callback();
        }

        if (value.length > MAX_ADDRESS_LENGTH || !BASIC_ADDRESS_RE.test(value)) {
          logger.warn("SMTP MAIL FROM rejected: malformed address", {
            address: redactEmail(value),
          });
          return callback(
            smtpError(
              "Sender address is not a valid email address",
              553,
              "sender_invalid",
            ),
          );
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
      inSession(session, () => {
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
              "too_many_recipients",
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
              callback(smtpError("No such recipient", 550, "recipient_unknown"));
            })
            .catch((error: unknown) => {
              logger.error("Unsubscribe address check failed during RCPT TO", {
                error: error instanceof Error ? error.message : String(error),
              });
              callback(smtpError("Temporary failure, try again later", 451, "temporary"));
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
              callback(smtpError("No such recipient", 550, "recipient_unknown"));
            })
            .catch((error: unknown) => {
              logger.error("Return path check failed during RCPT TO", {
                error: error instanceof Error ? error.message : String(error),
              });
              callback(smtpError("Temporary failure, try again later", 451, "temporary"));
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
          return callback(
            smtpError("Invalid recipient address", 550, "recipient_invalid"),
          );
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
                smtpError(
                  `Recipient domain "${domain}" is not handled here`,
                  550,
                  "domain_unknown",
                ),
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
  };
}
