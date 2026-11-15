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
 * - **Click (v2, #424):** `<email id hex>.<link position>.<base64url(url)>.<domain id hex>.<epoch>.<MAC>`,
 *   the MAC over `click:v2:<email id>:<position>:<domain id>:<epoch>:<url>`.
 *   The target is bound to the email by the MAC, so only URLs BunMail
 *   signed for that email can be redirected to (no open redirect). The
 *   MAC also covers the sender domain and its tracking epoch
 *   (`domains.tracking_epoch`): the redirect compares that epoch with the
 *   domain's current one, so an admin revokes every click link of a
 *   domain by bumping it, and a link of a deleted domain stops working.
 *   It needs no email row, so it still works once the email is purged.
 * - **Click (v1, before #424):** `<email id hex>.<link position>.<base64url(url)>.<MAC>`,
 *   the MAC over `click:v1:<email id>:<position>:<url>`. Still verified,
 *   never minted: the redirect finds its domain through the email row and
 *   honours it only while that domain is at epoch 0, so a v1 link stops
 *   working at the first bump, and at once when its email is purged.
 *
 * Only `http:` and `https:` URLs in their canonical form
 * (`new URL(url).href`) of at most 2048 characters are ever signed or
 * accepted. A new field (an expiry, say) would be a new version, told
 * apart by its number of parts like v1 and v2.
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
const CLICK_V2_MAC_CONTEXT = "click:v2";

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

/** A whole v1 click token (before #424): hex id, position, base64url URL, hex MAC. */
const CLICK_TOKEN_RE =
  /^([0-9a-f]{24})\.(0|[1-9][0-9]?)\.([A-Za-z0-9_-]+)\.([0-9a-f]{32})$/;

/** A whole v2 click token (#424): hex id, position, base64url URL, hex domain id, epoch, hex MAC. */
const CLICK_V2_TOKEN_RE =
  /^([0-9a-f]{24})\.(0|[1-9][0-9]?)\.([A-Za-z0-9_-]+)\.([0-9a-f]{24})\.(0|[1-9][0-9]{0,9})\.([0-9a-f]{32})$/;

/** The domain id shape a v2 click token can carry: what `generateId("dom")` produces. */
const DOMAIN_ID_RE = /^dom_([0-9a-f]{24})$/;

/** Highest tracking epoch: the largest Postgres `integer`. */
export const MAX_TRACKING_EPOCH = 2_147_483_647;

/**
 * Longest well-formed click token, a v2 one: id, position, the base64url
 * of the longest URL, domain id, epoch, MAC.
 */
const MAX_CLICK_TOKEN_LENGTH =
  24 + 1 + 2 + 1 + Math.ceil((MAX_TRACKED_URL_LENGTH * 4) / 3) + 1 + 24 + 1 + 10 + 1 + 32;

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

/** The sender domain and its tracking epoch a click token is minted under (#424). */
export interface ClickTokenDomain {
  /** `dom_<24 hex>`. */
  domainId: string;
  /** `domains.tracking_epoch` when the link was minted, 0 to {@link MAX_TRACKING_EPOCH}. */
  epoch: number;
}

/**
 * A verified click token. `version: 2` (#424) names its domain and epoch,
 * still to be compared with the domain's current epoch; `version: 1` is a
 * link sent before #424, whose domain only the email row tells.
 */
export type VerifiedClickToken =
  | (ClickTokenSubject & { version: 1 })
  | (ClickTokenSubject & ClickTokenDomain & { version: 2 });

function legacyClickMac(subject: ClickTokenSubject, key: Buffer): Buffer {
  return mac(key, [
    CLICK_MAC_CONTEXT,
    subject.emailId,
    String(subject.position),
    subject.url,
  ]);
}

/**
 * The v2 MAC: the domain and the epoch come before the URL, so the input
 * splits one way only (the URL is the only part that can hold a `:`).
 */
function clickMac(
  subject: ClickTokenSubject,
  domain: ClickTokenDomain,
  key: Buffer,
): Buffer {
  return mac(key, [
    CLICK_V2_MAC_CONTEXT,
    subject.emailId,
    String(subject.position),
    domain.domainId,
    String(domain.epoch),
    subject.url,
  ]);
}

/** Whether `epoch` is a tracking epoch a token may carry. */
function validEpoch(epoch: number): boolean {
  return Number.isInteger(epoch) && epoch >= 0 && epoch <= MAX_TRACKING_EPOCH;
}

/**
 * The click token for a subject under its domain's current epoch, or
 * `null` when it cannot be tracked: an email id that is not
 * `msg_<24 hex>`, a position outside 0 to 99, a URL
 * {@link trackableUrl} refuses, a domain id that is not `dom_<24 hex>`
 * or an epoch out of range.
 */
export function mintClickToken(
  subject: ClickTokenSubject,
  domain: ClickTokenDomain,
  keys: TrackingKeys = defaultKeys(),
): string | null {
  const match = EMAIL_ID_RE.exec(subject.emailId);
  const domainMatch = DOMAIN_ID_RE.exec(domain.domainId);
  if (!match || !domainMatch) return null;
  if (
    !Number.isInteger(subject.position) ||
    subject.position < 0 ||
    subject.position >= MAX_TRACKED_LINKS
  ) {
    return null;
  }
  if (!validEpoch(domain.epoch)) return null;
  if (trackableUrl(subject.url) === null) return null;
  const encoded = Buffer.from(subject.url, "utf8").toString("base64url");
  const tag = clickMac(subject, domain, keys.click).toString("hex");
  return `${match[1]}.${subject.position}.${encoded}.${domainMatch[1]}.${domain.epoch}.${tag}`;
}

/** The URL of a token's base64url part, when it is the one canonical encoding of a trackable URL. */
function decodeTokenUrl(encoded: string): string | null {
  const bytes = Buffer.from(encoded, "base64url");
  /** Only the one canonical encoding: no padding tricks, no ignored characters. */
  if (bytes.toString("base64url") !== encoded) return null;
  return trackableUrl(bytes.toString("utf8"));
}

/**
 * Verifies a presented click token and returns what it names, or `null`
 * for every kind of failure: too long, malformed, a URL that does not
 * decode canonically or is not trackable, a MAC that does not match.
 * Needs no database: the MAC binds the URL to the email id (and, in a v2
 * token, to the domain and epoch). The epoch still has to be compared
 * with the domain's current one (`tracking-epoch.service.ts`).
 */
export function verifyClickToken(
  token: string,
  keys: TrackingKeys = defaultKeys(),
): VerifiedClickToken | null {
  if (token.length > MAX_CLICK_TOKEN_LENGTH) return null;
  const v2 = CLICK_V2_TOKEN_RE.exec(token);
  if (v2?.[1] && v2[2] && v2[3] && v2[4] && v2[5] && v2[6]) {
    const url = decodeTokenUrl(v2[3]);
    if (url === null) return null;
    const subject: ClickTokenSubject = {
      emailId: `msg_${v2[1]}`,
      position: Number(v2[2]),
      url,
    };
    const domain: ClickTokenDomain = { domainId: `dom_${v2[4]}`, epoch: Number(v2[5]) };
    if (!validEpoch(domain.epoch)) return null;
    return macEquals(clickMac(subject, domain, keys.click), Buffer.from(v2[6], "hex"))
      ? { ...subject, ...domain, version: 2 }
      : null;
  }
  const v1 = CLICK_TOKEN_RE.exec(token);
  if (!v1?.[1] || !v1[2] || !v1[3] || !v1[4]) return null;
  const url = decodeTokenUrl(v1[3]);
  if (url === null) return null;
  const subject: ClickTokenSubject = {
    emailId: `msg_${v1[1]}`,
    position: Number(v1[2]),
    url,
  };
  return macEquals(legacyClickMac(subject, keys.click), Buffer.from(v1[4], "hex"))
    ? { ...subject, version: 1 }
    : null;
}
