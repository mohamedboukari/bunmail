/**
 * Classifies an outbound SMTP error message into the same `kind` /
 * `code` shape the bounce module emits for async DSNs (#24). The queue's
 * failure path uses this to decide whether a send failure is a hard
 * bounce we should auto-suppress on (5xx — recipient permanently
 * unreachable), a soft bounce we should keep retrying (4xx — transient),
 * or an infrastructure error we should not act on (DNS, network).
 *
 * Pure on purpose — no I/O, no logger — so unit tests can feed in
 * fixture strings and assert deterministic output.
 *
 * Why this exists:
 *   Modern Gmail / Outlook / Yahoo reject obviously-bad recipients
 *   **inline during the SMTP transaction** with `550 5.1.1 The email
 *   account that you tried to reach does not exist`. They never send
 *   an async DSN — the sending MTA already knows. Our async-DSN-only
 *   bounce handler missed these (#68); without classifying the error
 *   here, every send to a known-bad address burns three retry attempts
 *   on the same MX, which is exactly what tanks IP reputation.
 */

/** Match an enhanced SMTP status code: `5.1.1`, `4.2.2`, etc. */
const ENHANCED_STATUS_RE = /\b([245])\.(\d{1,3})\.(\d{1,3})\b/;

/** Match a 3-digit basic SMTP reply code, not followed by a `.` (so
 *  `550` matches but `550.foo` doesn't accidentally collide). */
const BASIC_STATUS_RE = /\b([245]\d{2})\b(?!\.)/;

export interface ParsedSmtpError {
  /** Hard = permanent (suppress + stop retrying). Soft = transient (allow retry). */
  kind: "hard" | "soft";

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
 * socket timeouts, TLS handshake errors, unparseable nodemailer output —
 * all "infrastructure" errors that warrant the existing retry loop).
 */
export function parseSmtpError(message: string): ParsedSmtpError | null {
  const enhanced = message.match(ENHANCED_STATUS_RE);
  if (enhanced) {
    const status = `${enhanced[1]}.${enhanced[2]}.${enhanced[3]}`;
    /** 2.x.x is success; should never appear in an error path. */
    const kind = enhanced[1] === "5" ? "hard" : enhanced[1] === "4" ? "soft" : null;
    if (!kind) return null;
    return { kind, code: status };
  }

  const basic = message.match(BASIC_STATUS_RE);
  if (basic) {
    const code = parseInt(basic[1]!, 10);
    if (code >= 500 && code < 600) return { kind: "hard", code: "5.0.0" };
    if (code >= 400 && code < 500) return { kind: "soft", code: "4.0.0" };
  }

  return null;
}
