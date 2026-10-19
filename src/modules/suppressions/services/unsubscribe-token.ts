import { createHmac, hkdfSync, timingSafeEqual } from "crypto";
import { config } from "../../../config.ts";
import { parseRecipients } from "../../../utils/recipients.ts";

/**
 * Per-recipient unsubscribe tokens (#249).
 *
 * A token names one sent email and its one recipient, so the RFC 8058
 * one-click POST (whose body is only `List-Unsubscribe=One-Click`) and the
 * `unsub+<token>@<domain>` mailto can tell who asked to leave. Stateless:
 * nothing is stored per token. It is valid for as long as the email row
 * exists, and it verifies only against that row.
 *
 * Layout: `<email id hex>.<MAC>`.
 *
 * - The email id is `msg_` plus 24 lowercase hex characters
 *   (`generateId`); the token carries the hex part only.
 * - The MAC is HMAC-SHA256 over
 *   `unsubscribe:v1:<email id>:<lowercased recipient>`, truncated to 128
 *   bits (32 hex characters). The prefix separates it from any other HMAC
 *   made with a key from the same master. The sending API key is not part
 *   of it: the token verifies only against its own email row, and that row
 *   fixes the key, so the key adds nothing an attacker could vary.
 * - Lowercase hex only: a receiving MTA may fold the case of a local part,
 *   and a token read back in any case still verifies.
 * - `unsub+` plus the token is 63 characters, inside the 64 a local part
 *   may have (RFC 5321 section 4.5.3.1.1).
 *
 * The key is derived with HKDF-SHA256 from `DKIM_ENCRYPTION_KEY` under a
 * fixed label, so no new secret has to be configured. Rotating
 * `DKIM_ENCRYPTION_KEY` therefore invalidates every unsubscribe link
 * already sent (SECURITY.md, Rotation).
 */

/** HKDF `info` label: binds the derived key to this one use. */
const KEY_INFO = "bunmail unsubscribe token v1";

/** Domain-separation prefix of the MAC input. */
const MAC_CONTEXT = "unsubscribe:v1";

/** MAC length kept, in bytes (128 bits, 32 hex characters). */
const MAC_BYTES = 16;

/** The id shape a token can carry: what `generateId("msg")` produces. */
const EMAIL_ID_RE = /^msg_([0-9a-f]{24})$/;

/** A whole token, lowercase. */
const TOKEN_RE = /^([0-9a-f]{24})\.([0-9a-f]{32})$/;

/** Length of every well-formed token: 24 + 1 + 32. */
export const UNSUBSCRIBE_TOKEN_LENGTH = 57;

/** Local-part prefix of the per-recipient unsubscribe mailbox. */
export const UNSUBSCRIBE_LOCAL_PREFIX = "unsub+";

/** `unsub+<token>@domain`, case-insensitive; captures the token. */
const UNSUBSCRIBE_ADDRESS_RE = /^unsub\+([^@]+)@/i;

/** What a token names: one email and its one recipient. */
export interface UnsubscribeTokenSubject {
  emailId: string;
  recipient: string;
}

/** Derives the token key from a master key (exported for the rotation test). */
export function deriveUnsubscribeKey(master: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), KEY_INFO, 32));
}

/** The key derived from `DKIM_ENCRYPTION_KEY`, computed once. */
let configuredKey: Buffer | null = null;

function defaultKey(): Buffer {
  configuredKey ??= deriveUnsubscribeKey(config.dkimEncryptionKey);
  return configuredKey;
}

/** The truncated MAC of a subject. */
function computeMac(subject: UnsubscribeTokenSubject, key: Buffer): Buffer {
  const input = [
    MAC_CONTEXT,
    subject.emailId,
    subject.recipient.trim().toLowerCase(),
  ].join(":");
  return createHmac("sha256", key).update(input).digest().subarray(0, MAC_BYTES);
}

/**
 * The token for a subject, or `null` when the email id is not in the
 * `msg_<24 hex>` shape (a row written some other way gets no token, and
 * its mail keeps the static unsubscribe headers).
 */
export function mintUnsubscribeToken(
  subject: UnsubscribeTokenSubject,
  key: Buffer = defaultKey(),
): string | null {
  const match = EMAIL_ID_RE.exec(subject.emailId);
  if (!match) return null;
  return `${match[1]}.${computeMac(subject, key).toString("hex")}`;
}

/**
 * Splits a presented token into the email id it names and its MAC, or
 * `null` when it is malformed. Case-insensitive; the length is checked
 * before the pattern so an oversized value is never scanned.
 */
export function parseUnsubscribeToken(
  token: string,
): { emailId: string; mac: Buffer } | null {
  if (token.length !== UNSUBSCRIBE_TOKEN_LENGTH) return null;
  const match = TOKEN_RE.exec(token.toLowerCase());
  if (!match?.[1] || !match[2]) return null;
  return { emailId: `msg_${match[1]}`, mac: Buffer.from(match[2], "hex") };
}

/** True when `presented` is the MAC of `subject`. Constant time. */
export function unsubscribeMacMatches(
  subject: UnsubscribeTokenSubject,
  presented: Buffer,
  key: Buffer = defaultKey(),
): boolean {
  const expected = computeMac(subject, key);
  return presented.length === expected.length && timingSafeEqual(expected, presented);
}

/**
 * The one address a token may name, lowercased: the email's only
 * recipient, and only when it has no cc and no bcc. All recipients of a
 * message share one `List-Unsubscribe` header, so a token on a message
 * with cc or bcc would let any of them unsubscribe the `to` address.
 * `null` means the email gets no token.
 */
export function soleRecipient(
  to: string,
  cc: string | null | undefined,
  bcc: string | null | undefined,
): string | null {
  if ((cc ?? "").trim() !== "" || (bcc ?? "").trim() !== "") return null;
  const recipients = parseRecipients(to, null, null);
  const only = recipients.length === 1 ? recipients[0] : undefined;
  return only ? only.address.toLowerCase() : null;
}

/** The mailto local part that carries a token. */
export function unsubscribeLocalPart(token: string): string {
  return `${UNSUBSCRIBE_LOCAL_PREFIX}${token}`;
}

/**
 * The token in an `unsub+<token>@domain` address, or `null` when the
 * address is not one (any case). The token itself is checked later.
 */
export function tokenFromUnsubscribeAddress(address: string): string | null {
  return UNSUBSCRIBE_ADDRESS_RE.exec(address)?.[1] ?? null;
}
