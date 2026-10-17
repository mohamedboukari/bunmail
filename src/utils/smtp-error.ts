/**
 * Classifies an outbound SMTP error message into the same `kind` /
 * `code` shape the bounce module emits for async DSNs (#24). The queue's
 * failure path uses this to decide whether a send failure is a hard
 * bounce we should auto-suppress on (5xx: recipient permanently
 * unreachable), a soft bounce we should keep retrying (4xx: transient),
 * or an infrastructure error we should not act on (DNS, network).
 *
 * Pure on purpose (no I/O, no logger) so unit tests can feed in
 * fixture strings and assert deterministic output.
 *
 * Why this exists:
 *   Policy rejections (5.7.x, blocklists) are about the sender and are
 *   classified separately so they never suppress a recipient (#246).
 *
 *   Modern Gmail / Outlook / Yahoo reject obviously-bad recipients
 *   **inline during the SMTP transaction** with `550 5.1.1 The email
 *   account that you tried to reach does not exist`. They never send
 *   an async DSN: the sending MTA already knows. Our async-DSN-only
 *   bounce handler missed these (#68); without classifying the error
 *   here, every send to a known-bad address burns three retry attempts
 *   on the same MX, which is exactly what tanks IP reputation.
 */

/**
 * Match an enhanced SMTP status code: `5.1.1`, `4.2.2`, etc. Not when it is
 * part of a longer dotted number: in `connect ECONNREFUSED 5.6.7.8:25` the
 * `5.6.7` is an IP address, not a status, and reading it as one turned a
 * network error into a hard bounce that suppressed the recipient.
 */
const ENHANCED_STATUS_RE = /(?<![\d.])([245])\.(\d{1,3})\.(\d{1,3})(?![.\d])/;

/** Match a 3-digit basic SMTP reply code, not part of an IP address or a
 *  port (`1.2.3.4:587` is not a 587 reply). */
const BASIC_STATUS_RE = /(?<![\d.:])([245]\d{2})(?![.\d])/;

/**
 * Wording of replies that reject the SENDER (its IP, domain or
 * authentication), not the recipient: blocklists, reputation, and
 * SPF/DKIM/DMARC failures.
 */
const SENDER_BLOCK_RE =
  /\b(block(ed|list)|black ?list|spamhaus|spamcop|barracuda|reputation|not authenticated|unauthenticated|spf|dkim|dmarc|banned|denied by policy|policy rejection)\b/i;

/** Wording that plainly says the recipient does not exist. */
const RECIPIENT_UNKNOWN_RE =
  /(does not exist|user unknown|unknown user|no such user|mailbox (unavailable|not found)|recipient (unknown|not found|rejected))/i;

export interface ParsedSmtpError {
  /**
   * Hard = the recipient is permanently unreachable (suppress + stop
   * retrying). Policy = the receiver refuses the SENDER (blocklist,
   * reputation, authentication: #246): stop retrying but never suppress
   * the recipient, who did nothing wrong. Soft = transient (retry).
   */
  kind: "hard" | "policy" | "soft";

  /**
   * The status code we extracted. Always an enhanced-format string
   * (`5.1.1`) so consumers can store it uniformly on the suppression
   * row's `diagnostic_code` column and on the `email.bounced` webhook
   * payload's `status` field. Basic 3-digit codes are promoted to the
   * closest enhanced equivalent (`550` → `5.0.0`).
   */
  code: string;
}

/**
 * Returns a classification when the error message carries a recognisable
 * SMTP status code, or `null` when it doesn't (DNS resolution failures,
 * socket timeouts, TLS handshake errors, unparseable nodemailer output:
 * all "infrastructure" errors that warrant the existing retry loop).
 */
export function parseSmtpError(message: string): ParsedSmtpError | null {
  const enhanced = message.match(ENHANCED_STATUS_RE);
  if (enhanced) {
    const status = `${enhanced[1]}.${enhanced[2]}.${enhanced[3]}`;
    /** 2.x.x is success; should never appear in an error path. */
    if (enhanced[1] === "4") return { kind: "soft", code: status };
    if (enhanced[1] !== "5") return null;
    /** 5.7.x is the security/policy class; most are about the sender. */
    const policy = enhanced[2] === "7" || SENDER_BLOCK_RE.test(message);
    return {
      kind: policy && !RECIPIENT_UNKNOWN_RE.test(message) ? "policy" : "hard",
      code: status,
    };
  }

  const basic = message.match(BASIC_STATUS_RE);
  if (basic) {
    const code = parseInt(basic[1]!, 10);
    if (code >= 500 && code < 600) {
      const policy = SENDER_BLOCK_RE.test(message) && !RECIPIENT_UNKNOWN_RE.test(message);
      return { kind: policy ? "policy" : "hard", code: policy ? "5.7.0" : "5.0.0" };
    }
    if (code >= 400 && code < 500) return { kind: "soft", code: "4.0.0" };
  }

  return null;
}
