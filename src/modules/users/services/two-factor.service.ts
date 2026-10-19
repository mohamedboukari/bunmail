import { and, count, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { config } from "../../../config.ts";
import { decryptSecret, encryptSecret } from "../../../utils/crypto.ts";
import { generateId } from "../../../utils/id.ts";
import { UserStoreError, withSanitizedErrors } from "../errors.ts";
import { sessions } from "../models/session.schema.ts";
import { users } from "../models/user.schema.ts";
import { userCredentials } from "../models/user-credential.schema.ts";
import { userRecoveryCodes } from "../models/user-recovery-code.schema.ts";
import type {
  AttemptLimiter,
  ConfirmEnrolmentResult,
  DbExecutor,
  DisableTwoFactorResult,
  PendingEnrolment,
  PendingSession,
  RegenerateRecoveryCodesResult,
  SecondFactorMethod,
  SessionClient,
  Tx,
  TwoFactorLoginResult,
  TwoFactorStatus,
} from "../types/user.types.ts";
import { verifyPassword } from "./password.service.ts";
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
} from "./recovery-code.service.ts";
import {
  elevatePendingSession,
  lockPendingSession,
  markSessionMfa,
  setTotpPendingSecret,
  totpPendingSecretOf,
} from "./session.service.ts";
import * as totp from "./totp.service.ts";
import { recordAuditEvent } from "../../audit/services/audit.service.ts";

/**
 * TOTP two-factor authentication for the dashboard (#220): enrolment,
 * the second login step, recovery codes, disabling, and the removal a
 * password reset or `reset-owner` performs.
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
 * `isLimited` then `record` with no await in between, before any work:
 * a parallel burst cannot verify more codes than the budget. The login
 * step spends the account's budget; disabling and regenerating spend only
 * the session's, so a stolen session cannot lock the real user's sign-in.
 * Starting an enrolment re-checks the current password under the password
 * change's budget.
 *
 * Never logs (the routes log with their IDs); never returns or logs a
 * secret, a code hash or an `otpauth://` URI except to the page that
 * shows it. Database errors leave this module as `UserStoreError`.
 */

/** The credential type of the second factor. */
const TOTP_CREDENTIAL = "totp";

/** The credential type the disable step re-verifies. */
const PASSWORD_CREDENTIAL = "password";

/** SQLSTATE of a unique violation: a second `totp` row for the account. */
const UNIQUE_VIOLATION = "23505";

/** No request metadata (a script, a test): the event is still recorded. */
const NO_CLIENT: SessionClient = { ip: null, userAgent: null };

/** The account acting on its own second factor, as the audit log records it (#221). */
function selfAudit(
  userId: string,
  client: SessionClient,
): {
  actor: { type: "user"; id: string };
  ip: string | null;
  userAgent: string | null;
  target: { type: "user"; id: string };
} {
  return {
    actor: { type: "user", id: userId },
    ...client,
    target: { type: "user", id: userId },
  };
}

/** A matched second factor, with the `totp` credential it belongs to. */
type FactorMatch =
  | { ok: true; method: "totp"; credentialId: string }
  | {
      ok: true;
      method: "recovery_code";
      credentialId: string;
      recoveryCodesLeft: number;
    }
  | { ok: false; reason: "wrong_code" | "not_enabled" };

/** The account's `totp` credential, if it has one. */
async function totpCredentialOf(
  executor: DbExecutor,
  userId: string,
): Promise<
  | { id: string; secretHash: string | null; counter: number | null; createdAt: Date }
  | undefined
> {
  const [row] = await executor
    .select({
      id: userCredentials.id,
      secretHash: userCredentials.secretHash,
      counter: userCredentials.counter,
      createdAt: userCredentials.createdAt,
    })
    .from(userCredentials)
    .where(
      and(eq(userCredentials.userId, userId), eq(userCredentials.type, TOTP_CREDENTIAL)),
    )
    .limit(1);
  return row;
}

/** The secret's key bytes from its stored (encrypted base32) form. Throws when unreadable. */
function secretKey(encrypted: string): Buffer {
  const key = totp.base32Decode(decryptSecret(encrypted, config.dkimEncryptionKey));
  if (!key) throw new Error("Stored TOTP secret is not valid base32");
  return key;
}

/** Inserts fresh recovery codes for a `totp` credential and returns them for display. */
async function issueRecoveryCodes(
  tx: Tx,
  userId: string,
  credentialId: string,
): Promise<string[]> {
  const codes = generateRecoveryCodes();
  await tx.insert(userRecoveryCodes).values(
    codes.map((code) => ({
      id: generateId("rcv"),
      userId,
      credentialId,
      /** Generated codes always normalize; the fallback only satisfies the type. */
      codeHash: hashRecoveryCode(normalizeRecoveryCode(code) ?? code),
    })),
  );
  return codes;
}

/** Unused recovery codes of an account. */
async function recoveryCodesLeft(executor: DbExecutor, userId: string): Promise<number> {
  const [row] = await executor
    .select({ left: count() })
    .from(userRecoveryCodes)
    .where(and(eq(userRecoveryCodes.userId, userId), isNull(userRecoveryCodes.usedAt)));
  return row?.left ?? 0;
}

/**
 * Checks a submitted second factor inside the caller's transaction and
 * spends it:
 *
 * - Six digits: a TOTP code. It must match a step within the window and
 *   newer than the stored one (`matchTotpStep`, constant-time compares),
 *   and the compare-and-swap on `counter` must win; otherwise
 *   `wrong_code` (wrong, expired or replayed: one answer).
 * - Otherwise, when `allowRecovery`: a recovery code, spent by a
 *   conditional `UPDATE ... SET used_at = now() WHERE ... used_at IS
 *   NULL`, so it works exactly once even under concurrent submissions.
 */
async function matchSecondFactor(
  tx: Tx,
  userId: string,
  input: string,
  nowMs: number,
  allowRecovery: boolean,
): Promise<FactorMatch> {
  const credential = await totpCredentialOf(tx, userId);
  if (!credential?.secretHash) return { ok: false, reason: "not_enabled" };

  if (totp.looksLikeTotpCode(input)) {
    const step = totp.matchTotpStep(
      secretKey(credential.secretHash),
      input,
      nowMs,
      credential.counter,
    );
    if (step === null) return { ok: false, reason: "wrong_code" };
    const swapped = await tx
      .update(userCredentials)
      .set({ counter: step, lastUsedAt: sql`now()` })
      .where(
        and(
          eq(userCredentials.id, credential.id),
          or(isNull(userCredentials.counter), lt(userCredentials.counter, step)),
        ),
      )
      .returning({ id: userCredentials.id });
    if (swapped.length === 0) return { ok: false, reason: "wrong_code" };
    return { ok: true, method: "totp", credentialId: credential.id };
  }

  const normalized = allowRecovery ? normalizeRecoveryCode(input) : null;
  if (normalized === null) return { ok: false, reason: "wrong_code" };
  const spent = await tx
    .update(userRecoveryCodes)
    .set({ usedAt: sql`now()` })
    .where(
      and(
        eq(userRecoveryCodes.userId, userId),
        eq(userRecoveryCodes.codeHash, hashRecoveryCode(normalized)),
        isNull(userRecoveryCodes.usedAt),
      ),
    )
    .returning({ id: userRecoveryCodes.id });
  if (spent.length === 0) return { ok: false, reason: "wrong_code" };
  return {
    ok: true,
    method: "recovery_code",
    credentialId: credential.id,
    recoveryCodesLeft: await recoveryCodesLeft(tx, userId),
  };
}

/* ─── Status and enrolment ─── */

/** Whether the account has a second factor, since when, and its unused recovery codes. */
export async function twoFactorStatus(userId: string): Promise<TwoFactorStatus> {
  return withSanitizedErrors(async () => {
    const credential = await totpCredentialOf(db, userId);
    if (!credential) return { enabled: false, enabledAt: null, recoveryCodesLeft: 0 };
    return {
      enabled: true,
      enabledAt: credential.createdAt,
      recoveryCodesLeft: await recoveryCodesLeft(db, userId),
    };
  });
}

/** The account's `password` credential hash, or null. */
async function passwordHashOf(userId: string): Promise<string | null> {
  const [credential] = await withSanitizedErrors(() =>
    db
      .select({ secretHash: userCredentials.secretHash })
      .from(userCredentials)
      .where(
        and(
          eq(userCredentials.userId, userId),
          eq(userCredentials.type, PASSWORD_CREDENTIAL),
        ),
      )
      .limit(1),
  );
  return credential?.secretHash ?? null;
}

/**
 * Starts an enrolment in this session, after the user re-entered the
 * current password: a stolen session cookie alone must not be able to
 * turn 2FA on (which would sign the owner's other devices out and put
 * the account behind a code only the thief has). In order:
 *
 * 1. An account that already has a second factor is refused
 *    (`already_enabled`), before any password work.
 * 2. The password budget (`limiter`: the password change's keys,
 *    `password:user:<id>` and `password:ip:<bucket>`): over budget is
 *    refused (`rate_limited`), then the attempt is counted with no await
 *    in between.
 * 3. Exactly one argon2id verify of the current password; wrong (or no
 *    password credential): `wrong_password`, nothing written.
 * 4. A new random secret (20 bytes), encrypted and kept on the session
 *    row until it is confirmed; the budget is cleared. Starting again
 *    replaces it (the earlier QR code stops working).
 *
 * The pending secret is written only here, after the password check, so
 * `confirmEnrolment` (which needs it) can never run without a start that
 * passed the check.
 */
export async function startEnrolment(
  userId: string,
  sessionId: string,
  password: string,
  limiter: AttemptLimiter,
): Promise<
  | { ok: true }
  | { ok: false; reason: "already_enabled" | "rate_limited" | "wrong_password" }
> {
  if ((await twoFactorStatus(userId)).enabled) {
    return { ok: false, reason: "already_enabled" };
  }
  if (limiter.isLimited()) return { ok: false, reason: "rate_limited" };
  limiter.record();
  const hash = await passwordHashOf(userId);
  if (hash === null || !(await verifyPassword(password, hash))) {
    return { ok: false, reason: "wrong_password" };
  }
  const encrypted = encryptSecret(totp.generateTotpSecret(), config.dkimEncryptionKey);
  await setTotpPendingSecret(userId, sessionId, encrypted);
  limiter.clear();
  return { ok: true };
}

/**
 * The enrolment started in this session, decrypted for the page: the
 * secret (manual entry) and the `otpauth://` URI (QR code) for `account`.
 * `null` when none was started here.
 */
export async function pendingEnrolment(
  userId: string,
  sessionId: string,
  account: string,
): Promise<PendingEnrolment | null> {
  const encrypted = await totpPendingSecretOf(db, userId, sessionId);
  if (encrypted === null) return null;
  const secret = decryptSecret(encrypted, config.dkimEncryptionKey);
  return { secret, uri: totp.otpauthUri(secret, account) };
}

/**
 * Confirms the enrolment started in this session with a first code from
 * the app. In one transaction, the session row locked:
 *
 * 1. The pending secret must exist (`no_pending`) and the account must
 *    not have a second factor yet (`already_enabled`, the pending secret
 *    is then cleared).
 * 2. The code must match (`wrong_code`; the pending secret stays, so the
 *    user can try again).
 * 3. The `totp` credential is stored (the encrypted secret, and the
 *    matched step as `counter`, so this very code cannot be replayed at
 *    the next sign-in); ten recovery codes are created (hashes only);
 *    every OTHER session of the account is deleted, as a password change
 *    does: they were opened with the password alone; this session
 *    becomes `mfa` and its pending secret is cleared.
 *
 * A second confirmation racing from another session of the account hits
 * the one-`totp`-per-user unique index and gets `already_enabled`.
 *
 * @returns the raw recovery codes, for the one-time reveal.
 */
export async function confirmEnrolment(
  userId: string,
  sessionId: string,
  code: string,
  client: SessionClient = NO_CLIENT,
  nowMs: number = Date.now(),
): Promise<ConfirmEnrolmentResult> {
  try {
    return await withSanitizedErrors(() =>
      db.transaction(async (tx): Promise<ConfirmEnrolmentResult> => {
        const encrypted = await totpPendingSecretOf(tx, userId, sessionId, true);
        if (encrypted === null) return { ok: false, reason: "no_pending" };
        if (await totpCredentialOf(tx, userId)) {
          await tx
            .update(sessions)
            .set({ totpPendingSecret: null })
            .where(eq(sessions.id, sessionId));
          return { ok: false, reason: "already_enabled" };
        }

        const step = totp.matchTotpStep(secretKey(encrypted), code, nowMs, null);
        if (step === null) return { ok: false, reason: "wrong_code" };

        const credentialId = generateId("crd");
        await tx.insert(userCredentials).values({
          id: credentialId,
          userId,
          type: TOTP_CREDENTIAL,
          secretHash: encrypted,
          counter: step,
          lastUsedAt: sql`now()`,
        });
        const recoveryCodes = await issueRecoveryCodes(tx, userId, credentialId);

        const revoked = await tx
          .delete(sessions)
          .where(and(eq(sessions.userId, userId), ne(sessions.id, sessionId)))
          .returning({ id: sessions.id });
        await markSessionMfa(tx, sessionId);
        await tx
          .update(users)
          .set({ updatedAt: sql`now()` })
          .where(eq(users.id, userId));
        /** Recorded with the change (#221): both commit, or neither. */
        await recordAuditEvent(
          {
            ...selfAudit(userId, client),
            action: "auth.two_factor.enabled",
            metadata: { sessionsRevoked: revoked.length },
          },
          tx,
        );

        return { ok: true, recoveryCodes, sessionsRevoked: revoked.length };
      }),
    );
  } catch (error: unknown) {
    if (error instanceof UserStoreError && error.sqlState === UNIQUE_VIOLATION) {
      return { ok: false, reason: "already_enabled" };
    }
    throw error;
  }
}

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
  if (limiter.isLimited()) return { ok: false, reason: "rate_limited" };
  limiter.record();

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
 * verify outside the transaction; then, in one transaction, the code is
 * spent and the `totp` credential deleted (its recovery codes go with it,
 * by cascade). Sessions are kept.
 */
export async function disableTwoFactor(
  userId: string,
  password: string,
  code: string,
  limiter: AttemptLimiter,
  client: SessionClient = NO_CLIENT,
  nowMs: number = Date.now(),
): Promise<DisableTwoFactorResult> {
  if (!(await withSanitizedErrors(() => totpCredentialOf(db, userId)))) {
    return { ok: false, reason: "not_enabled" };
  }
  if (limiter.isLimited()) return { ok: false, reason: "rate_limited" };
  limiter.record();

  const hash = await passwordHashOf(userId);
  if (hash === null || !(await verifyPassword(password, hash))) {
    return { ok: false, reason: "wrong_password" };
  }

  return withSanitizedErrors(() =>
    db.transaction(async (tx): Promise<DisableTwoFactorResult> => {
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
  if (limiter.isLimited()) return { ok: false, reason: "rate_limited" };
  limiter.record();

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

/* ─── Recovery (lost authenticator) ─── */

/**
 * Removes the account's second factor and recovery codes, inside the
 * caller's transaction: the recovery path when the authenticator is lost.
 * Called by a completed admin-issued password reset (#277) and a
 * completed owner setup link (`reset-owner`), which already sign every
 * session of the account out. Pending enrolment secrets on its sessions
 * are cleared too.
 *
 * @returns true when a second factor was removed.
 */
export async function removeTwoFactor(
  executor: DbExecutor,
  userId: string,
): Promise<boolean> {
  const removed = await executor
    .delete(userCredentials)
    .where(
      and(eq(userCredentials.userId, userId), eq(userCredentials.type, TOTP_CREDENTIAL)),
    )
    .returning({ id: userCredentials.id });
  await executor
    .update(sessions)
    .set({ totpPendingSecret: null })
    .where(eq(sessions.userId, userId));
  return removed.length > 0;
}
