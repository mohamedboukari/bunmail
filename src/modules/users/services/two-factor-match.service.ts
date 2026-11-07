import { and, count, eq, isNull, lt, or, sql } from "drizzle-orm";
import { config } from "../../../config.ts";
import { decryptSecret } from "../../../utils/crypto.ts";
import { generateId } from "../../../utils/id.ts";
import { userCredentials } from "../models/user-credential.schema.ts";
import { userRecoveryCodes } from "../models/user-recovery-code.schema.ts";
import type { DbExecutor, SessionClient, Tx } from "../types/user.types.ts";
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
} from "./recovery-code.service.ts";
import * as totp from "./totp.service.ts";

/**
 * The shared steps of two-factor authentication (#220): the account's
 * `totp` credential, its secret, recovery codes, and checking and spending
 * a submitted second factor. The public surface is `two-factor.service.ts`.
 */

/** The credential type of the second factor. */
export const TOTP_CREDENTIAL = "totp";

/** The credential type the disable step re-verifies. */
export const PASSWORD_CREDENTIAL = "password";

/** SQLSTATE of a unique violation: a second `totp` row for the account. */
export const UNIQUE_VIOLATION = "23505";

/** No request metadata (a script, a test): the event is still recorded. */
export const NO_CLIENT: SessionClient = { ip: null, userAgent: null };

/** The account acting on its own second factor, as the audit log records it (#221). */
export function selfAudit(
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
export async function totpCredentialOf(
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
export function secretKey(encrypted: string): Buffer {
  const key = totp.base32Decode(decryptSecret(encrypted, config.dkimEncryptionKey));
  if (!key) throw new Error("Stored TOTP secret is not valid base32");
  return key;
}

/** Inserts fresh recovery codes for a `totp` credential and returns them for display. */
export async function issueRecoveryCodes(
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
export async function recoveryCodesLeft(
  executor: DbExecutor,
  userId: string,
): Promise<number> {
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
export async function matchSecondFactor(
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
