import type {
  EmailCategory,
  EmailSource,
  TrackingRequest,
} from "../types/email.types.ts";

/**
 * Whether a send is tracked (#187), decided once when the email is
 * created and stored on the row (`emails.track_opens`, `track_clicks`),
 * so retries are identical and a later domain change does not alter mail
 * already queued. Opens and clicks are decided independently, by the same
 * gates. Pure: the caller passes every input.
 *
 * Gates, all of which must allow it:
 *
 * | Gate | Closed when |
 * |---|---|
 * | Ingress | the email came through SMTP submission (no way to opt out yet) |
 * | `TRACKING_ENABLED` | the kill switch is off (the default) |
 * | Sender domain | the domain is unregistered, or has not opted in (`track_opens` / `track_clicks`, set by an admin) |
 * | Recipients | not exactly one recipient (one `to`, no cc, no bcc): an event could not be attributed |
 * | `APP_BASE_URL` | not an `https://` URL without query or fragment: tracking links must be https |
 *
 * The send itself (`tracking: { opens?, clicks? }`):
 *
 * - `false` always wins: not tracked, whatever the gates say.
 * - `true`: tracked when every gate allows it, also for `transactional`
 *   mail. When a gate is closed it is not tracked, and the send response
 *   carries a `tracking_disabled` warning.
 * - Unset: tracked when every gate allows it, except `transactional`
 *   mail, which is never tracked unless the send asks.
 *
 * A send can therefore never turn tracking on for a domain that has it
 * off, whatever its key's role: only an admin's domain setting opens that
 * gate. BunMail's own mail (invitations, alerts, notifications, reports)
 * never reaches this: it is sent without an `emails` row.
 */

/** The first gate that keeps a send from being tracked; see the table above. */
export type TrackingBlocker =
  | "smtp_submission"
  | "tracking_disabled"
  | "domain_not_opted_in"
  | "recipients"
  | "app_base_url";

/** Everything the decision depends on, besides the send's own request. */
export interface TrackingContext {
  /** `TRACKING_ENABLED`. */
  enabled: boolean;
  /** The ingress channel; SMTP submission is never tracked (yet). */
  source: EmailSource;
  /** The send's category; `transactional` defaults to off. */
  category: EmailCategory | null;
  /** The sender domain's opt-in, or null when the domain is not registered. */
  domain: { opens: boolean; clicks: boolean } | null;
  /**
   * Why the email cannot carry a per-recipient link, from
   * `oneClickBlocker` (`list-unsubscribe.ts`): the same conditions as the
   * one-click unsubscribe link, or null when it can.
   */
  oneClickBlocker: "recipients" | "app_base_url" | null;
}

/** The decision for one email. */
export interface TrackingDecision {
  opens: boolean;
  clicks: boolean;
  /**
   * Set when the send asked for tracking (`true`) that cannot be
   * honoured: the first closed gate. The send response then carries the
   * `tracking_disabled` warning. Null otherwise.
   */
  refusedBy: TrackingBlocker | null;
}

/** The first closed gate for one kind, or null when all are open. */
function firstBlocker(
  context: TrackingContext,
  domainAllows: boolean,
): TrackingBlocker | null {
  if (context.source === "smtp") return "smtp_submission";
  if (!context.enabled) return "tracking_disabled";
  if (!domainAllows) return "domain_not_opted_in";
  return context.oneClickBlocker;
}

/** One kind's outcome: tracked or not, and the gate that refused an explicit `true`. */
function decideKind(
  asked: boolean | undefined,
  domainAllows: boolean,
  context: TrackingContext,
): { on: boolean; refusedBy: TrackingBlocker | null } {
  if (asked === false) return { on: false, refusedBy: null };
  const blocker = firstBlocker(context, domainAllows);
  if (asked === true) return { on: blocker === null, refusedBy: blocker };
  /** Unset: inherit the gates, except transactional mail, which defaults to off. */
  if (context.category === "transactional") return { on: false, refusedBy: null };
  return { on: blocker === null, refusedBy: null };
}

/** Decides open and click tracking for one send (see the file comment). */
export function decideTracking(
  request: TrackingRequest | undefined,
  context: TrackingContext,
): TrackingDecision {
  const opens = decideKind(request?.opens, context.domain?.opens ?? false, context);
  const clicks = decideKind(request?.clicks, context.domain?.clicks ?? false, context);
  return {
    opens: opens.on,
    clicks: clicks.on,
    refusedBy: opens.refusedBy ?? clicks.refusedBy,
  };
}
