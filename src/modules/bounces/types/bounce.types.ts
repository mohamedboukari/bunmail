/**
 * Output of the bounce parser. The handler reads this to decide what to
 * do with the original email (mark bounced) and what kind of suppression
 * to file (hard / soft).
 *
 * `kind: "hard" | "soft"` is derived from the SMTP enhanced status code:
 *   - `5.x.x` → permanent failure → hard
 *   - `4.x.x` → transient failure → soft
 *
 * Anything else (`2.x.x` "delivered" reports, malformed status, status
 * we couldn't extract) → not a bounce we should act on; the parser
 * returns `null` and the inbound path falls through to normal storage.
 */
export interface ParsedBounce {
  /** "hard" = permanent suppression; "soft" = time-windowed suppression. */
  kind: "hard" | "soft";

  /** The address that bounced. Lower-cased, no angle brackets. */
  recipient: string;

  /**
   * Original Message-ID header of the email that bounced. The handler
   * uses this to look up the `emails` row and derive the owning API key.
   * Required — bounces without an Original-Message-ID can't be linked
   * back to a specific tenant safely (per #25's per-key scoping), so the
   * parser refuses to return them.
   */
  originalMessageId: string;

  /**
   * SMTP enhanced status code, e.g. "5.1.1" (no such user) or "4.2.2"
   * (mailbox full). Persisted on the suppression row's `diagnostic_code`
   * column for operator triage.
   */
  status: string;

  /**
   * Free-text diagnostic from the receiving MTA, e.g.
   * "550 5.1.1 The email account that you tried to reach does not exist."
   * Optional — some non-RFC bounces only carry a code.
   */
  diagnostic?: string;

  /**
   * Which parser branch produced this result — "rfc3464" for the
   * structured `message/delivery-status` MIME part, "fallback" for the
   * regex scrape of the body. Logged for operator visibility; doesn't
   * change handler behaviour.
   */
  source: "rfc3464" | "fallback";
}
