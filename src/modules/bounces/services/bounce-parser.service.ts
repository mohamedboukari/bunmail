/**
 * Pure DSN parser. Takes a raw RFC 822 message string (the same bytes
 * the SMTP server received) and returns either a `ParsedBounce` ready
 * for the handler, or `null` when the message isn't actionable as a
 * bounce.
 *
 * The function is pure on purpose — no I/O, no mailparser dependency —
 * so unit tests can feed in fixture strings and assert the parsed shape
 * deterministically.
 *
 * Two parsing strategies, tried in order:
 *
 *   1. **RFC 3464** (the standard). Triggered by
 *      `Content-Type: multipart/report; report-type=delivery-status`.
 *      Parses the `message/delivery-status` MIME part for `Final-Recipient`,
 *      `Status`, `Diagnostic-Code`, and `Original-Message-ID`. Modern
 *      Gmail / Outlook / Yahoo bounces hit this path.
 *
 *   2. **Fallback regex** for non-RFC bounces. Some old MTAs (qmail,
 *      Exim with old configs, custom mail servers) send plain-text
 *      bounce notices. The fallback scrapes an SMTP status code, the
 *      recipient `<user@host>`, and an `In-Reply-To` / `Message-ID` to
 *      link back to the original send.
 *
 * In either case, we **require** an `originalMessageId` — without it
 * the bounce can't be safely linked to a specific tenant (per #25's
 * per-API-key scoping), and we'd rather drop a real bounce than
 * suppress under the wrong key.
 */

import type { ParsedBounce } from "../types/bounce.types.ts";

/** Match `multipart/report; ...; report-type=delivery-status`. */
const DSN_CONTENT_TYPE_RE =
  /multipart\/report[^;]*;[^]*report-type\s*=\s*"?delivery-status"?/i;

/** Match an enhanced SMTP status code: 2.x.x / 4.x.x / 5.x.x. */
const ENHANCED_STATUS_RE = /\b([245])\.(\d+)\.(\d+)\b/;

/** Match a 3-digit basic SMTP status code (lookahead for whitespace/end). */
const BASIC_STATUS_RE = /\b([245]\d{2})\b(?!\.)/;

/**
 * Strips angle brackets, surrounding whitespace, and any trailing display
 * comment from an `<addr@host>`-style line.
 */
function cleanAddress(raw: string): string {
  const m = raw.trim().match(/<?([^@<>\s]+@[^@<>\s]+)>?/);
  return m ? m[1]!.trim().toLowerCase() : "";
}

/** Strips angle brackets from a `<message-id@host>`-style line. */
function cleanMessageId(raw: string): string {
  const m = raw.trim().match(/<?([^>\s]+)>?/);
  return m ? m[1]!.trim().replace(/[<>]/g, "") : "";
}

/**
 * RFC 3464 path. Looks at the raw text for the canonical `Status:` /
 * `Final-Recipient:` / `Original-Message-ID:` headers that appear
 * inside the `message/delivery-status` MIME part. We don't strictly
 * walk the MIME tree — these headers live on their own lines in the
 * delivery-status part, and a line-anchored regex finds them reliably.
 */
function parseRfc3464(raw: string): ParsedBounce | null {
  /**
   * `Final-Recipient` is "<addr-type>; <address>" where addr-type is
   * usually `rfc822`. We accept either with or without the prefix.
   */
  const recipientLine = raw.match(/^Final-Recipient:\s*(?:[^;]+;)?\s*([^\r\n]+)/im);
  const statusLine = raw.match(/^Status:\s*([245]\.\d+\.\d+)/im);
  const diagnosticLine = raw.match(/^Diagnostic-Code:\s*(?:[^;]+;)?\s*([^\r\n]+)/im);
  const messageIdLine = raw.match(/^Original-Message-ID:\s*([^\r\n]+)/im);

  if (!recipientLine || !statusLine || !messageIdLine) return null;

  const status = statusLine[1]!;
  const kind = status.startsWith("5") ? "hard" : status.startsWith("4") ? "soft" : null;
  /** 2.x.x is "delivered" — not a bounce. */
  if (!kind) return null;

  const recipient = cleanAddress(recipientLine[1]!);
  const originalMessageId = cleanMessageId(messageIdLine[1]!);
  if (!recipient || !originalMessageId) return null;

  return {
    kind,
    recipient,
    originalMessageId,
    status,
    diagnostic: diagnosticLine ? diagnosticLine[1]!.trim() : undefined,
    source: "rfc3464",
  };
}

/**
 * Best-effort fallback for non-RFC bounces. Scrapes:
 *   - any enhanced or basic SMTP status code from the body,
 *   - the first `<user@host>` that isn't ours (heuristic: not from MAILER-DAEMON),
 *   - any `Message-ID`/`In-Reply-To` reference back to the original.
 *
 * Less reliable than RFC 3464 — old MTAs vary wildly. We only return a
 * result when all three pieces are present, so a noisy match doesn't
 * become a wrong suppression.
 */
function parseFallback(raw: string): ParsedBounce | null {
  const enhancedMatch = raw.match(ENHANCED_STATUS_RE);
  const basicMatch = raw.match(BASIC_STATUS_RE);

  let status: string | null = null;
  if (enhancedMatch) {
    status = enhancedMatch[0];
  } else if (basicMatch) {
    /** Promote a 3-digit code to the closest enhanced equivalent. */
    const code = parseInt(basicMatch[1]!, 10);
    if (code >= 500 && code < 600) status = "5.0.0";
    else if (code >= 400 && code < 500) status = "4.0.0";
  }
  if (!status) return null;

  const kind = status.startsWith("5") ? "hard" : status.startsWith("4") ? "soft" : null;
  if (!kind) return null;

  /**
   * Search for the recipient in the **body**, not the headers — `<msg-id@host>`
   * has the same `<x@y>` shape as `<addr@host>`, so an `In-Reply-To` /
   * `Message-ID` / `References` header would otherwise win document order.
   *
   * The header/body split is the canonical RFC 5322 separator: a blank
   * line. If we can't find one (extremely malformed input), bail.
   */
  const headerBodySplit = raw.search(/\r?\n\r?\n/);
  if (headerBodySplit < 0) return null;
  const body = raw.slice(headerBodySplit);

  const recipientCandidates = [...body.matchAll(/<([^@<>\s]+@[^@<>\s]+)>/g)].map((m) =>
    m[1]!.toLowerCase(),
  );
  /**
   * Skip postmaster/mailer-daemon (the From: of the bounce itself) and
   * skip anything sitting on a `Message-ID:` / `In-Reply-To:` / `References:`
   * line in the embedded original — those are message identifiers, not
   * recipient addresses.
   */
  const recipient = recipientCandidates.find((addr) => {
    if (/^(?:mailer-daemon|postmaster)@/i.test(addr)) return false;
    const headerLineRe = new RegExp(
      `^(?:Message-ID|In-Reply-To|References):.*<${addr.replace(/[.+-]/g, "\\$&")}>`,
      "im",
    );
    return !headerLineRe.test(body);
  });
  if (!recipient) return null;

  /**
   * `In-Reply-To` is the most reliable back-pointer in fallback bounces;
   * `Message-ID` of the embedded original is the next best.
   */
  const inReplyTo = raw.match(/^In-Reply-To:\s*([^\r\n]+)/im);
  const embeddedMessageId = raw.match(/^Message-ID:\s*([^\r\n]+)/im);
  const messageIdRaw = inReplyTo?.[1] ?? embeddedMessageId?.[1];
  if (!messageIdRaw) return null;

  const originalMessageId = cleanMessageId(messageIdRaw);
  if (!originalMessageId) return null;

  /**
   * Pull the line containing the status code as the diagnostic — gives
   * operators something readable when triaging in the dashboard.
   */
  const diagnostic = raw
    .split(/\r?\n/)
    .find((l) => l.includes(status!) || (basicMatch && l.includes(basicMatch[0])))
    ?.trim();

  return {
    kind,
    recipient,
    originalMessageId,
    status,
    diagnostic,
    source: "fallback",
  };
}

/**
 * Heuristic gate for the fallback parser. We only scrape status codes
 * out of message bodies when there's reason to believe the message is
 * a bounce in the first place — sender is the canonical DSN robot,
 * subject mentions delivery failure, or the content-type is
 * `multipart/report` even without an explicit `report-type=delivery-status`.
 *
 * Without this gate, any regular inbound mail that happened to mention
 * a status-code-shaped string in its body could be mis-classified as a
 * bounce and trigger an erroneous suppression.
 */
function looksLikeBounce(raw: string): boolean {
  const fromMatch = raw.match(/^From:\s*([^\r\n]+)/im);
  if (fromMatch && /mailer-daemon|postmaster/i.test(fromMatch[1]!)) return true;

  const subjectMatch = raw.match(/^Subject:\s*([^\r\n]+)/im);
  if (
    subjectMatch &&
    /undelivered|delivery (?:failure|status notification)|returned mail|failure notice|mail delivery failed/i.test(
      subjectMatch[1]!,
    )
  ) {
    return true;
  }

  const contentTypeMatch = raw.match(
    /^Content-Type:\s*([^\r\n]+(?:\r?\n[ \t][^\r\n]+)*)/im,
  );
  if (contentTypeMatch && /multipart\/report/i.test(contentTypeMatch[1]!)) return true;

  return false;
}

/**
 * Public entry point. Returns `null` when the message isn't a bounce
 * we can act on — the inbound path then falls through to normal
 * `inbound_emails` storage.
 */
export function parseBounce(raw: string): ParsedBounce | null {
  /**
   * Detect DSN content-type — only attempt RFC 3464 parsing when the
   * sender explicitly advertised it. Saves work on regular inbound mail
   * and avoids false positives from messages that happen to mention a
   * status code in their body.
   */
  const contentTypeMatch = raw.match(
    /^Content-Type:\s*([^\r\n]+(?:\r?\n[ \t][^\r\n]+)*)/im,
  );
  const isDsn = contentTypeMatch ? DSN_CONTENT_TYPE_RE.test(contentTypeMatch[1]!) : false;

  if (isDsn) {
    const rfc = parseRfc3464(raw);
    if (rfc) return rfc;
  }

  /**
   * Fallback path runs only when the message has obvious bounce markers.
   * Otherwise inbound is left to normal handling — better to miss a bounce
   * from a non-RFC sender than to mis-classify regular customer reply mail.
   */
  if (!looksLikeBounce(raw)) return null;
  return parseFallback(raw);
}
