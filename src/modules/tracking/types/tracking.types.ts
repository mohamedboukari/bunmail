/**
 * Shared types of the tracking module (#187).
 */

/** Which tracking endpoint was hit: the open pixel or a click redirect. */
export type TrackingKind = "open" | "click";

/**
 * What became of one tracking request, the `result` label of
 * `bunmail_tracking_requests_total`:
 *   - `recorded`: an event was stored;
 *   - `deduped`: the same email, type and link within 60 seconds;
 *   - `capped`: the email's cap (20 opens, 50 clicks) or the process's
 *     per-second recording budget was reached;
 *   - `invalid`: the token did not verify (404);
 *   - `untracked`: served, but nothing to record (`TRACKING_ENABLED` off,
 *     the email not tracked for that kind, or gone).
 */
export type TrackingResult = "recorded" | "deduped" | "capped" | "invalid" | "untracked";

/** `client_kind` of an event: see `EMAIL_EVENT_CLIENT_KINDS`. */
export type TrackingClientKind = "image_proxy" | "unknown";

/** One verified tracking request, as the recorder takes it. */
export interface TrackingHit {
  kind: TrackingKind;
  emailId: string;
  /** A click: the link's position. Null for an open. */
  position: number | null;
  /** A click: the signed target URL (stored without query and fragment). Null for an open. */
  url: string | null;
  /** The request's `User-Agent`, read to classify the client and never stored. */
  userAgent: string | null;
}
