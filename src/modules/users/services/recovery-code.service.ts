import { createHash, randomBytes } from "crypto";
import { base32Encode } from "./totp.service.ts";

/**
 * TOTP recovery codes (#220). Pure: no I/O, no config.
 *
 * A code is 10 random bytes (80 bits) as 16 base32 characters, shown in
 * lower case in four groups (`abcd-efgh-ijkl-mnop`). Input is forgiving:
 * case, spaces and dashes do not matter. Only the SHA-256 of the
 * normalized form is stored: 80 random bits cannot be brute-forced from a
 * hash, so a slow password hash would only add cost.
 */

/** How many codes an account gets at enrolment and at every regeneration. */
export const RECOVERY_CODE_COUNT = 10;

/** Random bytes per code: 80 bits, exactly 16 base32 characters. */
const RECOVERY_CODE_BYTES = 10;

/** One new code for display: lower case, `xxxx-xxxx-xxxx-xxxx`. */
export function generateRecoveryCode(): string {
  const raw = base32Encode(randomBytes(RECOVERY_CODE_BYTES)).toLowerCase();
  return (raw.match(/.{4}/g) ?? []).join("-");
}

/** `RECOVERY_CODE_COUNT` new codes. */
export function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
}

/**
 * The stored form of a submitted code: spaces and dashes removed, upper
 * case, exactly 16 base32 characters. `null` when it cannot be a code.
 */
export function normalizeRecoveryCode(input: string): string | null {
  const compact = input.replace(/[\s-]+/g, "").toUpperCase();
  return /^[A-Z2-7]{16}$/.test(compact) ? compact : null;
}

/** SHA-256 (hex) of a normalized code: what `user_recovery_codes.code_hash` holds. */
export function hashRecoveryCode(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex");
}
