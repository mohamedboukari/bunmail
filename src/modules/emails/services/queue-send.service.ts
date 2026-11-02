import { randomBytes } from "crypto";
import { sql } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import type { DeliveryState, DeliveryGroup } from "../models/email.schema.ts";
import type { sendMail, DkimOptions, OutboundAttachment } from "./mailer.service.ts";
import { attachmentStorage } from "./attachment-storage.ts";
import { listUnsubscribeOptions, oneClickBlocker } from "./list-unsubscribe.ts";
import { isEmailCategory } from "../types/email.types.ts";
import { logger } from "../../../utils/logger.ts";
import { loggableError } from "../../../utils/db-error.ts";
import { redactEmail } from "../../../utils/redact.ts";
import { config } from "../../../config.ts";
import { nextRetryDelayMs } from "./retry-schedule.ts";
import { splitToList } from "./recipient-limits.ts";
import { findById as findApiKeyById } from "../../api-keys/services/api-key.service.ts";
import { isSuppressed } from "../../suppressions/services/suppression.service.ts";
import { signedReturnPathEnabled } from "../../bounces/services/return-path-mx.ts";
import { emailsFinished } from "../../metrics/services/metrics.service.ts";
import {
  queryDomainById,
  queryDomainByName,
  resolveDomainForEmail,
} from "./queue-domain.service.ts";
import { releaseRow, type Claim, type ClaimedEmail } from "./queue-claim.service.ts";
import { retryMaxAgeMs, type SentAttempt } from "./queue-decision.service.ts";
import {
  metricSource,
  recordSendOutcome,
  releaseRowWithEvents,
} from "./queue-outcome.service.ts";

/** The mailer, injectable so tests can drive the queue without SMTP. */
export interface QueueDeps {
  sendMail: typeof sendMail;
  /**
   * Whether an email from this address gets signed return paths (#236):
   * inbound SMTP on and the sender domain's MX pointing here. Injectable so
   * tests need no DNS; defaults to {@link signedReturnPathEnabled}.
   */
  signedReturnPath?: (fromAddress: string) => Promise<boolean>;
}

/** Sends one claimed email and records the outcome (see {@link runQueueCycle}). */
export async function sendClaimedEmail(
  email: ClaimedEmail,
  claim: Claim,
  deps: QueueDeps,
): Promise<void> {
  const emailId = email.id;
  /**
   * The row arrives already in `sending` state with `attempts` incremented:
   * `claimNextEmails` did both atomically (#20). So `email.attempts` is
   * the count for *this* attempt, not the previous one.
   */
  const attempt = email.attempts;

  /** The first `to` address and the count only, never the list (#178). */
  const toList = splitToList(email.toAddress);
  logger.info("Processing email", {
    emailId,
    attempt,
    to: redactEmail(toList[0]),
    toCount: toList.length,
  });

  /**
   * Retries can run for up to `MAIL_RETRY_MAX_AGE_HOURS` after the send
   * was accepted, so check that the sending key is still active: a key
   * revoked in the meantime (#239) must not keep sending.
   */
  const key = await findApiKeyById(email.apiKeyId);
  if (!key?.isActive) {
    /** A final status: the attachment bytes are dropped with it (#181). */
    await db.transaction((tx) =>
      releaseRow(
        claim,
        { status: "failed", lastError: "API key revoked before delivery" },
        tx,
      ),
    );
    logger.warn("Email not sent: API key revoked", { emailId, apiKeyId: email.apiKeyId });
    return;
  }

  /** Set once the mailer has run; the outcome is recorded after the try. */
  let sent: SentAttempt;
  try {
    /**
     * Look up DKIM keys + unsubscribe overrides for the sender's domain.
     * Both fall back gracefully.
     */
    const domain = await resolveDomainForEmail(email, {
      byId: queryDomainById,
      byName: queryDomainByName,
    });

    /**
     * A stored key that does not decrypt (#244): in production, never send
     * unsigned. Hold the email on the normal retry backoff, so fixing
     * `DKIM_ENCRYPTION_KEY` within the retry window still delivers it.
     */
    if (domain?.dkimKeyUnreadable && config.env === "production") {
      await holdForUnreadableDkimKey(email, claim, domain.name);
      return;
    }
    if (domain?.dkimKeyUnreadable) {
      logger.warn("DKIM key unreadable: sending unsigned (development only)", {
        emailId,
        domain: domain.name,
      });
    }

    let dkim: DkimOptions | undefined;

    if (domain?.dkimPrivateKey) {
      dkim = {
        domainName: domain.name,
        keySelector: domain.dkimSelector,
        privateKey: domain.dkimPrivateKey,
      };
      logger.debug("DKIM signing enabled", {
        domain: domain.name,
        selector: domain.dkimSelector,
      });
    }

    /**
     * `List-Unsubscribe` (#249): a per-recipient one-click link (and
     * `unsub+<token>` mailto) when the email names one recipient and
     * `APP_BASE_URL` is HTTPS, else the domain's static settings. Rebuilt
     * on every attempt; the token is deterministic, so retries match.
     */
    const category = isEmailCategory(email.category) ? email.category : null;
    const unsubscribe =
      category === "transactional" ? undefined : listUnsubscribeOptions(email, domain);
    /**
     * Marketing mail was accepted because it could carry the one-click link
     * (#250). If it no longer can, `APP_BASE_URL` changed since: the email
     * goes out with the static header rather than being held, and the
     * operator sees this line.
     */
    if (category === "marketing" && oneClickBlocker(email) !== null) {
      logger.warn("Marketing email sent without a one-click unsubscribe link", {
        emailId,
        apiKeyId: email.apiKeyId,
      });
    }

    /**
     * Canonical Message-ID: locked in on first attempt, reused on
     * retries. Stable identifier is what bounce / complaint feedback
     * loops join on: minting a new one per attempt would break
     * correlation entirely. (#97)
     */
    const messageId =
      email.messageId ?? `<${randomBytes(16).toString("hex")}@${config.mail.hostname}>`;

    /**
     * Retry passes re-check the suppression list (#262): a recipient
     * suppressed since the email was accepted (a bounce or complaint from
     * another email, an unsubscribe, a manual entry) is not sent to.
     */
    const existingState = email.deliveryState
      ? await dropSuppressedRecipients(email.deliveryState, email.apiKeyId, emailId)
      : email.deliveryState;
    /** Capture pre-attempt status per group so we can detect
     *  transitions (retry → failed via hard 5xx) for bounce webhooks. */
    const priorStatuses = new Map<string, DeliveryGroup["status"]>();
    if (existingState) {
      for (const [mx, g] of Object.entries(existingState)) {
        priorStatuses.set(mx, g.status);
      }
    }

    /**
     * Signed per-recipient return paths (#236): only with inbound SMTP on
     * (the only setup where a DSN can reach BunMail) and when the sender
     * domain's MX points at this server, so its DSNs actually arrive here.
     * Other domains keep the From address as envelope sender. Decided once
     * per attempt, for every recipient; never throws (a DNS error answers
     * no).
     */
    const signReturnPath = await (deps.signedReturnPath ?? signedReturnPathEnabled)(
      email.fromAddress,
    );

    /**
     * Attachments (#181), loaded for this attempt only: the claim never
     * reads them. Their bytes are kept until the email reaches a final
     * state, so a missing one means a broken row; it is refused (the
     * catch below marks the email failed) rather than sent without it.
     */
    const attachments = await loadOutboundAttachments(emailId);

    const result = await deps.sendMail({
      from: email.fromAddress,
      /** Display name (#250): `From:` header only. */
      fromName: email.fromName,
      to: email.toAddress,
      cc: email.cc,
      bcc: email.bcc,
      replyTo: email.replyTo,
      subject: email.subject,
      html: email.html,
      text: email.textContent,
      messageId,
      /** Custom headers (#177): the stored set, the same on every retry. */
      headers: email.headers,
      /** Attachments (#181): the same on every transaction and retry. */
      attachments,
      existingState,
      dkim,
      unsubscribe,
      /** `transactional`: no `List-Unsubscribe` (#250). */
      category,
      /** Feedback-ID (#250): how the mail entered BunMail, and for which key. */
      feedback: {
        source: email.source === "smtp" ? "smtp" : "api",
        apiKeyId: email.apiKeyId,
      },
      returnPath: signReturnPath ? { emailId } : undefined,
    });
    sent = {
      deliveryState: result.deliveryState,
      messageId,
      priorStatuses,
      deferred: result.deferred,
    };
  } catch (error) {
    /**
     * `sendMail` only throws for fundamental input errors now (no
     * valid recipients after parsing): never for transport / SMTP
     * failures, which return as `failed`/`retry` groups in state.
     * So this catch is a one-shot terminal: mark `failed`, no retry.
     * The status and `email.failed` commit together (#184).
     */
    const errorMessage = error instanceof Error ? error.message : String(error);
    await db.transaction((tx) =>
      releaseRowWithEvents(
        tx,
        email,
        claim,
        { status: "failed", lastError: errorMessage },
        [
          {
            event: "email.failed",
            data: {
              emailId,
              from: email.fromAddress,
              to: email.toAddress,
              subject: email.subject,
              tags: email.tags,
              error: errorMessage,
            },
          },
        ],
      ),
    );
    logger.error("Email permanently failed (input error)", {
      emailId,
      attempt,
      error: errorMessage,
    });
    emailsFinished.inc({ status: "failed", source: metricSource(email) });
    return;
  }

  /**
   * The send happened. Its outcome (inline bounce suppressions, the row's
   * status, and every webhook event they raise) is one transaction (#184),
   * with no network call inside, retried and then saved without its events
   * (see {@link recordSendOutcome}), so a webhook problem never sends the
   * mail twice. Only when even the status cannot be saved (the database is
   * unavailable) does the row stay `sending` under this claim's lease, to
   * be claimed and sent again once the lease expires: at-least-once, as
   * when the status update failed before the outbox.
   */
  try {
    await recordSendOutcome(email, claim, sent);
  } catch (error) {
    logger.error(
      "Email outcome not saved: transaction rolled back, retried after the lease",
      {
        emailId,
        attempt,
        error: loggableError(error),
      },
    );
  }
}

/**
 * An email's attachments with their bytes, for the mailer (#181). Throws
 * when one has lost its bytes while the email is still being sent, which
 * only a broken row can cause: the send must not go out without it.
 */
async function loadOutboundAttachments(emailId: string): Promise<OutboundAttachment[]> {
  const loaded = await attachmentStorage.loadAttachments(db, emailId);
  const outbound: OutboundAttachment[] = [];
  for (const attachment of loaded) {
    if (attachment.content === null) {
      logger.error("Attachment bytes missing on an email being sent", {
        emailId,
        position: attachment.position,
      });
      throw new Error(`Attachment ${attachment.position} is no longer stored`);
    }
    outbound.push({
      filename: attachment.filename,
      contentType: attachment.contentType,
      contentId: attachment.contentId,
      content: attachment.content,
    });
  }
  return outbound;
}

/** `last_error` of a group whose every recipient was suppressed before a retry (#262). */
const SUPPRESSED_BEFORE_RETRY = "All recipients were suppressed before this retry";

/**
 * Removes recipients suppressed since the email was accepted from every
 * group still in `retry` (#262). A group left with nobody becomes
 * `failed` (keeping its recipients for the record), so the row reaches
 * its terminal state without sending; other groups and other recipients
 * are untouched. Logs counts only, never addresses.
 */
async function dropSuppressedRecipients(
  state: DeliveryState,
  apiKeyId: string,
  emailId: string,
): Promise<DeliveryState> {
  const next: DeliveryState = { ...state };
  let dropped = 0;
  for (const [mxHost, group] of Object.entries(state)) {
    if (group.status !== "retry") continue;
    const kept: string[] = [];
    for (const recipient of group.recipients) {
      if (await isSuppressed(apiKeyId, recipient)) dropped += 1;
      else kept.push(recipient);
    }
    if (kept.length === group.recipients.length) continue;
    next[mxHost] =
      kept.length === 0
        ? {
            ...group,
            status: "failed",
            lastError: SUPPRESSED_BEFORE_RETRY,
            updatedAt: new Date().toISOString(),
          }
        : { ...group, recipients: kept };
  }
  if (dropped > 0) {
    logger.info("Suppressed recipients dropped before retry", { emailId, dropped });
  }
  return next;
}

/**
 * Holds an email whose sender domain has a DKIM key that does not decrypt
 * (#244, production only): back to `queued` on the retry backoff (#180),
 * or `failed` with `email.failed` once the email is too old to retry.
 * Nothing is sent, so no delivery state changes.
 */
async function holdForUnreadableDkimKey(
  email: ClaimedEmail,
  claim: Claim,
  domainName: string,
): Promise<void> {
  const lastError = `DKIM key for ${domainName} cannot be decrypted with DKIM_ENCRYPTION_KEY: not sent unsigned`;
  const retryDelayMs = nextRetryDelayMs(claim.attempt, email.ageMs, retryMaxAgeMs());
  if (retryDelayMs !== null) {
    const retrySeconds = Math.round(retryDelayMs / 1000);
    await releaseRow(
      claim,
      {
        status: "queued",
        nextAttemptAt: sql`NOW() + interval ${sql.raw(`'${retrySeconds} seconds'`)}`,
        lastError,
      },
      db,
    );
    logger.error("Email held: DKIM key unreadable", {
      emailId: email.id,
      domain: domainName,
      attempt: claim.attempt,
      retryInSeconds: retrySeconds,
    });
    return;
  }
  /** The status and `email.failed` commit together (#184). */
  await db.transaction((tx) =>
    releaseRowWithEvents(tx, email, claim, { status: "failed", lastError }, [
      {
        event: "email.failed",
        data: {
          emailId: email.id,
          from: email.fromAddress,
          to: email.toAddress,
          subject: email.subject,
          tags: email.tags,
          error: lastError,
        },
      },
    ]),
  );
  logger.error("Email failed: DKIM key unreadable for the whole retry window", {
    emailId: email.id,
    domain: domainName,
    attempt: claim.attempt,
  });
}
