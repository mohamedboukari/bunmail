import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { db, type Tx } from "../../../db/index.ts";
import type { emails } from "../models/email.schema.ts";
import type { DeliveryState } from "../models/email.schema.ts";
import { enqueueEvent } from "../../webhooks/services/webhook-dispatch.service.ts";
import {
  addFromBounce,
  SOFT_BOUNCE_WINDOW_MS,
} from "../../suppressions/services/suppression.service.ts";
import { logger } from "../../../utils/logger.ts";
import { loggableError, sqlStateOf } from "../../../utils/db-error.ts";
import { redactEmail } from "../../../utils/redact.ts";
import { emailsFinished } from "../../metrics/services/metrics.service.ts";
import { releaseRow, type Claim, type ClaimedEmail } from "./queue-claim.service.ts";
import {
  decideRowOutcome,
  failureOf,
  type OutcomeEvent,
  type SentAttempt,
} from "./queue-decision.service.ts";

/** The `source` label of an email's metrics (#362). */
export function metricSource(email: ClaimedEmail): "api" | "smtp" {
  return email.source === "smtp" ? "smtp" : "api";
}

/** A recipient's inline bounce, suppressed and announced with the outcome. */
interface InlineBounce {
  recipient: string;
  /** `hard`: a 5xx, permanent. `soft`: a full mailbox that never cleared (#250), 24 h. */
  bounceType: "hard" | "soft";
  /** The enhanced status code, e.g. `5.1.1` or `4.2.2`. */
  code: string;
  diagnostic: string;
}

/**
 * The enhanced status code of a full mailbox (RFC 3463 `X.2.2`). The only
 * temporary failure that says something about the recipient's mailbox and
 * is worth a suppression once it outlasts the retry window: `4.2.0` and
 * the other 4xx codes are too vague, and `4.7.x` is about the sender.
 */
const MAILBOX_FULL = "4.2.2";

/**
 * The soft bounces an exhausted retry window leads to (#250): every
 * recipient of an entry that was still `retry` after this attempt and is
 * `failed` in the terminal state (its temporary failures outlasted
 * `MAIL_RETRY_MAX_AGE_HOURS`), when that entry's LAST failure was a
 * `4.2.2` SMTP reply. Pure.
 *
 * Only the classification the mailer stored from the SMTP reply counts:
 * a failure with no reply (DNS, network, TLS, MTA-STS) carries none, so it
 * never suppresses, and `lastError` is never parsed for it. Entries that
 * were already `failed` before (a hard bounce, or every recipient
 * suppressed before this retry) are not touched.
 *
 * Exported for unit tests.
 */
export function exhaustedSoftBounces(
  attemptState: DeliveryState,
  finalState: DeliveryState,
): InlineBounce[] {
  const bounces: InlineBounce[] = [];
  for (const [key, group] of Object.entries(attemptState)) {
    if (group.status !== "retry") continue;
    if (finalState[key]?.status !== "failed") continue;
    if (group.failureKind !== "soft" || group.failureCode !== MAILBOX_FULL) continue;
    for (const recipient of group.recipients) {
      bounces.push({
        recipient,
        bounceType: "soft",
        code: MAILBOX_FULL,
        diagnostic: group.lastError ?? "(no diagnostic)",
      });
    }
  }
  return bounces;
}

/**
 * Waits before each retry of a failed outcome transaction (#184): two
 * retries, 100 ms then 500 ms, enough to ride out a deadlock or a
 * serialization failure without holding a send slot for long.
 */
const OUTCOME_RETRY_DELAYS_MS = [100, 500] as const;

/**
 * Records the outcome of an attempt that reached `sendMail` (#184).
 *
 * 1. One transaction: the inline bounce suppressions (hard 5xx, and a
 *    `4.2.2` that outlasted the retry window, #250) with their
 *    `email.bounced` events, then the row's status with `email.sent` /
 *    `email.failed`. Retried twice on failure ({@link OUTCOME_RETRY_DELAYS_MS}).
 * 2. Still failing: a degraded transaction saves the status and the
 *    suppressions WITHOUT the webhook events, logged at `error` as
 *    `Webhook events not recorded for a sent email`. The mail went out, so
 *    a webhook problem (a bug, an oversized payload, a constraint) must not
 *    leave the row to its lease and send it again on every lease, forever:
 *    those events are lost instead.
 * 3. The degraded write failing too (the database is unavailable) is
 *    thrown; the caller leaves the row to its lease (at-least-once).
 *
 * Log lines are written after the commit, so they only report what was
 * stored.
 */
export async function recordSendOutcome(
  email: ClaimedEmail,
  claim: Claim,
  sent: SentAttempt,
): Promise<void> {
  const emailId = email.id;
  const attempt = email.attempts;
  const { deliveryState, messageId, priorStatuses } = sent;

  /**
   * `email.bounced` + auto-suppress for groups that **newly transitioned
   * to `failed`** this attempt via a hard 5xx. Skip groups that were
   * already `failed` before this attempt (we'd already fired for them on
   * the earlier pass) and skip groups still in `retry` (no terminal
   * outcome yet).
   */
  const bounces: InlineBounce[] = [];
  for (const [mxHost, group] of Object.entries(deliveryState)) {
    if (group.status !== "failed") continue;
    if (priorStatuses.get(mxHost) === "failed") continue; /** Already handled. */
    const parsed = failureOf(group);
    if (parsed?.kind !== "hard")
      continue; /** Synthetic DNS failures + transient exhaust handled separately. */
    for (const recipient of group.recipients) {
      bounces.push({
        recipient,
        bounceType: "hard",
        code: parsed.code,
        diagnostic: group.lastError ?? "(no diagnostic)",
      });
    }
  }

  const outcome = decideRowOutcome(email, sent);

  /**
   * A full mailbox that stayed full for the whole retry window (#250): a
   * 24-hour soft-bounce suppression and a soft `email.bounced` per
   * recipient, in the same transaction as the hard ones. Every other
   * temporary failure ends `failed` with neither, as before.
   */
  if (outcome.kind === "terminal") {
    bounces.push(...exhaustedSoftBounces(deliveryState, outcome.finalState));
  }

  /** The outcome in one transaction; `withEvents: false` is the degraded write. */
  const write = (withEvents: boolean) =>
    db.transaction(async (tx) => {
      const filed: Array<{
        recipient: string;
        bounceType: InlineBounce["bounceType"];
        code: string;
        suppressionId: string | null;
        applied: boolean;
      }> = [];
      for (const bounce of bounces) {
        /**
         * Never weakens a permanent suppression already on file (#191); a
         * soft one only refreshes a temporary row's window.
         */
        const { suppression, applied } = await addFromBounce(
          email.apiKeyId,
          {
            email: bounce.recipient,
            bounceType: bounce.bounceType,
            diagnosticCode: bounce.code,
            sourceEmailId: emailId,
            expiresAt:
              bounce.bounceType === "soft"
                ? new Date(Date.now() + SOFT_BOUNCE_WINDOW_MS)
                : null,
          },
          tx,
        );
        if (withEvents) {
          await enqueueEvent(
            tx,
            "email.bounced",
            {
              emailId,
              to: email.toAddress,
              recipient: bounce.recipient,
              bounceType: bounce.bounceType,
              status: bounce.code,
              diagnostic: bounce.diagnostic,
              suppressionId: suppression?.id ?? null,
              source: "inline",
              tags: email.tags,
            },
            { apiKeyId: email.apiKeyId },
          );
        }
        filed.push({
          recipient: bounce.recipient,
          bounceType: bounce.bounceType,
          code: bounce.code,
          suppressionId: suppression?.id ?? null,
          applied,
        });
      }
      const rowSaved = await releaseRowWithEvents(
        tx,
        email,
        claim,
        outcome.values,
        withEvents ? outcome.events : [],
      );
      return { bounced: filed, saved: rowSaved };
    });

  let recorded: Awaited<ReturnType<typeof write>> | undefined;
  let lastError: unknown;
  for (const delayMs of [0, ...OUTCOME_RETRY_DELAYS_MS]) {
    if (delayMs > 0) await Bun.sleep(delayMs);
    try {
      recorded = await write(true);
      break;
    } catch (error) {
      lastError = error;
      logger.warn("Email outcome transaction failed", {
        emailId,
        attempt,
        error: loggableError(error),
      });
    }
  }
  if (recorded === undefined) {
    /** Throws when the database is unavailable: the caller leaves it to the lease. */
    recorded = await write(false);
    logger.error("Webhook events not recorded for a sent email", {
      emailId,
      attempt,
      events: [
        ...bounces.map(() => "email.bounced"),
        ...(recorded.saved ? outcome.events.map((e) => e.event) : []),
      ],
      sqlState: sqlStateOf(lastError),
      error: loggableError(lastError),
    });
  }
  const { bounced, saved } = recorded;

  for (const bounce of bounced) {
    logger.warn(
      bounce.bounceType === "hard"
        ? "Multi-MX recipient hard-bounced: auto-suppressed"
        : "Mailbox full for the whole retry window: soft-suppressed for 24 h",
      {
        emailId,
        apiKeyId: email.apiKeyId,
        recipient: redactEmail(bounce.recipient),
        status: bounce.code,
        suppressionId: bounce.suppressionId,
        suppressionApplied: bounce.applied,
      },
    );
  }
  if (!saved) return;

  if (outcome.kind === "deferred") {
    /** The mailer logged the bucket at `info`, once a minute; one line per email is noise. */
    logger.debug("Email deferred by the MX rate budget", {
      emailId,
      deferredGroups: outcome.deferredGroups,
      retryInMs: outcome.delayMs,
    });
    return;
  }
  if (outcome.kind === "retry") {
    logger.warn("Email send had retry groups, requeued", {
      emailId,
      attempt,
      retryInSeconds: outcome.retrySeconds,
      /** Of those, the ones the rate budget held back (#250), not failures. */
      deferredGroups: outcome.deferredGroups,
    });
    return;
  }
  const finalGroups = Object.values(outcome.finalState);
  logger.info("Email reached terminal state", {
    emailId,
    messageId,
    attempt,
    finalStatus: outcome.finalStatus,
    sentGroups: finalGroups.filter((g) => g.status === "sent").length,
    failedGroups: finalGroups.filter((g) => g.status === "failed").length,
  });
  emailsFinished.inc({ status: outcome.finalStatus, source: metricSource(email) });
}

/**
 * Writes a row's outcome and enqueues the events it raises, in the
 * caller's transaction (#184). The events are enqueued only when this
 * claim still held the row: when the lease was lost, the outcome is not
 * saved and the claim that took the row over raises its own events.
 *
 * @returns Whether the outcome was saved.
 */
export async function releaseRowWithEvents(
  tx: Tx,
  email: ClaimedEmail,
  claim: Claim,
  values: PgUpdateSetSource<typeof emails>,
  events: OutcomeEvent[],
): Promise<boolean> {
  const saved = await releaseRow(claim, values, tx);
  if (!saved) return false;
  for (const { event, data } of events) {
    await enqueueEvent(tx, event, data, { apiKeyId: email.apiKeyId });
  }
  return true;
}
