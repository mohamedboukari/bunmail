import { and, eq, sql } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { generateId } from "../../../utils/id.ts";
import { withSanitizedErrors } from "../errors.ts";
import { users } from "../models/user.schema.ts";
import { userCredentials } from "../models/user-credential.schema.ts";
import type {
  AttemptLimiter,
  ChangePasswordResult,
  PasswordChangeInput,
  SessionClient,
} from "../types/user.types.ts";
import { withOwnerLock } from "./owner.service.ts";
import { passwordChangeProblem } from "./password-change-policy.service.ts";
import { revokeResetLinks } from "./password-reset.service.ts";
import { hashPassword, verifyPassword } from "./password.service.ts";
import { createSession, revokeAllUserSessions } from "./session.service.ts";
import { locateSession } from "./session-location.service.ts";
import { sessionIp } from "./session-policy.service.ts";

/**
 * A signed-in user changing their own password (#279), from
 * `/dashboard/account/password`. Any role, the owner included.
 *
 * The current password is verified outside any lock, then the change is
 * applied in one transaction under the `bunmail:owner` lock (like a
 * password reset completion, an account action or the owner setup), with
 * a compare-and-swap on the verified credential: the old `password` row is
 * deleted only if it is still the very row (id and hash) that was just
 * verified. A reset an admin issued that completed in between replaced
 * that row, so the change is refused (`credential_changed`) instead of
 * overwriting the password the reset set; a reset that runs after the
 * change waits on the lock and then replaces the new password, as its
 * issuer intended. argon2id never runs while the lock is held.
 *
 * Never logs: the route logs the outcome with the client IP. Never
 * returns a password or a hash. Database errors leave this module as
 * `UserStoreError` (SQLSTATE only).
 */

/** The credential type a change replaces. */
const PASSWORD_CREDENTIAL = "password";

/** The account's `password` credential (id and hash), if it has one. */
async function passwordCredentialOf(
  userId: string,
): Promise<{ id: string; secretHash: string | null } | undefined> {
  const [row] = await withSanitizedErrors(() =>
    db
      .select({ id: userCredentials.id, secretHash: userCredentials.secretHash })
      .from(userCredentials)
      .where(
        and(
          eq(userCredentials.userId, userId),
          eq(userCredentials.type, PASSWORD_CREDENTIAL),
        ),
      )
      .limit(1),
  );
  return row;
}

/**
 * Changes the signed-in user's password. Order matters:
 *
 * 1. The failed-attempt budget (`limiter`, per account and per client IP,
 *    built by the route from the login limiter): over budget is refused
 *    (`rate_limited`) with no argon2id work.
 * 2. The form policy (`passwordChangeProblem`): a problem is refused
 *    (`invalid_input`) with no argon2id work and no attempt counted.
 * 3. The attempt is counted, with no await since step 1, so a parallel
 *    burst cannot run more verifies than the budget allows. It is not
 *    given back on a wrong password; a completed change clears the
 *    budget (a one-shot action, like the ownership transfer).
 * 4. Exactly one argon2id verify of the current password against the
 *    stored credential, outside the lock. Wrong (or no password):
 *    refused (`wrong_password`), nothing changes.
 * 5. The new password is hashed, still outside the lock.
 * 6. Under the owner lock, in one transaction: the account must still
 *    exist and be enabled (`account_inactive`); the verified credential
 *    must still be the same row with the same hash, locked
 *    (`credential_changed` otherwise); both refusals come before any
 *    write. Then every session of the account is deleted (this
 *    browser's, those bound to the old credential, and those bound to
 *    nothing or to another credential); the old credential is deleted
 *    (its cascade is a second path to the sessions bound to it) and the
 *    new one inserted; the account's open reset links are revoked; a
 *    fresh session bound to the new credential is opened for this
 *    browser; `users.updated_at` is touched.
 *
 * All or nothing: a failure inside the transaction rolls back every step.
 *
 * Only the `password` credential is replaced. Second factors (#220) are
 * not touched; once they ship, the session opened here must carry the
 * assurance of the session it replaces (an `mfa` session stays `mfa`),
 * not a fixed `password` level.
 *
 * @param client - Request metadata stored with the new session.
 */
export async function changePassword(
  input: PasswordChangeInput,
  limiter: AttemptLimiter,
  client: SessionClient = { ip: null, userAgent: null },
): Promise<ChangePasswordResult> {
  const { userId, current, password, confirm } = input;

  /** Steps 1 to 3: checked and counted with no await in between. */
  if (limiter.isLimited()) return { ok: false, reason: "rate_limited" };
  const problem = passwordChangeProblem(current, password, confirm);
  if (problem) return { ok: false, reason: "invalid_input", problem };
  limiter.record();

  const credential = await passwordCredentialOf(userId);
  const verifiedHash = credential?.secretHash ?? null;
  if (
    !credential ||
    verifiedHash === null ||
    !(await verifyPassword(current, verifiedHash))
  ) {
    return { ok: false, reason: "wrong_password" };
  }

  const secretHash = await hashPassword(password);

  const result = await withOwnerLock(async (tx): Promise<ChangePasswordResult> => {
    const [account] = await tx
      .select({ disabledAt: users.disabledAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!account || account.disabledAt !== null) {
      return { ok: false, reason: "account_inactive" };
    }

    /**
     * Compare-and-swap on the credential just verified: still the same row
     * with the same hash, locked until commit. Checked before any write,
     * so a refusal (which commits this transaction) leaves nothing behind.
     */
    const [unchanged] = await tx
      .select({ id: userCredentials.id })
      .from(userCredentials)
      .where(
        and(
          eq(userCredentials.id, credential.id),
          eq(userCredentials.userId, userId),
          eq(userCredentials.type, PASSWORD_CREDENTIAL),
          eq(userCredentials.secretHash, verifiedHash),
        ),
      )
      .for("update");
    if (!unchanged) return { ok: false, reason: "credential_changed" };

    /**
     * Every session of the account, this browser's included, before the
     * credential goes (so the count includes those bound to it): sessions
     * bound to no credential or to another one go too.
     */
    const sessionsRevoked = await revokeAllUserSessions(userId, tx);

    /**
     * Deleting the old credential also deletes, by cascade, any session
     * still bound to it (#277), and makes a login that verified the old
     * password a moment ago fail to open its session.
     */
    await tx.delete(userCredentials).where(eq(userCredentials.id, unchanged.id));
    const credentialId = generateId("crd");
    await tx.insert(userCredentials).values({
      id: credentialId,
      userId,
      type: PASSWORD_CREDENTIAL,
      secretHash,
    });

    const resetLinksRevoked = await revokeResetLinks(tx, { userId });

    /** After the delete, so it survives. */
    const session = await createSession(
      {
        userId,
        assurance: "password",
        authMethod: PASSWORD_CREDENTIAL,
        credentialId,
        ...client,
      },
      tx,
    );

    await tx
      .update(users)
      .set({ updatedAt: sql`now()` })
      .where(eq(users.id, userId));

    return {
      ok: true,
      sessionsRevoked,
      resetLinksRevoked,
      sessionId: session.sessionId,
      sessionToken: session.token,
    };
  });

  if (result.ok) {
    limiter.clear();
    /** Committed: look the new session's location up in the background (#281). */
    void locateSession(result.sessionId, sessionIp(client.ip));
  }
  return result;
}
