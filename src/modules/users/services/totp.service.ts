import { createHmac, randomBytes, timingSafeEqual } from "crypto";

/**
 * TOTP second factor (#220): RFC 6238 time-based one-time passwords on
 * top of RFC 4226 HOTP, built on Node's `crypto` (HMAC-SHA1), with no
 * dependency. Pure: no I/O, no config, no clock of its own (every
 * function that needs the time takes it).
 *
 * The parameters are the ones every authenticator app supports and
 * assumes when the `otpauth://` URI leaves them out: SHA-1, 6 digits,
 * 30-second steps. SHA-1 is fine here: HOTP relies on HMAC-SHA1, whose
 * security does not depend on SHA-1 collision resistance (RFC 4226,
 * Appendix A.4).
 */

/** Digits in a code. */
export const TOTP_DIGITS = 6;

/** Length of a time step in seconds (RFC 6238 `X`). */
export const TOTP_STEP_SECONDS = 30;

/**
 * Steps accepted on either side of the current one: a code from the
 * previous or the next 30 seconds still works, for clock drift and typing
 * time. Wider windows make guessing easier for no real benefit.
 */
export const TOTP_WINDOW_STEPS = 1;

/** Secret length in bytes: 160 bits, the HMAC-SHA1 output size (RFC 4226 recommends at least 128). */
export const TOTP_SECRET_BYTES = 20;

/** The issuer shown in the authenticator app. */
export const TOTP_ISSUER = "BunMail";

/** RFC 4648 base32 alphabet. */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Base32-encodes bytes (RFC 4648, upper case, no `=` padding), the
 * format authenticator apps expect for the secret.
 */
export function base32Encode(bytes: Uint8Array): string {
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    /** Keep only the bits not emitted yet, so the number never grows past 12 bits. */
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return output;
}

/**
 * Decodes RFC 4648 base32 (case-insensitive, no padding, no separators).
 * Returns `null` for any character outside the alphabet, for a length no
 * encoder produces (1, 3 or 6 characters past a multiple of 8), and for
 * non-zero leftover bits, so `base32Encode(base32Decode(x)) === x` holds
 * for every accepted upper-case `x`.
 */
export function base32Decode(text: string): Buffer | null {
  const upper = text.toUpperCase();
  const remainder = upper.length % 8;
  if (remainder === 1 || remainder === 3 || remainder === 6) return null;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of upper) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value === -1) return null;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
    buffer &= (1 << bits) - 1;
  }
  if (buffer !== 0) return null;
  return Buffer.from(bytes);
}

/**
 * RFC 4226 HOTP: HMAC-SHA1 of the 8-byte big-endian counter, dynamic
 * truncation, the last `digits` decimal digits, zero-padded.
 */
export function hotp(
  key: Uint8Array,
  counter: number,
  digits: number = TOTP_DIGITS,
): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", key).update(message).digest();
  /** The low 4 bits of the last byte pick where the 31-bit value starts. */
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** RFC 6238 time step `T` for a Unix time in milliseconds (T0 = 0). */
export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

/** The code for a time step. */
export function totpCode(
  key: Uint8Array,
  step: number,
  digits: number = TOTP_DIGITS,
): string {
  return hotp(key, step, digits);
}

/**
 * Compares two codes in constant time for equal lengths (a length
 * difference is not secret: every valid code has 6 digits).
 */
export function codesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Whether a submitted value has the shape of a TOTP code (6 digits, spaces ignored). */
export function looksLikeTotpCode(input: string): boolean {
  return /^\d{6}$/.test(input.replace(/\s+/g, ""));
}

/**
 * Finds the time step a code belongs to, within `TOTP_WINDOW_STEPS` of
 * `nowMs`, and newer than `lastStep` (the last step accepted for this
 * secret; `null` before the first). Every candidate step is computed and
 * compared, matched or not, so the time taken does not say which one
 * matched. Returns the step, or `null` when the code does not match a
 * usable step (wrong, too old, too far ahead, or already used: replay).
 *
 * The caller stores the returned step as the new `lastStep` with a
 * compare-and-swap, which is what makes a code single-use.
 */
export function matchTotpStep(
  key: Uint8Array,
  input: string,
  nowMs: number,
  lastStep: number | null,
): number | null {
  const code = input.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(code)) return null;
  const current = totpStep(nowMs);
  let matched: number | null = null;
  for (let delta = -TOTP_WINDOW_STEPS; delta <= TOTP_WINDOW_STEPS; delta += 1) {
    const step = current + delta;
    const equal = codesEqual(totpCode(key, step), code);
    const usable = lastStep === null || step > lastStep;
    if (equal && usable && matched === null) matched = step;
  }
  return matched;
}

/** A new random secret, base32-encoded: 20 random bytes, 32 characters. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(TOTP_SECRET_BYTES));
}

/**
 * The `otpauth://totp/...` URI an authenticator app scans (Google
 * Authenticator key URI format): `Issuer:account` as the label, the
 * secret, and the parameters spelled out. Rendered only into the QR code;
 * it holds the secret, so it never goes into a URL, a log or a page
 * attribute.
 */
export function otpauthUri(
  secret: string,
  account: string,
  issuer: string = TOTP_ISSUER,
): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** The secret in groups of four for typing it in by hand ("ABCD EFGH ..."). */
export function formatSecretForDisplay(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? []).join(" ");
}
