import { createHash, randomBytes } from "crypto";

/**
 * SHA-256 hash of a raw API key string.
 * Used both at key creation (to store the hash) and at auth time
 * (to look up the incoming Bearer token in the DB).
 *
 * @param raw - The plaintext API key (e.g. "bm_live_abc123...")
 * @returns Hex-encoded SHA-256 hash
 */
export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Generates a new API key with the format `bm_live_<32 hex chars>`.
 *
 * Returns three values:
 * - `raw`    — The full plaintext key (shown to the user once, never stored)
 * - `hash`   — SHA-256 of the raw key (stored in `api_keys.key_hash`)
 * - `prefix` — First 12 chars of the raw key (stored for identification)
 *
 * 16 random bytes = 32 hex chars = ~128 bits of entropy.
 */
export function generateApiKey(): { raw: string; hash: string; prefix: string } {
  /** 16 random bytes → 32 hex characters of entropy */
  const random = randomBytes(16).toString("hex");

  /** Full raw key: bm_live_ prefix + random hex */
  const raw = `bm_live_${random}`;

  /** SHA-256 hash of the raw key — this is what we store in the DB */
  const hash = hashApiKey(raw);

  /** First 12 chars of the raw key — helps users identify which key is which */
  const prefix = raw.slice(0, 12);

  return { raw, hash, prefix };
}
