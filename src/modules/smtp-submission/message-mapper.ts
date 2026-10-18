/**
 * Pure message-mapping helpers for the SMTP submission server (#120).
 *
 * Kept dependency-free (its own error class, a type-only import of
 * `SendEmailInput` and the pure custom-header rules) so it can be
 * unit-tested without pulling in the SMTPServer / config / db stack: the
 * server code in `services/smtp-submission.service.ts` extracts raw
 * addresses from the parsed message + SMTP envelope and delegates the
 * shaping decisions (sender resolution, BCC preservation, To fallback) to
 * these functions.
 */

import { SubmissionRejectedError } from "./errors.ts";
import type { SendEmailInput } from "../emails/types/email.types.ts";
import {
  filterCustomHeaders,
  type DroppedHeader,
} from "../emails/services/custom-headers.ts";

/**
 * De-duplicates a list of addresses (case-insensitive, first-occurrence
 * wins) and joins them into the comma-separated form the `emails` table /
 * `SendEmailInput` expects. Empty / whitespace entries are dropped.
 */
export function dedupeJoin(addresses: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of addresses) {
    const addr = raw?.trim();
    if (!addr) continue;
    const lower = addr.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(addr);
  }
  return out.join(", ");
}

/** Raw address material extracted from a submitted message + envelope. */
export interface SubmissionMessageParts {
  /** Address from the parsed `From:` header, if any. */
  fromHeader?: string;
  /** Envelope `MAIL FROM` address, if any (fallback for the sender). */
  envelopeFrom?: string;
  /** Addresses parsed from the visible `To:` header. */
  toHeader: string[];
  /** Addresses parsed from the visible `Cc:` header. */
  ccHeader: string[];
  /** Envelope `RCPT TO` addresses (the actual delivery set). */
  envelopeRecipients: string[];
  /** Addresses parsed from the `Reply-To:` header, if any (#169). Optional so
   *  callers that predate it keep compiling. */
  replyToHeader?: string[];
  subject?: string;
  html?: string;
  text?: string;
  /** Custom headers to relay, from {@link selectRelayHeaders} (#177). */
  headers?: Record<string, string>;
}

/** One raw header line of a parsed message (mailparser's `headerLines`). */
interface RawHeaderLine {
  /** Header name, lowercase. */
  key: string;
  /** The whole raw line, `Name: value`, folding line breaks included. */
  line: string;
}

/**
 * Whether a submitted header is a candidate for relaying (#177): the
 * threading headers `In-Reply-To` and `References`, and `X-*` application
 * headers. Everything else in the message (`From`, `To`, `Received`,
 * `Content-*`, ...) is rebuilt by BunMail and never copied. `X-BunMail-*`
 * passes this check but is reserved, so the validator drops it.
 */
function isRelayCandidate(lowerName: string): boolean {
  return (
    lowerName === "in-reply-to" ||
    lowerName === "references" ||
    lowerName.startsWith("x-")
  );
}

/**
 * Picks the custom headers to relay from a submitted message (#177):
 * `In-Reply-To`, `References` and `X-*`, run through the same rules and
 * caps as the send API (`emails/services/custom-headers.ts`).
 *
 * Values are read from the raw lines, unfolded as RFC 5322 says (a line
 * break followed by a space or tab is removed) and trimmed; a value that
 * still holds a line break is refused by the validator. Unlike the send
 * API, a header that fails is **dropped**, not a reason to refuse the
 * message: mail clients add many `X-` headers of their own, and losing
 * one is safer than bouncing the mail. The caller logs `dropped` (names only).
 */
export function selectRelayHeaders(lines: readonly RawHeaderLine[]): {
  headers?: Record<string, string>;
  dropped: DroppedHeader[];
} {
  const entries: [string, string][] = [];
  for (const { key, line } of lines) {
    if (!isRelayCandidate(key.toLowerCase())) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line
      .slice(colon + 1)
      .replace(/\r?\n(?=[ \t])/g, "")
      .trim();
    entries.push([name, value]);
  }
  const { headers, dropped } = filterCustomHeaders(entries);
  return { headers: Object.keys(headers).length > 0 ? headers : undefined, dropped };
}

/**
 * Builds a `SendEmailInput` from a submitted message.
 *
 * - **Sender**: the `From:` header wins; otherwise the envelope `MAIL FROM`.
 *   Throws if neither is present.
 * - **To / Cc**: taken from the visible headers, **limited to envelope
 *   recipients**. Delivery always equals the envelope (`RCPT TO`, capped
 *   per transaction): an address that is only in a header is neither
 *   delivered nor shown. Before this, every header address was delivered,
 *   so one RCPT plus a long `To:` header bypassed the recipient cap and
 *   the per-submission quota.
 * - **BCC preservation**: any envelope recipient not present in the visible
 *   To/Cc headers is a blind recipient → placed in `bcc` so it's delivered
 *   but never rendered in headers. Matches how a normal MTA treats BCC.
 * - **To fallback**: if the message carried no `To:` header (some clients
 *   put everything in the envelope), the non-BCC envelope recipients become
 *   the `to` field so the send still has a visible recipient.
 *
 * Throws if there is no resolvable sender, no recipients at all, or the
 * headers name recipients of which none was sent in `RCPT TO` (showing the
 * envelope recipients in `To` instead would expose blind recipients to each
 * other): the caller maps these to an SMTP 550.
 */
export function buildSubmissionInput(parts: SubmissionMessageParts): SendEmailInput {
  const from = parts.fromHeader?.trim() || parts.envelopeFrom?.trim();
  if (!from) {
    throw new SubmissionRejectedError(
      "Missing sender address (no From header or MAIL FROM)",
    );
  }

  const envelope = new Set(
    parts.envelopeRecipients.map((a) => a.trim().toLowerCase()).filter(Boolean),
  );
  const inEnvelope = (address: string): boolean =>
    envelope.has(address.trim().toLowerCase());

  const to = dedupeJoin(parts.toHeader.filter(inEnvelope));
  const cc = dedupeJoin(parts.ccHeader.filter(inEnvelope));
  const hasVisibleHeader = Boolean(to || cc);

  const headerNamesRecipients = [...parts.toHeader, ...parts.ccHeader].some((a) =>
    a?.trim(),
  );
  if (headerNamesRecipients && !hasVisibleHeader) {
    throw new SubmissionRejectedError(
      "None of the To/Cc addresses was sent in RCPT TO: BunMail delivers only to envelope recipients",
    );
  }

  /** Visible set = every address rendered in To/Cc, lowercased. */
  const visible = new Set(
    [to, cc]
      .filter(Boolean)
      .join(", ")
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean),
  );

  let toField: string;
  let bcc: string;

  if (hasVisibleHeader) {
    /**
     * With visible To/Cc headers, any envelope recipient NOT shown in them
     * is a blind recipient (BCC): delivered but never rendered.
     */
    const bccAddrs = parts.envelopeRecipients.filter(
      (addr) => addr && !visible.has(addr.trim().toLowerCase()),
    );
    bcc = dedupeJoin(bccAddrs);
    /** Prefer the To header; a Cc-only message falls back to non-BCC envelope. */
    const nonBcc = parts.envelopeRecipients.filter((addr) => !bccAddrs.includes(addr));
    toField = to || dedupeJoin(nonBcc);
  } else {
    /**
     * No visible headers at all: we can't tell To from BCC, so treat every
     * envelope recipient as a (visible) To recipient rather than silently
     * turning them all into BCC.
     */
    toField = dedupeJoin(parts.envelopeRecipients);
    bcc = "";
  }

  if (!toField) {
    throw new SubmissionRejectedError("No recipients");
  }

  return {
    from,
    to: toField,
    cc: cc || undefined,
    bcc: bcc || undefined,
    /** Reply-To is a header only: it never affects delivery or BCC detection. */
    replyTo: dedupeJoin(parts.replyToHeader ?? []) || undefined,
    subject: parts.subject ?? "",
    html: parts.html,
    text: parts.text,
    headers: parts.headers,
  };
}
