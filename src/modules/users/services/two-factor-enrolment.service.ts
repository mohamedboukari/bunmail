import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { config } from "../../../config.ts";
import { decryptSecret, encryptSecret } from "../../../utils/crypto.ts";
import { generateId } from "../../../utils/id.ts";
import { UserStoreError, withSanitizedErrors } from "../errors.ts";
import { sessions } from "../models/session.schema.ts";
import { users } from "../models/user.schema.ts";
import { userCredentials } from "../models/user-credential.schema.ts";
import type {
  AttemptLimiter,
  ConfirmEnrolmentResult,
  PendingEnrolment,
  SessionClient,
  TwoFactorStatus,
} from "../types/user.types.ts";
import { verifyPassword } from "./password.service.ts";
import {
  markSessionMfa,
  setTotpPendingSecret,
  totpPendingSecretOf,
} from "./session.service.ts";
import * as totp from "./totp.service.ts";
import { recordAuditEvent } from "../../audit/services/audit.service.ts";
import {
  NO_CLIENT,
  PASSWORD_CREDENTIAL,
  TOTP_CREDENTIAL,
  UNIQUE_VIOLATION,
  issueRecoveryCodes,
  recoveryCodesLeft,
  secretKey,
  selfAudit,
  totpCredentialOf,
} from "./two-factor-match.service.ts";

/**
 * Two-factor status and enrolment (#220): the account's state, the
 * password hash re-checked first, starting and confirming an enrolment.
 * The public surface is `two-factor.service.ts`.
 */

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

/** The account's `password` credential hash, or null (also the passkey re-auth, #223). */
export async function passwordHashOf(userId: string): Promise<string | null> {
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
  if (await limiter.take()) return { ok: false, reason: "rate_limited" };
  const hash = await passwordHashOf(userId);
  if (hash === null || !(await verifyPassword(password, hash))) {
    return { ok: false, reason: "wrong_password" };
  }
  const encrypted = encryptSecret(totp.generateTotpSecret(), config.dkimEncryptionKey);
  await setTotpPendingSecret(userId, sessionId, encrypted);
  await limiter.clear();
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
