import { randomBytes } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { withSanitizedErrors } from "../errors.ts";
import { users } from "../models/user.schema.ts";
import { hasTotpCredential, userCredentials } from "../models/user-credential.schema.ts";
import type { LoginResult, SessionAssurance } from "../types/user.types.ts";
import { hashPassword, verifyPassword } from "./password.service.ts";
import { normalizeLoginEmail } from "./session-policy.service.ts";

/**
 * First-factor step of the dashboard login (#216): email and password
 * checked against `user_credentials`.
 *
 * No account enumeration, by response or by timing: every branch runs
 * exactly one argon2id verify. A missing user or a user without a password
 * is verified against a dummy hash made by the same `hashPassword`, so the
 * cost parameters match; a disabled user verifies the real hash and then
 * fails. The caller answers every failure identically and logs the
 * reason server-side only.
 *
 * Database errors leave this module as `UserStoreError` (SQLSTATE only):
 * drizzle's message would carry the email in its params.
 */

/** The credential type this step checks. */
const PASSWORD_CREDENTIAL = "password";

/**
 * The dummy argon2id hash for accounts that do not exist or have no
 * password. Made lazily, once per process, from random input nobody
 * knows, so it can never verify.
 */
let dummyHash: Promise<string> | null = null;

/** Returns the memoized dummy hash, creating it on first use. */
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(32).toString("base64url"));
  return dummyHash;
}

/**
 * The assurance a session gets after the password step: `pending` for an
 * account with a TOTP second factor (#220), whose login route then sends
 * the browser to the second step instead of the dashboard; `password`
 * otherwise. The single place that decision lives.
 */
function firstFactorAssurance(hasTotp: boolean): SessionAssurance {
  return hasTotp ? "pending" : "password";
}

/**
 * Checks an email and password. The email is normalized the way
 * `users.email` stores it; the caller has already enforced the length
 * bounds (`loginInputTooLong`).
 *
 * On success, `user_credentials.last_used_at` is updated.
 */
export async function verifyPasswordLogin(
  email: string,
  password: string,
): Promise<LoginResult> {
  const normalized = normalizeLoginEmail(email);
  const [row] = await withSanitizedErrors(() =>
    db
      .select({
        userId: users.id,
        disabledAt: users.disabledAt,
        credentialId: userCredentials.id,
        secretHash: userCredentials.secretHash,
        hasTotp: hasTotpCredential(users.id),
      })
      .from(users)
      .leftJoin(
        userCredentials,
        and(
          eq(userCredentials.userId, users.id),
          eq(userCredentials.type, PASSWORD_CREDENTIAL),
        ),
      )
      .where(eq(users.email, normalized))
      .limit(1),
  );

  /** Exactly one verify on every branch, against the real or the dummy hash. */
  const storedHash = row?.secretHash ?? null;
  const verified = await verifyPassword(password, storedHash ?? (await getDummyHash()));

  if (!row) return { ok: false, reason: "unknown" };
  const { userId } = row;
  if (row.disabledAt !== null) return { ok: false, reason: "disabled", userId };
  if (storedHash === null || row.credentialId === null) {
    return { ok: false, reason: "no_password", userId };
  }
  if (!verified) return { ok: false, reason: "bad_password", userId };

  const credentialId = row.credentialId;
  await withSanitizedErrors(() =>
    db
      .update(userCredentials)
      .set({ lastUsedAt: sql`now()` })
      .where(eq(userCredentials.id, credentialId)),
  );

  return {
    ok: true,
    userId: row.userId,
    assurance: firstFactorAssurance(row.hasTotp),
    credentialId,
  };
}
