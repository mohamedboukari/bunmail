/**
 * Whether a feedback-loop complaint is **verified** (#191), the condition
 * for `SUPPRESSIONS_SHARED_HARD` to share it with the other API keys. Pure:
 * the handler passes the report's DKIM verdict, the header fields as the
 * DKIM verifier reads them ({@link readSignedHeaderView}), the SMTP
 * envelope sender, and the operator's lists from the config.
 *
 * A verified complaint must come from a configured feedback-loop sender,
 * signed by that sender's own domain:
 *
 * 1. `FEEDBACK_LOOP_DOMAINS` and `FEEDBACK_LOOP_SENDERS` are both set
 *    (either one empty: nothing is verified);
 * 2. a DKIM signature that passed and may vouch for the report
 *    (`signatureCanVouch`) has a `d=` listed in `FEEDBACK_LOOP_DOMAINS`;
 * 3. the header section has exactly one top-level `Content-Type`, and
 *    exactly one `From` field holding one address, which matches
 *    `FEEDBACK_LOOP_SENDERS` (an exact address, or `@domain` for any
 *    address at exactly that domain);
 * 4. that signature's `d=` is aligned with the `From` domain: the same
 *    domain, or the `From` domain is a subdomain of it;
 * 5. the envelope sender (`MAIL FROM`), unless it is empty (`<>`, which
 *    RFC 6650 section 6 recommends for generated reports), also matches
 *    `FEEDBACK_LOOP_SENDERS`.
 *
 * Why each step: a DKIM signature proves only which domain signed. A
 * listed domain may also sign mail its users write, so the signed `From`
 * must name the provider's feedback-loop sender, and the signature that
 * counts must belong to that sender's domain. `From` and `Content-Type` are
 * covered by every signature that may vouch (`h=` must list them), but a
 * signature covers only one instance of each (the bottom-most), so the
 * fields are read with the verifier's own header split and any second
 * instance, as any reader could see one, means nothing is verified: the
 * `From` checked and the `Content-Type` that tells the ARF parser which
 * part holds the feedback fields are then the signed ones. The envelope is not authenticated here (inbound mail is
 * not SPF-checked): its check is a consistency check, not a proof.
 */

import type { DkimCheck } from "./feedback-handler.service.ts";
import { fieldValue, lowerAscii, splitMessage } from "./dkim-verifier-parse.service.ts";
import { mailboxAddress } from "./arf-parser.service.ts";

/**
 * The header fields the verified decision reads, taken the way the DKIM
 * verifier reads the header section ({@link readSignedHeaderView}).
 */
export interface SignedHeaderView {
  /** The address of the one `From` field, or `null` (none, several, or not one plain mailbox). */
  from: string | null;
  /** Whether the header section has exactly one top-level `Content-Type`. */
  contentTypeSingle: boolean;
}

/**
 * A line any reader could take for a `From` or `Content-Type` field: the
 * name, in any ASCII case, with any run of characters other than printable
 * ASCII around it (controls, non-ASCII bytes, spaces after the name)
 * before the colon. Lines that start with SP or HTAB are left out: every
 * reader here (the verifier, the ARF parser) folds them into the field
 * above, and a folded `h=` list of a DKIM-Signature often has a line
 * starting with `from:`. Anchored at the line start and unambiguous, so
 * linear.
 */
const LENIENT_FIELD = {
  from: /^[^\x21-\x7e]*from[^\x21-\x7e]*:/i,
  contentType: /^[^\x21-\x7e]*content-type[^\x21-\x7e]*:/i,
} as const;

/**
 * Reads `From` and `Content-Type` from the raw report the way the DKIM
 * verifier does (`splitMessage`: latin1, CRLF line ends, names compared
 * after `trimFws` and ASCII lowercasing), so they are the instances a
 * signature's `h=` selected:
 *
 * - each must be present exactly once in that split;
 * - every line of the header section that does not continue the one
 *   above is also checked with a lenient pattern (no field count or
 *   column limit, a bare CR or LF also ends a line, any non-printable or
 *   non-ASCII character around the name): more than one
 *   line that could be read as `From`, or as `Content-Type`, fails, since
 *   another reader (the ARF parser) might take a different one;
 * - the `From` value is unfolded, never cut, and must be plainly one
 *   mailbox (`mailboxAddress`).
 *
 * Bounded by the caller: it runs only for a report whose DKIM check ran,
 * so the header section ended within 64 KB.
 */
export function readSignedHeaderView(rawBytes: Uint8Array): SignedHeaderView {
  const { fields } = splitMessage(rawBytes);
  const lines = fields
    .flatMap((field) => field.raw.split(/\r\n|\r|\n/))
    .filter((line) => !line.startsWith(" ") && !line.startsWith("\t"));
  const lenientCount = (pattern: RegExp): number =>
    lines.filter((line) => pattern.test(line)).length;
  const named = (name: string): typeof fields =>
    fields.filter((field) => field.name === name);

  const from = named("from");
  const fromSingle = from.length === 1 && lenientCount(LENIENT_FIELD.from) === 1;
  const contentTypeSingle =
    named("content-type").length === 1 && lenientCount(LENIENT_FIELD.contentType) === 1;
  const fromValue = fromSingle ? fieldValue(from[0]!.raw).replace(/\r\n/g, "") : null;
  return {
    from: fromValue === null ? null : mailboxAddress(fromValue),
    contentTypeSingle,
  };
}

/**
 * The operator's feedback-loop lists, as the config normalised them.
 *
 * @public Exported for its unit test.
 */
export interface FeedbackLoopPolicy {
  /** `FEEDBACK_LOOP_DOMAINS`: signing domains (`d=`) to trust. */
  domains: readonly string[];
  /** `FEEDBACK_LOOP_SENDERS`: exact addresses and `@domain` entries, lower-cased. */
  senders: readonly string[];
}

/**
 * What the rule looks at in one report.
 *
 * @public Exported for its unit test.
 */
export interface FeedbackVerificationInput {
  /** DKIM verdict on the report; only `passingDomains` counts. */
  dkim: DkimCheck;
  /** `From` and `Content-Type` as the DKIM verifier reads them ({@link readSignedHeaderView}). */
  headers: SignedHeaderView;
  /** The SMTP envelope `MAIL FROM`; `null` for the null reverse-path `<>`. */
  envelopeFrom: string | null;
}

/**
 * Why a complaint is not verified, logged as `reason`:
 *
 * - `no_feedback_loop_domains`: `FEEDBACK_LOOP_DOMAINS` is empty (the feature is off);
 * - `no_feedback_loop_senders`: `FEEDBACK_LOOP_SENDERS` is empty;
 * - `domain_not_listed`: no signature that may vouch passed for a listed domain;
 * - `content_type_ambiguous`: no top-level `Content-Type`, or more than one;
 * - `sender_missing`: the report has no `From`, several, or one that is not plainly one address;
 * - `sender_not_listed`: its `From` is not in `FEEDBACK_LOOP_SENDERS`;
 * - `not_aligned`: no listed passing signature belongs to the `From` domain;
 * - `envelope_not_listed`: a non-empty envelope sender not in `FEEDBACK_LOOP_SENDERS`.
 */
type UnverifiedReason =
  | "no_feedback_loop_domains"
  | "no_feedback_loop_senders"
  | "domain_not_listed"
  | "content_type_ambiguous"
  | "sender_missing"
  | "sender_not_listed"
  | "not_aligned"
  | "envelope_not_listed";

/** The rule's verdict: verified (with the `d=` that vouched), or why not. */
export type FeedbackVerification =
  | { verified: true; signingDomain: string }
  | { verified: false; reason: UnverifiedReason };

/** A domain compared without ASCII case, surrounding space or a final dot. */
function canonicalDomain(domain: string): string {
  return lowerAscii(domain.trim()).replace(/\.$/, "");
}

/**
 * Splits an address at its last `@`: local part lowercased in ASCII only
 * (no other character folds into a listed one), canonical domain. `null`
 * for anything but printable ASCII.
 */
function splitAddress(address: string): { local: string; domain: string } | null {
  const trimmed = address.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || !/^[\x21-\x7e]+$/.test(trimmed)) return null;
  return {
    local: lowerAscii(trimmed.slice(0, at)),
    domain: canonicalDomain(trimmed.slice(at + 1)),
  };
}

/**
 * Whether `address` matches one of `senders` (`FEEDBACK_LOOP_SENDERS`):
 * an entry `user@domain` matches that address exactly, an entry `@domain`
 * any address at exactly that domain (no subdomains). Case is ignored.
 *
 * @public Exported for its unit test.
 */
export function senderListed(address: string, senders: readonly string[]): boolean {
  const parts = splitAddress(address);
  if (parts === null) return false;
  return senders.some((entry) => {
    const listed = entry.startsWith("@")
      ? { local: "", domain: canonicalDomain(entry.slice(1)) }
      : splitAddress(entry);
    if (listed === null || listed.domain !== parts.domain) return false;
    return listed.local === "" || listed.local === parts.local;
  });
}

/**
 * Whether a signature of `signingDomain` speaks for mail from `fromDomain`:
 * the same domain, or `fromDomain` is a subdomain of it (a `d=example.net`
 * signature covers `From: feedback@fbl.example.net`, not the other way
 * round, so a signer cannot vouch for its parent domain).
 *
 * @public Exported for its unit test.
 */
export function isAligned(fromDomain: string, signingDomain: string): boolean {
  const from = canonicalDomain(fromDomain);
  const signer = canonicalDomain(signingDomain);
  return from === signer || from.endsWith(`.${signer}`);
}

/**
 * The verified-complaint rule, see the file comment for the steps. The
 * domain comparison is exact (no subdomains) for `FEEDBACK_LOOP_DOMAINS`:
 * a subdomain rule would trust every name under a listed one, so one
 * mistaken entry would let anyone verify, and there is no public suffix
 * list here to guard against it. A miss only keeps the complaint per key,
 * the safe side.
 */
export function verifyFeedbackReport(
  input: FeedbackVerificationInput,
  policy: FeedbackLoopPolicy,
): FeedbackVerification {
  if (policy.domains.length === 0) {
    return { verified: false, reason: "no_feedback_loop_domains" };
  }
  if (policy.senders.length === 0) {
    return { verified: false, reason: "no_feedback_loop_senders" };
  }
  const listed = new Set(policy.domains.map(canonicalDomain));
  const signers = input.dkim.passingDomains
    .map(canonicalDomain)
    .filter((domain) => listed.has(domain));
  if (signers.length === 0) return { verified: false, reason: "domain_not_listed" };

  if (!input.headers.contentTypeSingle) {
    return { verified: false, reason: "content_type_ambiguous" };
  }
  const address = input.headers.from;
  const from = address === null ? null : splitAddress(address);
  if (address === null || from === null) {
    return { verified: false, reason: "sender_missing" };
  }
  if (!senderListed(address, policy.senders)) {
    return { verified: false, reason: "sender_not_listed" };
  }
  const signer = signers.find((domain) => isAligned(from.domain, domain));
  if (signer === undefined) return { verified: false, reason: "not_aligned" };

  if (input.envelopeFrom !== null && !senderListed(input.envelopeFrom, policy.senders)) {
    return { verified: false, reason: "envelope_not_listed" };
  }
  return { verified: true, signingDomain: signer };
}
