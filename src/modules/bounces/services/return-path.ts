import { createHmac, hkdfSync, timingSafeEqual } from "crypto";
import { config } from "../../../config.ts";
import { MAX_ADDRESS_LENGTH, parseRecipients } from "../../../utils/recipients.ts";

/**
 * Signed per-recipient return paths (VERP, #236).
 *
 * When inbound SMTP is enabled, each recipient of an email is sent in its
 * own SMTP transaction whose envelope sender (`MAIL FROM`) names that one
 * email and that one recipient:
 *
 *     b+<email id hex>.<recipient index>.<MAC>@<sender domain>
 *
 * A DSN goes back to the envelope sender, so a bounce that arrives at such
 * an address is bound to exactly that email and recipient, whatever its
 * body claims. Nothing is stored per address: it verifies against the
 * email row, for as long as that row exists.
 *
 * - The email id is `msg_` plus 24 lowercase hex characters
 *   (`generateId`); the address carries the hex part only.
 * - The recipient index is the recipient's position in
 *   {@link recipientOrder}: `to`, then `cc`, then `bcc`, parsed and
 *   de-duplicated exactly as the mailer does (`parseRecipients`). Decimal,
 *   no leading zero, at most {@link MAX_RECIPIENT_INDEX}.
 * - The MAC is HMAC-SHA256 over
 *   `verp:v1:<email id>:<index>:<lowercased recipient>`, truncated to 96
 *   bits (24 hex characters). The prefix separates it from any other HMAC
 *   made with a key from the same master.
 * - Lowercase hex only: a receiving MTA may fold the case of a local part,
 *   and an address read back in any case still verifies.
 * - The local part is at most 58 characters (2 + 24 + 1 + 6 + 1 + 24),
 *   inside the 64 a local part may have (RFC 5321 section 4.5.3.1.1).
 *
 * The key is derived with HKDF-SHA256 from `DKIM_ENCRYPTION_KEY` under its
 * own label (not the unsubscribe one), so no new secret has to be
 * configured. Rotating `DKIM_ENCRYPTION_KEY` invalidates every return path
 * already sent: a DSN that arrives later has no effect (SECURITY.md,
 * Rotation).
 */

/** HKDF `info` label: binds the derived key to this one use. */
const KEY_INFO = "bunmail return path v1";

/** Domain-separation prefix of the MAC input. */
const MAC_CONTEXT = "verp:v1";

/** MAC length kept, in bytes (96 bits, 24 hex characters). */
const MAC_BYTES = 12;

/** Highest recipient index an address may carry (six decimal digits). */
export const MAX_RECIPIENT_INDEX = 999_999;

/** Longest local part RFC 5321 allows. */
const MAX_LOCAL_PART_LENGTH = 64;

/** Local-part prefix of a return path. */
export const RETURN_PATH_LOCAL_PREFIX = "b+";

/** The id shape an address can carry: what `generateId("msg")` produces. */
const EMAIL_ID_RE = /^msg_([0-9a-f]{24})$/;

/** A whole return path, lowercase: id hex, index, MAC, domain. */
const RETURN_PATH_RE = /^b\+([0-9a-f]{24})\.(0|[1-9][0-9]{0,5})\.([0-9a-f]{24})@([^@]+)$/;

/** Any address whose local part starts with `b+`, in any case. */
const RETURN_PATH_PREFIX_RE = /^b\+[^@]*@/i;

/** What a return path names: one email, one of its recipients, and where it sits. */
export interface ReturnPathSubject {
  emailId: string;
  /** Position of `recipient` in {@link recipientOrder}. */
  index: number;
  recipient: string;
}

/** A presented return path split into its parts (not yet verified). */
export interface ParsedReturnPath {
  emailId: string;
  index: number;
  mac: Buffer;
  /** Domain part, lowercased. */
  domain: string;
}

/** Derives the return-path key from a master key (exported for the rotation test). */
export function deriveReturnPathKey(master: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), KEY_INFO, 32));
}

/** The key derived from `DKIM_ENCRYPTION_KEY`, computed once. */
let configuredKey: Buffer | null = null;

function defaultKey(): Buffer {
  configuredKey ??= deriveReturnPathKey(config.dkimEncryptionKey);
  return configuredKey;
}

/** The truncated MAC of a subject. */
function computeMac(subject: ReturnPathSubject, key: Buffer): Buffer {
  const input = [
    MAC_CONTEXT,
    subject.emailId,
    String(subject.index),
    subject.recipient.trim().toLowerCase(),
  ].join(":");
  return createHmac("sha256", key).update(input).digest().subarray(0, MAC_BYTES);
}

/**
 * The recipients of an email in return-path index order, lowercased: `to`,
 * then `cc`, then `bcc`, after the parsing and de-duplication the mailer
 * applies (`parseRecipients`, first occurrence wins). The order depends
 * only on the stored fields, so the mailer and the receiver always agree.
 */
export function recipientOrder(
  to: string,
  cc: string | null | undefined,
  bcc: string | null | undefined,
): string[] {
  return parseRecipients(to, cc, bcc).map((r) => r.address.toLowerCase());
}

/**
 * The return path for a subject at `senderDomain`, or `null` when the
 * email id is not in the `msg_<24 hex>` shape, the index is out of range,
 * or there is no domain. Such mail keeps the plain envelope sender.
 */
export function mintReturnPath(
  subject: ReturnPathSubject,
  senderDomain: string,
  key: Buffer = defaultKey(),
): string | null {
  const match = EMAIL_ID_RE.exec(subject.emailId);
  const domain = senderDomain.trim().toLowerCase();
  if (!match || !domain) return null;
  if (
    !Number.isSafeInteger(subject.index) ||
    subject.index < 0 ||
    subject.index > MAX_RECIPIENT_INDEX
  ) {
    return null;
  }
  const localPart = `${RETURN_PATH_LOCAL_PREFIX}${match[1]}.${subject.index}.${computeMac(subject, key).toString("hex")}`;
  /** Cannot happen with the bounds above; kept so a future change cannot exceed RFC 5321. */
  if (localPart.length > MAX_LOCAL_PART_LENGTH) return null;
  const address = `${localPart}@${domain}`;
  return address.length <= MAX_ADDRESS_LENGTH ? address : null;
}

/** True when the local part of `address` starts with `b+` (any case). */
export function isReturnPathAddress(address: string): boolean {
  return RETURN_PATH_PREFIX_RE.test(address);
}

/**
 * Splits a presented return path into the email id, index, MAC and domain
 * it carries, or `null` when it is malformed. Case-insensitive; the length
 * is checked before the pattern so an oversized value is never scanned.
 */
export function parseReturnPath(address: string): ParsedReturnPath | null {
  if (address.length > MAX_ADDRESS_LENGTH) return null;
  const match = RETURN_PATH_RE.exec(address.trim().toLowerCase());
  if (!match?.[1] || !match[2] || !match[3] || !match[4]) return null;
  return {
    emailId: `msg_${match[1]}`,
    index: Number(match[2]),
    mac: Buffer.from(match[3], "hex"),
    domain: match[4],
  };
}

/** True when `presented` is the MAC of `subject`. Constant time. */
export function returnPathMacMatches(
  subject: ReturnPathSubject,
  presented: Buffer,
  key: Buffer = defaultKey(),
): boolean {
  const expected = computeMac(subject, key);
  return presented.length === expected.length && timingSafeEqual(expected, presented);
}
