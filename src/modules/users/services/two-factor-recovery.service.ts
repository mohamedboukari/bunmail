import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { withSanitizedErrors } from "../errors.ts";
import { sessions } from "../models/session.schema.ts";
import { userCredentials } from "../models/user-credential.schema.ts";
import type { DbExecutor, RemovedSecondFactors } from "../types/user.types.ts";
import { TOTP_CREDENTIAL } from "./two-factor-match.service.ts";

/**
 * Removing every second factor of an account (#220, #223), the recovery
 * path of a completed reset or owner setup link, and which second factors
 * an account has. The public surface is `two-factor.service.ts`.
 */

/* ─── Recovery (lost authenticator) ─── */

/** The credential type of a passkey (#223). */
const PASSKEY_CREDENTIAL = "passkey";

/**
 * Removes every second factor of the account, inside the caller's
 * transaction: the TOTP credential with its recovery codes (#220) and
 * every passkey (#223). The recovery path when the authenticator or the
 * passkeys are lost. Called by a completed admin-issued password reset
 * (#277) and a completed owner setup link (`reset-owner`), which already
 * sign every session of the account out. Pending enrolment secrets on its
 * sessions are cleared too.
 *
 * @returns what was removed, for the security email and the audit log.
 */
export async function removeSecondFactors(
  executor: DbExecutor,
  userId: string,
): Promise<RemovedSecondFactors> {
  const removed = await executor
    .delete(userCredentials)
    .where(
      and(
        eq(userCredentials.userId, userId),
        inArray(userCredentials.type, [TOTP_CREDENTIAL, PASSKEY_CREDENTIAL]),
      ),
    )
    .returning({ type: userCredentials.type });
  await executor
    .update(sessions)
    .set({ totpPendingSecret: null })
    .where(eq(sessions.userId, userId));
  return {
    totp: removed.some((row) => row.type === TOTP_CREDENTIAL),
    passkeys: removed.filter((row) => row.type === PASSKEY_CREDENTIAL).length,
  };
}

/** Whether a removal took any second factor away. */
export function removedAny(removed: RemovedSecondFactors): boolean {
  return removed.totp || removed.passkeys > 0;
}

/**
 * Which second factors the account has (#223): whether it has TOTP and
 * how many passkeys. The second login step offers exactly these.
 */
export async function secondFactorsOf(
  userId: string,
): Promise<{ totp: boolean; passkeys: number }> {
  const rows = await withSanitizedErrors(() =>
    db
      .select({ type: userCredentials.type })
      .from(userCredentials)
      .where(
        and(
          eq(userCredentials.userId, userId),
          inArray(userCredentials.type, [TOTP_CREDENTIAL, PASSKEY_CREDENTIAL]),
        ),
      ),
  );
  return {
    totp: rows.some((row) => row.type === TOTP_CREDENTIAL),
    passkeys: rows.filter((row) => row.type === PASSKEY_CREDENTIAL).length,
  };
}
