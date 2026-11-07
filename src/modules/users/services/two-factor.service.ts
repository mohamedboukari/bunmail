import { eq, sql } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { withSanitizedErrors } from "../errors.ts";
import { users } from "../models/user.schema.ts";
import { userCredentials } from "../models/user-credential.schema.ts";
import { userRecoveryCodes } from "../models/user-recovery-code.schema.ts";
import type {
  AttemptLimiter,
  DisableTwoFactorResult,
  PendingSession,
  RegenerateRecoveryCodesResult,
  SecondFactorMethod,
  SessionClient,
  TwoFactorLoginResult,
} from "../types/user.types.ts";
import { verifyPassword } from "./password.service.ts";
import {
  NO_CLIENT,
  issueRecoveryCodes,
  matchSecondFactor,
  selfAudit,
  totpCredentialOf,
} from "./two-factor-match.service.ts";
import { elevatePendingSession, lockPendingSession } from "./session.service.ts";
import {
  recordFactorRemovalRefused,
  removalBreaksOwnerSsoRule,
} from "./sso-owner-rule.service.ts";
import { recordAuditEvent } from "../../audit/services/audit.service.ts";
import { passwordHashOf } from "./two-factor-enrolment.service.ts";

/**
 * TOTP two-factor authentication for the dashboard (#220): enrolment,
 * the second login step, recovery codes, disabling, and the removal a
 * password reset or `reset-owner` performs (of every second factor, the
 * passkeys of #223 included).
 *
 * **Storage.** A confirmed second factor is a `user_credentials` row of
 * type `totp`: `secret_hash` holds the base32 secret encrypted with
 * `DKIM_ENCRYPTION_KEY` (AES-256-GCM, `encryptSecret`), `counter` the
 * last accepted time step. An enrolment in progress keeps its secret on
 * the session that started it (`sessions.totp_pending_secret`), so a
 * `totp` row always means a working factor. Recovery codes live in
 * `user_recovery_codes`, SHA-256 only, bound to the `totp` row
 * (cascade).
 *
 * **Replay protection.** A code is accepted only for a time step newer
 * than the stored one (window: the current step and one on either side),
 * and the step is stored by a compare-and-swap (`... WHERE counter IS
 * NULL OR counter < $step`) in the transaction that accepts the code: of
 * two concurrent submissions of one code, exactly one updates the row.
 *
 * **Throttling.** Every check of a code an attacker could guess (the
 * login step, disabling, regenerating) takes an `AttemptLimiter` and runs
 * `take` (check and count in one atomic step, #185) before any work: a
 * parallel burst, even across replicas, cannot verify more codes than the
 * budget. The login
 * step spends the account's budget; disabling and regenerating spend only
 * the session's, so a stolen session cannot lock the real user's sign-in.
 * Starting an enrolment re-checks the current password under the password
 * change's budget.
 *
 * Never logs (the routes log with their IDs); never returns or logs a
 * secret, a code hash or an `otpauth://` URI except to the page that
 * shows it. Database errors leave this module as `UserStoreError`.
 */

/**
 * The service's public surface (#387). The second login step, disabling
 * and regenerating live here; the rest is in one file per concern, beside
 * this one:
 *
 *   - `two-factor-match.service.ts`: the `totp` credential, its secret, recovery codes, checking a code
 *   - `two-factor-enrolment.service.ts`: status, the password hash, starting and confirming an enrolment
 *   - `two-factor-recovery.service.ts`: removing every second factor, which ones an account has
 *
 * Importers keep using this module.
 */
export {
  twoFactorStatus,
  passwordHashOf,
  startEnrolment,
  pendingEnrolment,
  confirmEnrolment,
} from "./two-factor-enrolment.service.ts";
export {
  removeSecondFactors,
  removedAny,
  secondFactorsOf,
} from "./two-factor-recovery.service.ts";

/* ─── Second login step ─── */

/**
 * The second login step (#220) for a `pending` session. In order:
 *
 * 1. The failed-attempt budget (`limiter`: per account and per client
 *    IP): over budget is refused (`rate_limited`) before any check.
 * 2. The attempt is counted, with no await since step 1, so a parallel
 *    burst cannot check more codes than the budget allows.
 * 3. One transaction: the pending session is locked (still pending, same
 *    token, unexpired, user enabled; otherwise `session_gone`, nothing
 *    spent); the code is checked and spent (a TOTP code by the counter
 *    compare-and-swap, or a recovery code); the session becomes `mfa`
 *    with a fresh token (`elevatePendingSession`). A wrong code changes
 *    nothing.
 *
 * The caller clears the budget, sets the new cookie and runs the
 * post-login steps on success, and revokes the pending session once the
 * budget is spent.
 */
export async function completeTwoFactorLogin(
  pending: PendingSession,
  presentedToken: string,
  code: string,
  limiter: AttemptLimiter,
  nowMs: number = Date.now(),
): Promise<TwoFactorLoginResult> {
  if (await limiter.take()) return { ok: false, reason: "rate_limited" };

  return withSanitizedErrors(() =>
    db.transaction(async (tx): Promise<TwoFactorLoginResult> => {
      if (!(await lockPendingSession(tx, pending.sessionId, presentedToken))) {
        return { ok: false, reason: "session_gone" };
      }
      const match = await matchSecondFactor(tx, pending.userId, code, nowMs, true);
      if (!match.ok) return { ok: false, reason: "wrong_code" };
      const rotated = await elevatePendingSession(tx, pending.sessionId);
      return {
        ok: true,
        method: match.method,
        recoveryCodesLeft:
          match.method === "recovery_code" ? match.recoveryCodesLeft : null,
        token: rotated.token,
        maxAgeSec: rotated.maxAgeSec,
      };
    }),
  );
}

/* ─── Disable and regenerate ─── */

/**
 * Turns two-factor authentication off: the current password AND a valid
 * code (from the app, or a recovery code) are required. In order: an
 * account without a second factor is answered `not_enabled` at once,
 * before any password work (so this form never says whether a password
 * is right on such an account); the budget (`limiter`: this session's,
 * never the account's login budget) is checked and counted; one argon2id
 * verify outside the transaction; then, in one transaction, the account
 * row is locked and the owner rule of SSO checked (#224: an owner with an
 * SSO link and no passkey may not turn TOTP off, `sso_link_requires_second_factor`,
 * recorded as `auth.two_factor.removal_refused`; the owner unlinks first),
 * then the code is spent and the `totp` credential deleted (its recovery
 * codes go with it, by cascade). Sessions are kept.
 */
export async function disableTwoFactor(
  userId: string,
  password: string,
  code: string,
  limiter: AttemptLimiter,
  client: SessionClient = NO_CLIENT,
  nowMs: number = Date.now(),
): Promise<DisableTwoFactorResult> {
  const credential = await withSanitizedErrors(() => totpCredentialOf(db, userId));
  if (!credential) return { ok: false, reason: "not_enabled" };
  if (await limiter.take()) return { ok: false, reason: "rate_limited" };

  const hash = await passwordHashOf(userId);
  if (hash === null || !(await verifyPassword(password, hash))) {
    return { ok: false, reason: "wrong_password" };
  }

  const result = await withSanitizedErrors(() =>
    db.transaction(async (tx): Promise<DisableTwoFactorResult> => {
      if (await removalBreaksOwnerSsoRule(tx, userId, credential.id)) {
        return { ok: false, reason: "sso_link_requires_second_factor" };
      }
      const match = await matchSecondFactor(tx, userId, code, nowMs, true);
      if (!match.ok) return { ok: false, reason: match.reason };
      await tx.delete(userCredentials).where(eq(userCredentials.id, match.credentialId));
      await tx
        .update(users)
        .set({ updatedAt: sql`now()` })
        .where(eq(users.id, userId));
      const method: SecondFactorMethod = match.method;
      await recordAuditEvent(
        {
          ...selfAudit(userId, client),
          action: "auth.two_factor.disabled",
          metadata: { method },
        },
        tx,
      );
      return { ok: true, method };
    }),
  );
  if (!result.ok && result.reason === "sso_link_requires_second_factor") {
    await recordFactorRemovalRefused(userId, "totp", client);
  }
  return result;
}

/**
 * Replaces every recovery code of the account with ten new ones. A code
 * from the authenticator app is required (not a recovery code: someone
 * holding only a leaked recovery code must not be able to mint more).
 * Budget first (this session's, never the account's login budget); then,
 * in one transaction, the code is spent, the old codes (used or not)
 * deleted and the new ones stored.
 *
 * @returns the raw new codes, for the one-time reveal.
 */
export async function regenerateRecoveryCodes(
  userId: string,
  code: string,
  limiter: AttemptLimiter,
  client: SessionClient = NO_CLIENT,
  nowMs: number = Date.now(),
): Promise<RegenerateRecoveryCodesResult> {
  if (await limiter.take()) return { ok: false, reason: "rate_limited" };

  return withSanitizedErrors(() =>
    db.transaction(async (tx): Promise<RegenerateRecoveryCodesResult> => {
      const match = await matchSecondFactor(tx, userId, code, nowMs, false);
      if (!match.ok) return { ok: false, reason: match.reason };
      await tx.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
      const recoveryCodes = await issueRecoveryCodes(tx, userId, match.credentialId);
      await recordAuditEvent(
        {
          ...selfAudit(userId, client),
          action: "auth.two_factor.recovery_codes_regenerated",
        },
        tx,
      );
      return { ok: true, recoveryCodes };
    }),
  );
}
