/**
 * Password hashing for dashboard accounts (#214), on Bun's built-in
 * `Bun.password`: argon2id, the current recommendation, with a per-hash
 * random salt and the parameters encoded in the hash string, so they can
 * be raised later and old hashes still verify. No new dependency.
 *
 * Pure: no I/O, no config. Password policy (length, breach checks) belongs
 * to the login and invite flows (#216, #217), not here.
 */

/**
 * Hashes a password for storage in `user_credentials.secret_hash`.
 * Consumed by the login and invite flows (#216, #217); exported ahead of them.
 */
/** @public */
export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

/** Hash strings `Bun.password.verify` understands (argon2 variants, bcrypt). */
const SUPPORTED_HASH_RE = /^\$(?:argon2(?:id|i|d)|2[abxy])\$/;

/**
 * Checks a password against a stored hash. Constant-time inside Bun for a
 * well-formed hash. A stored value that is not a supported hash (a corrupt
 * or legacy row) yields `false` instead of throwing, so it cannot turn into
 * a 500 on the login form; any other error is a programming error and
 * propagates rather than being reported as "wrong password".
 */
/** @public */
export function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (!SUPPORTED_HASH_RE.test(hash)) return Promise.resolve(false);
  return Bun.password.verify(password, hash);
}
