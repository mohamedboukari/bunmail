/**
 * Recipient parsing and MX grouping for multi-domain outbound delivery.
 *
 * BunMail stores `to`, `cc`, `bcc` as comma-separated text on each
 * email row. Sending to recipients on multiple domains requires
 * splitting the envelope per destination MX while keeping the message
 * body (and its `To:` / `Cc:` headers — that's what makes CC visible)
 * identical across groups. This module handles the parsing + grouping;
 * the actual SMTP submission lives in `mailer.service.ts`. (#87)
 */

export type RecipientKind = "to" | "cc" | "bcc";

export interface Recipient {
  /** Original kind on the email row. Determines header visibility (BCC is envelope-only). */
  kind: RecipientKind;
  /** Address as it should appear in RCPT TO — preserves original case for the local-part. */
  address: string;
  /** Lowercased domain — used to resolve MX. */
  domain: string;
}

/**
 * Loose email shape check. Matches `local@host.tld`; not the full RFC
 * 5322 grammar (which would over-accept). Anything that survives here
 * still has to satisfy the receiving server's own parser, so we
 * deliberately stay lenient — strict-on-our-side rejection just
 * trades one footgun (invalid mail accepted) for another (valid mail
 * refused).
 */
const EMAIL_RE = /^[^\s@,<>"]+@[^\s@,<>"]+\.[^\s@,<>"]+$/;

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
      if (!trimmed) continue;
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

/** DNS-style MX resolver: domain → mail-exchange hostname. */
export type MxResolver = (domain: string) => Promise<string>;

/**
 * Groups recipients by destination MX. One DNS query per unique
 * domain (issued in parallel), then a bucket-fill from the resolution
 * map.
 *
 * Two domains pointing at the same MX host (CNAME aliases, shared
 * receiving infrastructure) merge into one group — fewer SMTP
 * connections, exactly what we want.
 *
 * **Domain-level failure handling:** if MX resolution fails for some
 * domains, those recipients are reported in the returned `failures`
 * list rather than throwing. The caller decides whether to abort or
 * deliver to the resolvable subset. Per-group failures during the
 * actual SMTP exchange are a separate concern owned by the mailer.
 */
export async function groupByMx(
  recipients: Recipient[],
  resolver: MxResolver,
): Promise<{
  /** mxHost → recipients reachable via that MX. */
  groups: Map<string, Recipient[]>;
  /** Domains whose MX couldn't be resolved, and the recipients we
   *  therefore can't deliver to. Errors carry the domain so the caller
   *  can log usefully (which user → which domain → why). */
  failures: Array<{ domain: string; recipients: Recipient[]; error: string }>;
}> {
  const uniqueDomains = Array.from(new Set(recipients.map((r) => r.domain)));

  /**
   * Resolve all domains in parallel. `allSettled` so one failed
   * resolution doesn't cancel the others — we want to deliver to as
   * many groups as possible.
   */
  const settled = await Promise.allSettled(
    uniqueDomains.map(async (domain) => ({ domain, mxHost: await resolver(domain) })),
  );

  /** domain → mxHost, only for successful resolutions. */
  const domainToMx = new Map<string, string>();
  /** domain → error message, only for failed resolutions. */
  const domainErrors = new Map<string, string>();

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i]!;
    const domain = uniqueDomains[i]!;
    if (result.status === "fulfilled") {
      domainToMx.set(domain, result.value.mxHost);
    } else {
      domainErrors.set(
        domain,
        result.reason instanceof Error ? result.reason.message : String(result.reason),
      );
    }
  }

  const groups = new Map<string, Recipient[]>();
  /** Group failures keyed by domain so we can attach recipients per failed domain. */
  const failuresByDomain = new Map<string, Recipient[]>();

  for (const rcpt of recipients) {
    const mxHost = domainToMx.get(rcpt.domain);
    if (mxHost) {
      const bucket = groups.get(mxHost);
      if (bucket) bucket.push(rcpt);
      else groups.set(mxHost, [rcpt]);
    } else {
      const bucket = failuresByDomain.get(rcpt.domain);
      if (bucket) bucket.push(rcpt);
      else failuresByDomain.set(rcpt.domain, [rcpt]);
    }
  }

  const failures = Array.from(failuresByDomain.entries()).map(([domain, rcpts]) => ({
    domain,
    recipients: rcpts,
    error: domainErrors.get(domain) ?? "Unknown DNS error",
  }));

  return { groups, failures };
}
