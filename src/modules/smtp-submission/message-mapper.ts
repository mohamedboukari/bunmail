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
import {
  isEmailCategory,
  type EmailCategory,
  type SendEmailInput,
} from "../emails/types/email.types.ts";
import {
  filterCustomHeaders,
  type DroppedHeader,
} from "../emails/services/custom-headers.ts";
import { checkFromName, type FromNameProblem } from "../emails/services/from-name.ts";
import { checkTags, describeTagProblem } from "../emails/services/tags.ts";

/**
 * The header a submitting client sets the send category with (#250),
 * lowercase. Consumed by BunMail and never relayed.
 */
export const CATEGORY_HEADER = "x-bunmail-category";

/**
 * The header a submitting client adds a tag with (#189), lowercase, as
 * `X-BunMail-Tag: key=value`, once per tag. Consumed by BunMail and never
 * relayed.
 */
const TAG_HEADER = "x-bunmail-tag";

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
  /** Display name of the `From:` header, from {@link submissionFromName} (#250). */
  fromName?: string;
  /** Category from `X-BunMail-Category`, from {@link submissionCategory} (#250). */
  category?: EmailCategory;
  /** Tags from `X-BunMail-Tag`, from {@link submissionTags} (#189). */
  tags?: Record<string, string>;
}

/**
 * The display name of a submitted `From:` header (#250), through the send
 * API's rules (`emails/services/from-name.ts`). A name that fails is
 * dropped, not a reason to refuse the mail (the address is still right):
 * `problem` tells the caller what to log. An absent or blank name is
 * simply none.
 */
export function submissionFromName(raw: string | undefined): {
  fromName?: string;
  problem?: FromNameProblem;
} {
  if (raw === undefined || raw.trim() === "") return {};
  const checked = checkFromName(raw);
  return checked.ok ? { fromName: checked.name } : { problem: checked.problem };
}

/**
 * The category a submitted message asks for with `X-BunMail-Category:
 * transactional|marketing` (#250), case-insensitive. Absent: none. Any
 * other value, or the header given more than once, is refused (the
 * caller answers 550): sending a marketing message as uncategorized, or
 * the other way round, is worse than a clear rejection.
 */
export function submissionCategory(
  lines: readonly RawHeaderLine[],
): EmailCategory | undefined {
  const values: string[] = [];
  for (const { key, line } of lines) {
    if (key.toLowerCase() !== CATEGORY_HEADER) continue;
    const colon = line.indexOf(":");
    values.push(
      colon < 0
        ? ""
        : line
            .slice(colon + 1)
            .replace(/\r?\n(?=[ \t])/g, "")
            .trim()
            .toLowerCase(),
    );
  }
  if (values.length === 0) return undefined;
  const [value] = values;
  if (values.length > 1 || !isEmailCategory(value)) {
    throw new SubmissionRejectedError(
      "X-BunMail-Category must be given once, as transactional or marketing",
    );
  }
  return value;
}

/**
 * The tags a submitted message asks for (#189): one `X-BunMail-Tag:
 * key=value` header per tag (name case-insensitive, split on the first
 * `=`, so a value may contain `=`), checked by the send API's rules
 * (`emails/services/tags.ts`). Values are taken as written, without
 * RFC 2047 decoding. A header without `=`, a tag that breaks a rule, the
 * same key twice (ignoring case) or more than 10 tags is refused (the
 * caller answers 550): mail filed under the wrong labels is worse than a
 * clear rejection. The refusal names the key only when it is valid,
 * never the value. Absent: none.
 */
export function submissionTags(
  lines: readonly RawHeaderLine[],
): Record<string, string> | undefined {
  const entries: [string, string][] = [];
  for (const { key, line } of lines) {
    if (key.toLowerCase() !== TAG_HEADER) continue;
    /** Unfolded as RFC 5322 says (as `X-BunMail-Category` is), then trimmed. */
    const value = line
      .slice(line.indexOf(":") + 1)
      .replace(/\r?\n(?=[ \t])/g, "")
      .trim();
    const equals = value.indexOf("=");
    if (equals < 0) {
      throw new SubmissionRejectedError("X-BunMail-Tag must be key=value");
    }
    entries.push([value.slice(0, equals).trim(), value.slice(equals + 1)]);
  }
  if (entries.length === 0) return undefined;
  const checked = checkTags(entries);
  if (!checked.ok) {
    throw new SubmissionRejectedError(describeTagProblem(checked, "X-BunMail-Tag"));
  }
  return checked.tags;
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
    /**
     * `X-BunMail-Category` (#250) and `X-BunMail-Tag` (#189) are BunMail's
     * own instructions: consumed, never relayed, and not reported as
     * dropped (a tag's value must not reach the log).
     */
    if (key.toLowerCase() === CATEGORY_HEADER || key.toLowerCase() === TAG_HEADER) {
      continue;
    }
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
    fromName: parts.fromName,
    category: parts.category,
    tags: parts.tags,
  };
}
