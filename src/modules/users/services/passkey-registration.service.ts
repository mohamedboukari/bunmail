import { and, eq, ne, sql } from "drizzle-orm";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type PublicKeyCredentialCreationOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { db } from "../../../db/index.ts";
import { generateId } from "../../../utils/id.ts";
import { logger } from "../../../utils/logger.ts";
import { UserStoreError, withSanitizedErrors } from "../errors.ts";
import { sessions } from "../models/session.schema.ts";
import { users } from "../models/user.schema.ts";
import { hasSecondFactor, userCredentials } from "../models/user-credential.schema.ts";
import type {
  AttemptLimiter,
  FinishPasskeyRegistrationResult,
  RelyingParty,
  SessionClient,
} from "../types/user.types.ts";
import { recordAuditEvent } from "../../audit/services/audit.service.ts";
import { verifyPassword } from "./password.service.ts";
import { passkeyChallenges } from "./passkey-challenge.service.ts";
import {
  PASSKEY_CEREMONY_TIMEOUT_MS,
  PASSKEY_RP_NAME,
  passkeyNameProblem,
  transportsFromColumn,
  transportsToColumn,
  userHandleOf,
} from "./passkey-policy.service.ts";
import { raiseSessionToMfa } from "./session.service.ts";
import { passwordHashOf } from "./two-factor.service.ts";
import {
  NO_CLIENT,
  PASSKEY_CREDENTIAL,
  UNIQUE_VIOLATION,
  failureName,
  passkeysOf,
} from "./passkey-store.service.ts";

/**
 * Adding a passkey (#223): the options after the password re-check, and
 * the verified registration stored in one transaction. The public surface
 * is `passkey.service.ts`.
 */

/* ─── Registration ─── */

/**
 * Starts adding a passkey, after the user re-entered the current password
 * (the #220 enrolment pattern: a stolen session cookie alone must not be
 * able to plant a passkey). In order:
 *
 * 1. The name policy (`invalid_name`): free, not counted.
 * 2. The password budget (`limiter`: the password change's keys,
 *    `password:user:<id>` and `password:ip:<bucket>`): over budget is
 *    refused (`rate_limited`), then the attempt is counted with no await
 *    in between.
 * 3. Exactly one argon2id verify (`wrong_password`); the budget is
 *    cleared on success.
 * 4. A challenge bound to this session and account, carrying the name,
 *    and the creation options: the account's existing passkeys excluded,
 *    a discoverable credential with user verification required, no
 *    attestation.
 *
 * The challenge is written only here, after the password check, so
 * `finishRegistration` can never succeed without a start that passed it.
 */
export async function startRegistration(
  input: {
    userId: string;
    email: string;
    sessionId: string;
    password: string;
    name: string;
  },
  limiter: AttemptLimiter,
  rp: RelyingParty,
): Promise<
  | { ok: true; options: PublicKeyCredentialCreationOptionsJSON }
  | { ok: false; reason: "invalid_name"; problem: string }
  | { ok: false; reason: "rate_limited" | "wrong_password" }
> {
  const problem = passkeyNameProblem(input.name);
  if (problem !== null) return { ok: false, reason: "invalid_name", problem };
  if (await limiter.take()) return { ok: false, reason: "rate_limited" };
  const hash = await passwordHashOf(input.userId);
  if (hash === null || !(await verifyPassword(input.password, hash))) {
    return { ok: false, reason: "wrong_password" };
  }
  await limiter.clear();

  const existing = await withSanitizedErrors(() => passkeysOf(db, input.userId));
  const challenge = passkeyChallenges.issue("register", input.sessionId, {
    userId: input.userId,
    name: input.name,
  });
  const options = await generateRegistrationOptions({
    rpName: PASSKEY_RP_NAME,
    rpID: rp.rpID,
    userName: input.email,
    userDisplayName: input.email,
    userID: userHandleOf(input.userId),
    challenge: isoBase64URL.toBuffer(challenge),
    timeout: PASSKEY_CEREMONY_TIMEOUT_MS,
    attestationType: "none",
    excludeCredentials: existing.map((row) => ({
      id: row.credentialId,
      transports: transportsFromColumn(row.transports),
    })),
    authenticatorSelection: {
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
    },
  });
  return { ok: true, options };
}

/**
 * Finishes adding a passkey with the browser's registration response. In
 * order:
 *
 * 1. The challenge of this session is taken (spent, whatever follows);
 *    none, expired, or issued to another account: `no_challenge`.
 * 2. Verification: the challenge, the exact origin and RP ID, user
 *    presence and verification, the attestation (`none`) and the key's
 *    algorithm; any failure or malformed input: `rejected`.
 * 3. One transaction: the `passkey` row is stored (the credential id is
 *    unique: `already_registered`); when it is the account's first second
 *    factor, every other session is signed out (they were opened with the
 *    password alone, as TOTP's confirmation does, #220); this session
 *    becomes `mfa`; `auth.passkey.added` is recorded.
 */
export async function finishRegistration(
  input: {
    userId: string;
    sessionId: string;
    response: RegistrationResponseJSON | null;
  },
  rp: RelyingParty,
  client: SessionClient = NO_CLIENT,
): Promise<FinishPasskeyRegistrationResult> {
  const taken = passkeyChallenges.take("register", input.sessionId);
  if (!taken || taken.userId !== input.userId || taken.name === undefined) {
    return { ok: false, reason: "no_challenge" };
  }
  const name = taken.name;
  if (!input.response) return { ok: false, reason: "rejected" };

  let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verified = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: taken.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserPresence: true,
      requireUserVerification: true,
    });
  } catch (error: unknown) {
    logger.debug("Passkey registration did not verify", {
      userId: input.userId,
      sessionId: input.sessionId,
      error: failureName(error),
    });
    return { ok: false, reason: "rejected" };
  }
  if (!verified.verified) return { ok: false, reason: "rejected" };
  const { credential, userVerified } = verified.registrationInfo;
  if (!userVerified) return { ok: false, reason: "rejected" };

  const credentialId = generateId("crd");
  try {
    return await withSanitizedErrors(() =>
      db.transaction(async (tx): Promise<FinishPasskeyRegistrationResult> => {
        const [before] = await tx
          .select({ had: hasSecondFactor(users.id) })
          .from(users)
          .where(eq(users.id, input.userId))
          .for("update");
        if (!before) return { ok: false, reason: "no_challenge" };

        await tx.insert(userCredentials).values({
          id: credentialId,
          userId: input.userId,
          type: PASSKEY_CREDENTIAL,
          providerAccountId: credential.id,
          publicKey: isoBase64URL.fromBuffer(credential.publicKey),
          counter: credential.counter,
          name,
          transports: transportsToColumn(credential.transports),
        });

        const revoked = before.had
          ? []
          : await tx
              .delete(sessions)
              .where(
                and(eq(sessions.userId, input.userId), ne(sessions.id, input.sessionId)),
              )
              .returning({ id: sessions.id });
        await raiseSessionToMfa(tx, input.sessionId);
        await tx
          .update(users)
          .set({ updatedAt: sql`now()` })
          .where(eq(users.id, input.userId));
        await recordAuditEvent(
          {
            action: "auth.passkey.added",
            actor: { type: "user", id: input.userId },
            ...client,
            target: { type: "passkey", id: credentialId, label: name },
            metadata: { sessionsRevoked: revoked.length },
          },
          tx,
        );
        return { ok: true, credentialId, name, sessionsRevoked: revoked.length };
      }),
    );
  } catch (error: unknown) {
    if (error instanceof UserStoreError && error.sqlState === UNIQUE_VIOLATION) {
      return { ok: false, reason: "already_registered" };
    }
    throw error;
  }
}
