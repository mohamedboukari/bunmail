import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

/**
 * Versioned prefix for the encrypted-secret string format. Bumping this
 * (and updating `decryptSecret` to dispatch on it) is how we'd ship a
 * future algorithm change or KDF without breaking existing rows.
 */
const SECRET_VERSION_PREFIX = "v1";

/** AES-256-GCM IV length in bytes — NIST SP 800-38D recommendation. */
const GCM_IV_BYTES = 12;

/** AES-256-GCM auth tag length — default for `crypto`'s GCM mode. */
const GCM_TAG_BYTES = 16;

/** Required key length for AES-256. */
const AES_256_KEY_BYTES = 32;

/**
 * Heuristic check that a stored secret has been run through `encryptSecret`.
 * Used by the boot-time migrator to skip rows that are already encrypted
 * and by the read path to detect legacy plaintext rows during the upgrade
 * window. The check is structural — values matching the
 * `<version>:<iv>:<ct>:<tag>` shape are treated as encrypted.
 */
export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(`${SECRET_VERSION_PREFIX}:`) && value.split(":").length === 4;
}

/**
 * Encrypts a UTF-8 plaintext (e.g. a PEM-encoded DKIM private key) using
 * AES-256-GCM and returns a self-describing string of the form
 * `v1:<base64-iv>:<base64-ciphertext>:<base64-tag>`.
 *
 * - **Authenticated:** GCM emits a 16-byte tag verified at decrypt time;
 *   tampering with the ciphertext yields a decrypt error rather than a
 *   silently-forged plaintext.
 * - **Random IV per call:** 12 bytes from `randomBytes`. Two encryptions
 *   of the same plaintext produce different ciphertexts.
 * - **Versioned:** the `v1:` prefix lets a future PR introduce `v2:` (new
 *   algorithm or key-derivation scheme) without breaking existing rows.
 *
 * @param plaintext - Raw secret to encrypt (PEM, password, etc.)
 * @param key - 32-byte AES-256 key. Throws if the wrong length is passed.
 */
export function encryptSecret(plaintext: string, key: Buffer): string {
  if (key.length !== AES_256_KEY_BYTES) {
    throw new Error(
      `[crypto] encryptSecret requires a ${AES_256_KEY_BYTES}-byte key, got ${key.length}`,
    );
  }
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    SECRET_VERSION_PREFIX,
    iv.toString("base64"),
    ciphertext.toString("base64"),
    tag.toString("base64"),
  ].join(":");
}

/**
 * Inverse of `encryptSecret`. Throws on:
 *   - malformed input (wrong number of segments / unknown version)
 *   - wrong key (GCM tag verification fails)
 *   - tampered ciphertext (also a tag failure)
 *
 * Callers should treat any thrown error as "this secret is unrecoverable
 * with the current key" — for DKIM that means falling back to unsigned
 * mail rather than silently failing the send.
 */
export function decryptSecret(encrypted: string, key: Buffer): string {
  if (key.length !== AES_256_KEY_BYTES) {
    throw new Error(
      `[crypto] decryptSecret requires a ${AES_256_KEY_BYTES}-byte key, got ${key.length}`,
    );
  }
  const parts = encrypted.split(":");
  if (parts.length !== 4) {
    throw new Error("[crypto] Encrypted secret has wrong segment count");
  }
  const [version, ivB64, ctB64, tagB64] = parts as [string, string, string, string];
  if (version !== SECRET_VERSION_PREFIX) {
    throw new Error(`[crypto] Unknown encrypted-secret version "${version}"`);
  }
  const iv = Buffer.from(ivB64, "base64");
  const ciphertext = Buffer.from(ctB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  if (iv.length !== GCM_IV_BYTES) {
    throw new Error(
      `[crypto] Encrypted secret has wrong IV length (${iv.length}, expected ${GCM_IV_BYTES})`,
    );
  }
  if (tag.length !== GCM_TAG_BYTES) {
    throw new Error(
      `[crypto] Encrypted secret has wrong tag length (${tag.length}, expected ${GCM_TAG_BYTES})`,
    );
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

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
