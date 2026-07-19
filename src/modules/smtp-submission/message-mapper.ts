/**
 * Pure message-mapping helpers for the SMTP submission server (#120).
 *
 * Kept dependency-free (type-only import of `SendEmailInput`) so it can be
 * unit-tested without pulling in the SMTPServer / config / db stack — the
 * server code in `services/smtp-submission.service.ts` extracts raw
 * addresses from the parsed message + SMTP envelope and delegates the
 * shaping decisions (sender resolution, BCC preservation, To fallback) to
 * these functions.
 */

import type { SendEmailInput } from "../emails/types/email.types.ts";

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
  subject?: string;
  html?: string;
  text?: string;
}

/**
 * Builds a `SendEmailInput` from a submitted message.
 *
 * - **Sender**: the `From:` header wins; otherwise the envelope `MAIL FROM`.
 *   Throws if neither is present.
 * - **To / Cc**: taken from the visible headers.
 * - **BCC preservation**: any envelope recipient not present in the visible
 *   To/Cc headers is a blind recipient → placed in `bcc` so it's delivered
 *   but never rendered in headers. Matches how a normal MTA treats BCC.
 * - **To fallback**: if the message carried no `To:` header (some clients
 *   put everything in the envelope), the non-BCC envelope recipients become
 *   the `to` field so the send still has a visible recipient.
 *
 * Throws if there is no resolvable sender or no recipients at all — the
 * caller maps these to an SMTP 550.
 */
export function buildSubmissionInput(parts: SubmissionMessageParts): SendEmailInput {
  const from = parts.fromHeader?.trim() || parts.envelopeFrom?.trim();
  if (!from) {
    throw new Error("Missing sender address (no From header or MAIL FROM)");
  }

  const to = dedupeJoin(parts.toHeader);
  const cc = dedupeJoin(parts.ccHeader);
  const hasVisibleHeader = Boolean(to || cc);

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
     * is a blind recipient (BCC) — delivered but never rendered.
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
     * No visible headers at all — we can't tell To from BCC, so treat every
     * envelope recipient as a (visible) To recipient rather than silently
     * turning them all into BCC.
     */
    toField = dedupeJoin(parts.envelopeRecipients);
    bcc = "";
  }

  if (!toField) {
    throw new Error("No recipients");
  }

  return {
    from,
    to: toField,
    cc: cc || undefined,
    bcc: bcc || undefined,
    subject: parts.subject ?? "",
    html: parts.html,
    text: parts.text,
  };
}
