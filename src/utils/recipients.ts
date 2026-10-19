/**
 * Recipient parsing and MX grouping for multi-domain outbound delivery.
 *
 * BunMail stores `to`, `cc`, `bcc` as comma-separated text on each
 * email row. Sending to recipients on multiple domains requires
 * splitting the envelope per recipient domain while keeping the message
 * body (and its `To:` / `Cc:` headers: that's what makes CC visible)
 * identical across groups. This module handles the parsing + grouping;
 * the actual SMTP submission lives in `mailer.service.ts`. (#87)
 */

export type RecipientKind = "to" | "cc" | "bcc";

export interface Recipient {
  /** Original kind on the email row. Determines header visibility (BCC is envelope-only). */
  kind: RecipientKind;
  /** Address as it should appear in RCPT TO: preserves original case for the local-part. */
  address: string;
  /** Lowercased domain: used to resolve MX. */
  domain: string;
}

/**
 * Loose email shape check. Matches `local@host.tld`; not the full RFC
 * 5322 grammar (which would over-accept). Anything that survives here
 * still has to satisfy the receiving server's own parser, so we
 * deliberately stay lenient: strict-on-our-side rejection just
 * trades one footgun (invalid mail accepted) for another (valid mail
 * refused).
 *
 * Linear by construction: the domain is dot-separated labels whose class
 * excludes the dot, so no two parts of the pattern can match the same
 * characters. The previous form, `[^...]+\.[^...]+` with dots allowed on
 * both sides, backtracked quadratically on a malformed piece such as
 * `a@....@` (about 7 s at 100 KB), and the SMTP submission path fed it
 * uncapped header addresses.
 */
const EMAIL_RE = /^[^\s@,<>"]+@[^\s@,<>".]+(?:\.[^\s@,<>".]+)+$/;

/**
 * Longest address accepted anywhere (RFC 5321 section 4.5.3.1.3: 254
 * characters including the angle brackets). Checked before any regex so a
 * pathological piece is never scanned at length. Shared with the SMTP
 * submission and inbound servers.
 */
export const MAX_ADDRESS_LENGTH = 254;

/**
 * True when `value` is one bare address in the shape the recipient parser
 * accepts: at most {@link MAX_ADDRESS_LENGTH} characters (checked first, so
 * a huge value is never scanned) and matching {@link EMAIL_RE}. Shared with
 * `config.ts` (`BUNMAIL_OWNER_EMAIL`, #215) so the codebase keeps one
 * address regex instead of a second one that drifts. No trimming: callers
 * normalize first.
 */
export function isEmailAddress(value: string): boolean {
  return value.length <= MAX_ADDRESS_LENGTH && EMAIL_RE.test(value);
}

/**
 * Parses the three raw fields off an email row into a flat list of
 * normalised recipients. Drops empty entries, trims whitespace, and
 * de-duplicates on lowercased address with first-occurrence wins.
 *
 * **Kind precedence on dedup:** if the same address appears in both
 * `to` and `cc` (or any other combination), the **earlier** kind in
 * the field-iteration order (to → cc → bcc) is kept. This matches
 * what a real MTA would do: the address gets one envelope slot, and
 * since `to` is the most-visible header it wins. The other listing
 * is silently ignored.
 *
 * Invalid syntax addresses are dropped. The caller is responsible for
 * deciding whether the resulting empty list is an error (we throw
 * upstream rather than here so the caller has the email-row context
 * to log a useful message).
 */
export function parseRecipients(
  to: string,
  cc: string | null | undefined,
  bcc: string | null | undefined,
): Recipient[] {
  /** Map from lowercased-address → Recipient, preserving insertion
   *  order so the precedence rule above falls out naturally. */
  const byLower = new Map<string, Recipient>();

  const ingest = (raw: string | null | undefined, kind: RecipientKind): void => {
    if (!raw) return;
    for (const piece of raw.split(",")) {
      const trimmed = piece.trim();
      if (!trimmed || trimmed.length > MAX_ADDRESS_LENGTH) continue;
      if (!EMAIL_RE.test(trimmed)) continue;
      const lower = trimmed.toLowerCase();
      if (byLower.has(lower)) continue;
      const at = trimmed.lastIndexOf("@");
      const domain = trimmed.slice(at + 1).toLowerCase();
      byLower.set(lower, { kind, address: trimmed, domain });
    }
  };

  ingest(to, "to");
  ingest(cc, "cc");
  ingest(bcc, "bcc");

  return Array.from(byLower.values());
}

/**
 * Groups recipients by their (lowercased) domain, in first-seen order
 * (#250). Each domain's MX set is resolved by the mailer on every attempt,
 * so a group is one domain, not one MX: two domains sharing a primary MX
 * can still have different backups.
 */
export function groupByDomain(recipients: Recipient[]): Map<string, Recipient[]> {
  const groups = new Map<string, Recipient[]>();
  for (const rcpt of recipients) {
    const bucket = groups.get(rcpt.domain);
    if (bucket) bucket.push(rcpt);
    else groups.set(rcpt.domain, [rcpt]);
  }
  return groups;
}
