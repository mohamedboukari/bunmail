import { createHash, randomBytes } from "crypto";

/**
 * Opaque tokens for sessions and one-time links (#214). A token is 32
 * random bytes (256 bits), sent to the user as base64url; only its SHA-256
 * hash is stored (`sessions.token_hash`, `user_tokens.token_hash`), so a
 * database leak does not yield usable tokens. Lookups hash the presented
 * token and compare hashes, which also keeps the stored column fixed-width.
 *
 * Pure: no I/O, no config.
 */

/** A freshly minted token and the hash to store for it. */
export interface MintedToken {
  /** Give this to the user (cookie value or link); never store it. */
  token: string;
  /** Store this; look the token up by it. */
  hash: string;
}

/** SHA-256 of a presented token, hex, as stored in the `token_hash` columns. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Mints a new random token and its storage hash. */
export function mintToken(): MintedToken {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

/**
 * The exact shape `mintToken()` produces: 32 random bytes as base64url
 * without padding, which is always 43 characters.
 */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * True when `value` has the shape of a minted token. Callers check this
 * before any database call, so a malformed value (or a legacy `<ts>.<hmac>`
 * session cookie from before #216) never costs a query.
 */
export function isWellFormedToken(value: string): boolean {
  return TOKEN_RE.test(value);
}
