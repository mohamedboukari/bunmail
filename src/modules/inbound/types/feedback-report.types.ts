/**
 * A parsed ARF feedback report (RFC 5965, #191): what a mailbox provider's
 * feedback loop sends back when one of its users marks a message as spam.
 * Every field comes from unauthenticated inbound mail, so nothing here is
 * trusted until the handler links `originalMessageId` to an email BunMail
 * sent.
 */
export interface FeedbackReport {
  /** `Feedback-Type`, trimmed and lowercased; `null` when missing or empty. */
  feedbackType: string | null;
  /** `User-Agent` of the report generator, e.g. `Yahoo!-Mail-Feedback/2.0`. */
  userAgent: string | null;
  /** `Version` (always `1` in RFC 5965). */
  version: string | null;
  /** `Original-Mail-From`, the envelope sender of the reported message, lowercased. */
  originalMailFrom: string | null;
  /**
   * Every `Original-Rcpt-To`, lowercased, in order. Providers often redact
   * it (or leave it out), so it can be empty.
   */
  originalRcptTo: string[];
  /** `Arrival-Date` (or the older `Received-Date`), when it parses as a date. */
  arrivalDate: Date | null;
  /** `Reported-Domain`. */
  reportedDomain: string | null;
  /** `Source-IP`, the address the reported message came from. */
  sourceIp: string | null;
  /**
   * Message-ID of the reported message, without angle brackets: the
   * feedback part's `Original-Message-ID`, else the `Message-ID` header of
   * the third part (`message/rfc822` or `text/rfc822-headers`). `null` when
   * neither has one.
   */
  originalMessageId: string | null;
  /** Domain of the report's own `From` address, lowercased: who sent the report. */
  reporterDomain: string | null;
}

/** What a feedback type asks BunMail to do (#191). */
export type FeedbackAction = "complaint" | "opt-out" | "ignore";

/**
 * Outcome of one feedback report, for the receiver's debug line and tests.
 *
 * - `complained`: complaint suppression created or strengthened, webhook fired.
 * - `complained-no-recipient`: linked, but no single recipient could be
 *   chosen; nothing suppressed, webhook fired with `recipient: null`.
 * - `already-complained`: the address already had a permanent complaint
 *   suppression; nothing changed, nothing fired.
 * - `unsubscribed` / `already-unsubscribed`: an `opt-out` report, handled
 *   by the unsubscribe path.
 * - `dropped-unparseable`: a `feedback-report` without a readable
 *   machine-readable part.
 * - `dropped-ignored-type`: `not-spam`, `virus` or another type BunMail
 *   does not act on.
 * - `dropped-no-original`: no Original-Message-ID, or one that matches no
 *   email BunMail sent.
 * - `dropped-no-recipient`: an `opt-out` report whose recipient could not
 *   be chosen.
 */
export type FeedbackOutcome =
  | "complained"
  | "complained-no-recipient"
  | "already-complained"
  | "unsubscribed"
  | "already-unsubscribed"
  | "dropped-unparseable"
  | "dropped-ignored-type"
  | "dropped-no-original"
  | "dropped-no-recipient";
