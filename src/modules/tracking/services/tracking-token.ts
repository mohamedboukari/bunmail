import { createHmac, hkdfSync, timingSafeEqual } from "crypto";
import { config } from "../../../config.ts";

/**
 * Open and click tracking tokens (#187), built like the unsubscribe
 * tokens (`unsubscribe-token.ts`): stateless, HMAC-SHA256 truncated to
 * 128 bits, each with its own key derived by HKDF-SHA256 from
 * `DKIM_ENCRYPTION_KEY` under a fixed label, so no new secret is needed.
 * Rotating `DKIM_ENCRYPTION_KEY` therefore breaks every tracking link
 * already sent (SECURITY.md, Rotation). Deterministic: a retry of an
 * email carries the same tokens, so its body (and DKIM body hash) is the
 * same.
 *
 * - **Open:** `<email id hex>.<MAC>`, the MAC over `open:v1:<email id>`.
 *   It verifies without the database, so an invalid token is refused (and
 *   rate limited) before any query, and a response never tells whether an
 *   email exists. The email row, which has one recipient (only such mail
 *   is tracked), fixes who the event belongs to.
 * - **Click:** `<email id hex>.<link position>.<base64url(url)>.<MAC>`,
 *   the MAC over `click:v1:<email id>:<position>:<url>`. The target is
 *   bound to the email by the MAC, so only URLs BunMail signed for that
 *   email can be redirected to (no open redirect), and the link still
 *   works once the email is purged. Only `http:` and `https:` URLs in
 *   their canonical form (`new URL(url).href`) of at most 2048 characters
 *   are ever signed or accepted.
 *
 * The two kinds use different keys and different MAC prefixes, so an open
 * token can never pass as a click token, or the other way round, and
 * neither can pass as an unsubscribe token.
 */

/** HKDF labels: one key per use. */
const OPEN_KEY_INFO = "bunmail open token v1";
const CLICK_KEY_INFO = "bunmail click token v1";

/** Domain-separation prefixes of the MAC inputs. */
const OPEN_MAC_CONTEXT = "open:v1";
const CLICK_MAC_CONTEXT = "click:v1";

/** MAC length kept, in bytes (128 bits, 32 hex characters). */
const MAC_BYTES = 16;

/** Longest URL signed or accepted, in characters. */
export const MAX_TRACKED_URL_LENGTH = 2048;

/** Most links rewritten in one email: positions are 0 to 99. */
export const MAX_TRACKED_LINKS = 100;

/** The id shape a token can carry: what `generateId("msg")` produces. */
const EMAIL_ID_RE = /^msg_([0-9a-f]{24})$/;

/** A whole open token, lowercase. */
const OPEN_TOKEN_RE = /^([0-9a-f]{24})\.([0-9a-f]{32})$/;

/** Length of every well-formed open token: 24 + 1 + 32. */
const OPEN_TOKEN_LENGTH = 57;

/** A whole click token: hex id, position, base64url URL, hex MAC. */
const CLICK_TOKEN_RE =
  /^([0-9a-f]{24})\.(0|[1-9][0-9]?)\.([A-Za-z0-9_-]+)\.([0-9a-f]{32})$/;

/** Longest well-formed click token: id, position, the base64url of the longest URL, MAC. */
const MAX_CLICK_TOKEN_LENGTH =
  24 + 1 + 2 + 1 + Math.ceil((MAX_TRACKED_URL_LENGTH * 4) / 3) + 1 + 32;

/** The two token keys, derived from one master key. */
export interface TrackingKeys {
  open: Buffer;
  click: Buffer;
}

/** Derives both token keys from a master key (exported for tests). */
export function deriveTrackingKeys(master: Buffer): TrackingKeys {
  const derive = (info: string): Buffer =>
    Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), info, 32));
  return { open: derive(OPEN_KEY_INFO), click: derive(CLICK_KEY_INFO) };
}

/** The keys derived from `DKIM_ENCRYPTION_KEY`, computed once. */
let configuredKeys: TrackingKeys | null = null;

function defaultKeys(): TrackingKeys {
  configuredKeys ??= deriveTrackingKeys(config.dkimEncryptionKey);
  return configuredKeys;
}

/** The truncated HMAC of `parts`, joined with `:`. */
function mac(key: Buffer, parts: readonly string[]): Buffer {
  return createHmac("sha256", key)
    .update(parts.join(":"))
    .digest()
    .subarray(0, MAC_BYTES);
}

/** Constant-time comparison of a presented MAC with the expected one. */
function macEquals(expected: Buffer, presented: Buffer): boolean {
  return presented.length === expected.length && timingSafeEqual(expected, presented);
}

/**
 * `url` when it may be tracked: an `http:` or `https:` URL, already in its
 * canonical form (`new URL(url).href`), of at most
 * {@link MAX_TRACKED_URL_LENGTH} characters. `null` otherwise
 * (`javascript:`, `data:`, relative, too long, not canonical).
 */
export function trackableUrl(url: string): string | null {
  if (url.length === 0 || url.length > MAX_TRACKED_URL_LENGTH) return null;
  if (!URL.canParse(url)) return null;
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.href === url ? url : null;
}

/* ─── Open ─── */

function openMac(emailId: string, key: Buffer): Buffer {
  return mac(key, [OPEN_MAC_CONTEXT, emailId]);
}

/** The open token of an email, or `null` when its id is not `msg_<24 hex>`. */
export function mintOpenToken(
  emailId: string,
  keys: TrackingKeys = defaultKeys(),
): string | null {
  const match = EMAIL_ID_RE.exec(emailId);
  if (!match) return null;
  return `${match[1]}.${openMac(emailId, keys.open).toString("hex")}`;
}

/**
 * Verifies a presented open token and returns the email id it names, or
 * `null` when it is malformed or its MAC does not match. No database:
 * case-insensitive, the length checked before the pattern, the MAC
 * compared in constant time.
 */
export function verifyOpenToken(
  token: string,
  keys: TrackingKeys = defaultKeys(),
): string | null {
  if (token.length !== OPEN_TOKEN_LENGTH) return null;
  const match = OPEN_TOKEN_RE.exec(token.toLowerCase());
  if (!match?.[1] || !match[2]) return null;
  const emailId = `msg_${match[1]}`;
  return macEquals(openMac(emailId, keys.open), Buffer.from(match[2], "hex"))
    ? emailId
    : null;
}

/* ─── Click ─── */

/** What a click token names: one link of one email. */
export interface ClickTokenSubject {
  emailId: string;
  /** The link's position among the email's rewritten links, 0 to 99. */
  position: number;
  /** The target, canonical (see {@link trackableUrl}). */
  url: string;
}

function clickMac(subject: ClickTokenSubject, key: Buffer): Buffer {
  return mac(key, [
    CLICK_MAC_CONTEXT,
    subject.emailId,
    String(subject.position),
    subject.url,
  ]);
}

/**
 * The click token for a subject, or `null` when it cannot be tracked: an
 * email id that is not `msg_<24 hex>`, a position outside 0 to 99, or a
 * URL {@link trackableUrl} refuses.
 */
export function mintClickToken(
  subject: ClickTokenSubject,
  keys: TrackingKeys = defaultKeys(),
): string | null {
  const match = EMAIL_ID_RE.exec(subject.emailId);
  if (!match) return null;
  if (
    !Number.isInteger(subject.position) ||
    subject.position < 0 ||
    subject.position >= MAX_TRACKED_LINKS
  ) {
    return null;
  }
  if (trackableUrl(subject.url) === null) return null;
  const encoded = Buffer.from(subject.url, "utf8").toString("base64url");
  return `${match[1]}.${subject.position}.${encoded}.${clickMac(subject, keys.click).toString("hex")}`;
}

/**
 * Verifies a presented click token and returns what it names, or `null`
 * for every kind of failure: too long, malformed, a URL that does not
 * decode canonically or is not trackable, a MAC that does not match.
 * Needs no database: the MAC binds the URL to the email id.
 */
export function verifyClickToken(
  token: string,
  keys: TrackingKeys = defaultKeys(),
): ClickTokenSubject | null {
  if (token.length > MAX_CLICK_TOKEN_LENGTH) return null;
  const match = CLICK_TOKEN_RE.exec(token);
  if (!match?.[1] || !match[2] || !match[3] || !match[4]) return null;
  const encoded = match[3];
  const bytes = Buffer.from(encoded, "base64url");
  /** Only the one canonical encoding: no padding tricks, no ignored characters. */
  if (bytes.toString("base64url") !== encoded) return null;
  const url = trackableUrl(bytes.toString("utf8"));
  if (url === null) return null;
  const subject: ClickTokenSubject = {
    emailId: `msg_${match[1]}`,
    position: Number(match[2]),
    url,
  };
  return macEquals(clickMac(subject, keys.click), Buffer.from(match[4], "hex"))
    ? subject
    : null;
}
