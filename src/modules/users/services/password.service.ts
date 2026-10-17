/**
 * Password hashing for dashboard accounts (#214), on Bun's built-in
 * `Bun.password`: argon2id, the current recommendation, with a per-hash
 * random salt and the parameters encoded in the hash string, so they can
 * be raised later and old hashes still verify. No new dependency.
 *
 * Pure: no I/O, no config. Password policy (length, breach checks) belongs
 * to the login and invite flows (#216, #217), not here.
 */

/** Hashes a password for storage in `user_credentials.secret_hash`. */
// Consumed by the login and invite flows (#216, #217); exported ahead of them.
/** @public */
export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

/**
 * Checks a password against a stored hash. Constant-time inside Bun; a
 * malformed hash yields `false` rather than throwing, so a corrupt row
 * cannot turn into a 500 on the login form.
 */
/** @public */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}
