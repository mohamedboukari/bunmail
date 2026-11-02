import { sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { emails } from "../models/email.schema.ts";
import type { DeliveryState, DeliveryGroup } from "../models/email.schema.ts";
import type { WebhookEventType } from "../../webhooks/types/webhook.types.ts";
import { parseSmtpError, type ParsedSmtpError } from "../../../utils/smtp-error.ts";
import { config } from "../../../config.ts";
import { nextRetryDelayMs } from "./retry-schedule.ts";
import { deferralDelayMs } from "./rate-budget.ts";
import type { ClaimedEmail } from "./queue-claim.service.ts";

/**
 * Oldest an email may get while temporary failures are still retried.
 * Read at use time, not import time, so modules that import this one
 * with a partial config stub (unit tests) still load.
 */
export function retryMaxAgeMs(): number {
  return config.mail.retryMaxAgeHours * 60 * 60 * 1000;
}

/** Earliest time any MX group was delivered, if one was. */
function firstDeliveredAt(state: DeliveryState): Date | null {
  const times = Object.values(state)
    .map((g) => (g.deliveredAt ? Date.parse(g.deliveredAt) : NaN))
    .filter((t) => !Number.isNaN(t));
  return times.length > 0 ? new Date(Math.min(...times)) : null;
}

/** What one SMTP attempt produced, for {@link recordSendOutcome}. */
export interface SentAttempt {
  deliveryState: DeliveryState;
  messageId: string;
  /** Each MX group's status before this attempt. */
  priorStatuses: Map<string, DeliveryGroup["status"]>;
  /** Entries the rate budget kept from this attempt (#250), see `SendMailResult`. */
  deferred?: { keys: string[]; waitMs: number };
}

/** A webhook event raised by a row's outcome, enqueued with it (#184). */
export interface OutcomeEvent {
  event: WebhookEventType;
  data: Record<string, unknown>;
}

/** The row update and events an attempt's delivery state leads to. */
type RowOutcome =
  /**
   * Nothing was attempted: every pending entry was held back by the rate
   * budget (#250). Back to `queued` without counting the attempt, no event.
   */
  | {
      kind: "deferred";
      values: PgUpdateSetSource<typeof emails>;
      events: OutcomeEvent[];
      delayMs: number;
      deferredGroups: number;
    }
  | {
      kind: "retry";
      values: PgUpdateSetSource<typeof emails>;
      events: OutcomeEvent[];
      retrySeconds: number;
      deferredGroups: number;
    }
  | {
      kind: "terminal";
      values: PgUpdateSetSource<typeof emails>;
      events: OutcomeEvent[];
      finalStatus: "sent" | "bounced" | "failed";
      finalState: DeliveryState;
    };

/** `last_error` of an entry the rate budget kept from the end of the retry window (#250). */
const RATE_BUDGET_EXHAUSTED =
  "Not sent within the retry window: provider rate budget (MAIL_MX_RATE_PER_MIN)";

/** `NOW() + <ms> milliseconds`, in database time; `ms` is a whole number we computed. */
function nowPlusMs(ms: number) {
  return sql`NOW() + interval ${sql.raw(`'${Math.max(0, Math.round(ms))} milliseconds'`)}`;
}

/**
 * Decides the row-level outcome from the aggregate group state. Pure,
 * apart from the jitter of a deferral.
 *
 * - every pending entry deferred by the rate budget (#250) and nothing
 *   else attempted → `deferred`: back to `queued` once a token is due
 *   (plus jitter), with the claim's `attempts` increment undone, no
 *   `last_error`, no event. The retry window still counts from
 *   `created_at`: a deferral past it ends the email like a retry would.
 * - any group still `retry` AND the email is young enough → schedule
 *   the next pass after the backoff (#180). Entries deferred alongside
 *   attempted ones wait for the later of the backoff and their token: a
 *   deferral never shortens another entry's backoff.
 * - else (all terminal, or too old to retry) → terminal row status:
 *   - any group `sent` → row `sent`
 *   - else any failed-due-to-hard-5xx → row `bounced`
 *   - else → row `failed`
 *
 * `email.sent` fires once, on the attempt that landed the first group
 * (checked against the prior statuses so a later pass does not fire it
 * again); `email.failed` on a pure failure.
 */
export function decideRowOutcome(email: ClaimedEmail, sent: SentAttempt): RowOutcome {
  const { deliveryState, messageId, priorStatuses } = sent;
  const groups = Object.entries(deliveryState);
  const anyRetry = groups.some(([, g]) => g.status === "retry");
  const anySent = groups.some(([, g]) => g.status === "sent");
  const sentEvent: OutcomeEvent = {
    event: "email.sent",
    data: {
      emailId: email.id,
      from: email.fromAddress,
      to: email.toAddress,
      subject: email.subject,
      messageId,
      tags: email.tags,
    },
  };

  /** Entries the rate budget held back (#250): still `retry`, not attempted. */
  const deferredKeys = new Set(sent.deferred?.keys ?? []);
  const realRetry = groups.some(
    ([key, g]) => g.status === "retry" && !deferredKeys.has(key),
  );
  /** Whether this attempt did anything: an entry tried, or newly terminal. */
  const attempted =
    realRetry ||
    groups.some(
      ([key, g]) =>
        (g.status === "sent" || g.status === "failed") &&
        priorStatuses.get(key) !== g.status,
    );

  /** `undefined`: no entry needs it; `null`: the retry window is over. */
  const backoffMs = realRetry
    ? nextRetryDelayMs(email.attempts, email.ageMs, retryMaxAgeMs())
    : undefined;
  const deferMs =
    sent.deferred && deferredKeys.size > 0
      ? deferralDelayMs(sent.deferred.waitMs)
      : undefined;
  const delayMs =
    backoffMs === null || (backoffMs === undefined && deferMs === undefined)
      ? null
      : Math.max(backoffMs ?? 0, deferMs ?? 0);
  const retryDelayMs =
    anyRetry && delayMs !== null && email.ageMs + delayMs <= retryMaxAgeMs()
      ? delayMs
      : null;

  if (retryDelayMs !== null && !attempted) {
    /**
     * A pure deferral: nothing was sent or tried. The claim incremented
     * `attempts`; it is set back, so a deferral never counts as an attempt
     * (nor moves the backoff schedule). The claim's fencing check matched
     * the incremented value before this write, so the release is still
     * fenced. `last_error` is left as it was: a deferral is not a failure.
     */
    return {
      kind: "deferred",
      delayMs: retryDelayMs,
      deferredGroups: deferredKeys.size,
      values: {
        status: "queued",
        nextAttemptAt: nowPlusMs(retryDelayMs),
        attempts: email.attempts - 1,
        messageId,
        deliveryState,
      },
      events: [],
    };
  }

  if (retryDelayMs !== null) {
    /** At least one group transient-failed; row goes back to `queued`
     *  and is not claimable before the backoff passes (database clock).
     *  Persist the state so the next pass can skip already-sent groups;
     *  `sentAt` records the first delivered group. */
    const retrySeconds = Math.round(retryDelayMs / 1000);
    return {
      kind: "retry",
      retrySeconds,
      deferredGroups: deferredKeys.size,
      values: {
        status: "queued",
        nextAttemptAt: nowPlusMs(retryDelayMs),
        messageId,
        deliveryState,
        sentAt: firstDeliveredAt(deliveryState),
        lastError: summariseRetries(deliveryState, deferredKeys),
      },
      events: anySent && !anySentBefore(priorStatuses) ? [sentEvent] : [],
    };
  }

  /** Too-old-to-retry or all-terminal path. Flip any straggling retry
   *  groups to `failed` (transient-exhausted, not hard-bounced) so
   *  the persisted state has no ambiguous statuses left. */
  const finalState: DeliveryState = { ...deliveryState };
  for (const [mx, g] of Object.entries(finalState)) {
    if (g.status !== "retry") continue;
    finalState[mx] = deferredKeys.has(mx)
      ? { ...g, status: "failed", lastError: g.lastError ?? RATE_BUDGET_EXHAUSTED }
      : { ...g, status: "failed" };
  }

  const finalGroups = Object.values(finalState);
  const finalAnySent = finalGroups.some((g) => g.status === "sent");
  const finalAnyHardBounce = finalGroups.some(
    (g) => g.status === "failed" && failureOf(g)?.kind === "hard",
  );

  const finalStatus: "sent" | "bounced" | "failed" = finalAnySent
    ? "sent"
    : finalAnyHardBounce
      ? "bounced"
      : "failed";

  const events: OutcomeEvent[] = [];
  if (finalAnySent && !anySentBefore(priorStatuses)) events.push(sentEvent);
  if (!finalAnySent && finalStatus === "failed") {
    /** Pure failure (no group ever delivered + no hard 5xx): keep
     *  the `email.failed` webhook fired by the legacy path so
     *  consumers that watch this event still see it. */
    events.push({
      event: "email.failed",
      data: {
        emailId: email.id,
        from: email.fromAddress,
        to: email.toAddress,
        subject: email.subject,
        error: summariseFailures(finalState),
        /** Some receiver refused the sender (#246), not the recipient. */
        blocked: finalGroups.some((g) => g.blocked === true),
        tags: email.tags,
      },
    });
  }

  return {
    kind: "terminal",
    finalStatus,
    finalState,
    values: {
      status: finalStatus,
      messageId,
      deliveryState: finalState,
      sentAt: finalAnySent ? (firstDeliveredAt(finalState) ?? new Date()) : null,
      lastError:
        finalStatus === "sent" && finalGroups.every((g) => g.status === "sent")
          ? null
          : summariseFailures(finalState),
    },
    events,
  };
}

/**
 * A group's failure classification: the one the mailer stored from the
 * SMTP reply (#250), or, for rows written before, `lastError` parsed.
 */
export function failureOf(group: DeliveryGroup): ParsedSmtpError | undefined {
  if (group.failureKind)
    return { kind: group.failureKind, code: group.failureCode ?? "" };
  return group.lastError ? (parseSmtpError(group.lastError) ?? undefined) : undefined;
}

/**
 * Compact human-readable digest of which groups are still in retry
 * and why. Stored in `emails.last_error` between retry passes so
 * operators reading the DB can see "outlook retrying after 421" at a
 * glance without dumping the full `delivery_state` JSON.
 */
function summariseRetries(state: DeliveryState, deferred: Set<string>): string {
  const retrying = Object.entries(state).filter(([, g]) => g.status === "retry");
  if (retrying.length === 0) return "";
  return `Retrying ${retrying.length} group(s): ${retrying
    .map(
      ([mx, g]) =>
        `${mx} (${g.recipients.length} rcpt): ${deferred.has(mx) ? "deferred by the provider rate budget" : (g.lastError ?? "?")}`,
    )
    .join(" | ")}`;
}

/**
 * Compact human-readable digest of failed groups for the row's final
 * `last_error` field after a terminal outcome. Mirrors the schema
 * change from #87 phase 1 (single string), keeps the legacy column
 * useful without making operators parse the JSON every time.
 */
function summariseFailures(state: DeliveryState): string {
  const failed = Object.entries(state).filter(([, g]) => g.status === "failed");
  if (failed.length === 0) return "";
  return `Failed ${failed.length} group(s): ${failed
    .map(([mx, g]) => `${mx} (${g.recipients.length} rcpt): ${g.lastError ?? "?"}`)
    .join(" | ")}`;
}

/**
 * Returns true when the row had at least one group already in `sent`
 * state before this attempt: used to skip duplicate `email.sent`
 * webhook dispatches across retry passes.
 */
function anySentBefore(priorStatuses: Map<string, DeliveryGroup["status"]>): boolean {
  for (const s of priorStatuses.values()) if (s === "sent") return true;
  return false;
}
