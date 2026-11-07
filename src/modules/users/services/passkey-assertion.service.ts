import { and, eq, sql } from "drizzle-orm";
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { db } from "../../../db/index.ts";
import { logger } from "../../../utils/logger.ts";
import type { WindowTicket } from "../../../utils/shared-store.ts";
import { withSanitizedErrors } from "../errors.ts";
import { users } from "../models/user.schema.ts";
import { userCredentials } from "../models/user-credential.schema.ts";
import type {
  AttemptLimiter,
  PasskeyFailure,
  PasskeySignInResult,
  PasskeyTwoFactorResult,
  PendingSession,
  RelyingParty,
  SessionClient,
  Tx,
} from "../types/user.types.ts";
import { recordAuditEvent } from "../../audit/services/audit.service.ts";
import { passkeyChallenges } from "./passkey-challenge.service.ts";
import {
  PASSKEY_CEREMONY_TIMEOUT_MS,
  counterRegressed,
  transportsFromColumn,
  userHandleOf,
} from "./passkey-policy.service.ts";
import {
  createSession,
  elevatePendingSession,
  lockPendingSession,
} from "./session.service.ts";
import { hashToken, mintToken } from "./token.service.ts";
import {
  NO_CLIENT,
  PASSKEY_CREDENTIAL,
  failureName,
  passkeyColumns,
  passkeysOf,
  toPasskeyRow,
  type PasskeyRow,
} from "./passkey-store.service.ts";

/**
 * Passkey assertions (#223): the second login step with a passkey and the
 * passwordless sign-in, with the checks and the counter rule they share.
 * The public surface is `passkey.service.ts`.
 */

/* ─── Assertions (second factor and passwordless) ─── */

/** The outcome of checking one assertion against one stored passkey. */
type AssertionCheck =
  | { ok: true; newCounter: number }
  | { ok: false; reason: "rejected" }
  | { ok: false; reason: "counter_regressed"; received: number };

/**
 * Verifies an assertion against a stored passkey: the challenge, the
 * exact origin and RP ID, user presence and verification, and the
 * signature over the authenticator data and the client data. The user
 * handle, when the response carries one, must be the passkey owner's.
 * Only then the counter rule (see the module comment).
 */
async function checkAssertion(
  row: PasskeyRow,
  response: AuthenticationResponseJSON,
  challenge: string,
  rp: RelyingParty,
): Promise<AssertionCheck> {
  const handle = response.response.userHandle;
  if (handle && handle !== isoBase64URL.fromBuffer(userHandleOf(row.userId))) {
    return { ok: false, reason: "rejected" };
  }
  let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verified = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
      credential: {
        id: row.credentialId,
        publicKey: isoBase64URL.toBuffer(row.publicKey),
        /** 0: the counter rule is applied below, after the signature (module comment). */
        counter: 0,
        transports: transportsFromColumn(row.transports),
      },
    });
  } catch (error: unknown) {
    logger.debug("Passkey assertion did not verify", {
      passkeyId: row.id,
      userId: row.userId,
      error: failureName(error),
    });
    return { ok: false, reason: "rejected" };
  }
  const { newCounter, userVerified } = verified.authenticationInfo;
  if (!verified.verified || !userVerified) return { ok: false, reason: "rejected" };
  if (counterRegressed(row.counter, newCounter)) {
    return { ok: false, reason: "counter_regressed", received: newCounter };
  }
  return { ok: true, newCounter };
}

/** The passkey with a credential id, locked for the caller's transaction, or null. */
async function lockPasskeyByCredentialId(
  tx: Tx,
  credentialId: string,
  userId?: string,
): Promise<PasskeyRow | null> {
  const [row] = await tx
    .select(passkeyColumns)
    .from(userCredentials)
    .where(
      and(
        eq(userCredentials.type, PASSKEY_CREDENTIAL),
        eq(userCredentials.providerAccountId, credentialId),
        userId === undefined ? undefined : eq(userCredentials.userId, userId),
      ),
    )
    .limit(1)
    .for("update");
  return row ? toPasskeyRow(row) : null;
}

/** Stores the new counter and the use time of a passkey that just verified. */
async function markPasskeyUsed(
  tx: Tx,
  passkeyId: string,
  newCounter: number,
): Promise<void> {
  await tx
    .update(userCredentials)
    .set({ counter: newCounter, lastUsedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(userCredentials.id, passkeyId));
}

/**
 * Records a counter regression (`auth.passkey.counter_regressed`) in the
 * caller's transaction, which then commits with nothing else written,
 * and returns the refusal with the passkey for the route's alert.
 */
async function refuseRegressedCounter(
  tx: Tx,
  row: PasskeyRow,
  received: number,
  client: SessionClient,
): Promise<PasskeyFailure<"counter_regressed">> {
  const [account] = await tx
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, row.userId));
  await recordAuditEvent(
    {
      action: "auth.passkey.counter_regressed",
      outcome: "failure",
      actor: { type: "user", id: row.userId },
      ...client,
      target: { type: "passkey", id: row.id, label: row.name },
      metadata: { storedCounter: row.counter, receivedCounter: received },
    },
    tx,
  );
  return {
    ok: false,
    reason: "counter_regressed",
    passkey: {
      id: row.id,
      name: row.name,
      userId: row.userId,
      email: account?.email ?? "",
    },
  };
}

/** Request options for a ceremony: the given passkeys allowed (none: discoverable), UV required. */
function requestOptions(
  rp: RelyingParty,
  challenge: string,
  allowed: PasskeyRow[] | undefined,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: rp.rpID,
    challenge: isoBase64URL.toBuffer(challenge),
    timeout: PASSKEY_CEREMONY_TIMEOUT_MS,
    userVerification: "required",
    allowCredentials: allowed?.map((row) => ({
      id: row.credentialId,
      transports: transportsFromColumn(row.transports),
    })),
  });
}

/**
 * Options for the second login step with a passkey (#223), for a
 * `pending` session: the account's passkeys allowed, and a challenge
 * bound to that session. `null` when the account has no passkey.
 */
export async function startPasskeyTwoFactor(
  pending: PendingSession,
  rp: RelyingParty,
): Promise<PublicKeyCredentialRequestOptionsJSON | null> {
  const rows = await withSanitizedErrors(() => passkeysOf(db, pending.userId));
  if (rows.length === 0) return null;
  const challenge = passkeyChallenges.issue("second_factor", pending.sessionId, {
    userId: pending.userId,
  });
  return requestOptions(rp, challenge, rows);
}

/**
 * The second login step with a passkey (#223), completing a `pending`
 * session exactly like a valid TOTP code does (#220). In order:
 *
 * 1. The second-factor budget (`limiter`: `totp:user:<id>` and
 *    `totp:ip:<bucket>`, shared with the TOTP code): over budget is
 *    refused (`rate_limited`), then the attempt is counted with no await
 *    in between.
 * 2. The challenge of this pending session is taken (spent):
 *    `no_challenge` when there is none.
 * 3. One transaction: the pending session is locked (`session_gone`);
 *    the passkey must be one of this account's (`unknown_credential`);
 *    the assertion must verify (`rejected`) with a growing counter
 *    (`counter_regressed`, recorded); the counter is stored and the
 *    session becomes `mfa` with a fresh token.
 *
 * The caller clears the budget on success, like the TOTP step.
 */
export async function completePasskeyTwoFactor(
  pending: PendingSession,
  presentedToken: string,
  response: AuthenticationResponseJSON | null,
  limiter: AttemptLimiter,
  rp: RelyingParty,
  client: SessionClient = NO_CLIENT,
): Promise<PasskeyTwoFactorResult> {
  if (await limiter.take()) return { ok: false, reason: "rate_limited" };
  const taken = passkeyChallenges.take("second_factor", pending.sessionId);
  if (!taken || taken.userId !== pending.userId) {
    return { ok: false, reason: "no_challenge" };
  }
  if (!response) return { ok: false, reason: "rejected" };

  return withSanitizedErrors(() =>
    db.transaction(async (tx): Promise<PasskeyTwoFactorResult> => {
      if (!(await lockPendingSession(tx, pending.sessionId, presentedToken))) {
        return { ok: false, reason: "session_gone" };
      }
      const row = await lockPasskeyByCredentialId(tx, response.id, pending.userId);
      if (!row) return { ok: false, reason: "unknown_credential" };
      const check = await checkAssertion(row, response, taken.challenge, rp);
      if (!check.ok) {
        if (check.reason === "counter_regressed") {
          return refuseRegressedCounter(tx, row, check.received, client);
        }
        return { ok: false, reason: "rejected" };
      }
      await markPasskeyUsed(tx, row.id, check.newCounter);
      const rotated = await elevatePendingSession(tx, pending.sessionId);
      return {
        ok: true,
        credentialId: row.id,
        token: rotated.token,
        maxAgeSec: rotated.maxAgeSec,
      };
    }),
  );
}

/**
 * Options for a passwordless sign-in (#223): no credential list (the
 * authenticator offers its discoverable passkeys for this RP, so no email
 * is typed), and a challenge bound to a new random browser binding. The
 * caller puts `binding` in the short-lived `bm_wa` cookie; only its hash
 * keys the challenge.
 */
export async function startPasskeySignIn(
  rp: RelyingParty,
  loginTicket?: WindowTicket,
): Promise<{ binding: string; options: PublicKeyCredentialRequestOptionsJSON }> {
  const binding = mintToken().token;
  /** The login-budget windows the options request counted in (#185). */
  const challenge = passkeyChallenges.issue("sign_in", hashToken(binding), {
    userId: null,
    loginTicket,
  });
  return { binding, options: await requestOptions(rp, challenge, undefined) };
}

/**
 * A passwordless sign-in (#223). In order:
 *
 * 1. The challenge of this browser binding is taken (spent):
 *    `no_challenge` when there is none.
 * 2. One transaction: the passkey is looked up by its credential id, of
 *    any account (`unknown_credential`); the response must carry the
 *    owner's user handle and verify (`rejected`) with a growing counter
 *    (`counter_regressed`, recorded); a deactivated account is refused
 *    (`account_disabled`); the counter is stored.
 *
 * The caller then replaces the browser's previous session and opens an
 * `mfa` session bound to the passkey (`openPasskeySession`), as the
 * password login does after its check. It answers every failure with
 * one generic message (the attempt was counted against the client's login
 * budget when the options were issued) and logs the reason.
 */
export async function completePasskeySignIn(
  binding: string,
  response: AuthenticationResponseJSON | null,
  rp: RelyingParty,
  client: SessionClient = NO_CLIENT,
): Promise<PasskeySignInResult> {
  const taken = passkeyChallenges.take("sign_in", hashToken(binding));
  if (!taken) return { ok: false, reason: "no_challenge" };
  if (!response) return { ok: false, reason: "rejected" };
  if (!response.response.userHandle) return { ok: false, reason: "rejected" };

  return withSanitizedErrors(() =>
    db.transaction(async (tx): Promise<PasskeySignInResult> => {
      const row = await lockPasskeyByCredentialId(tx, response.id);
      if (!row) return { ok: false, reason: "unknown_credential" };
      const check = await checkAssertion(row, response, taken.challenge, rp);
      if (!check.ok) {
        if (check.reason === "counter_regressed") {
          return {
            ...(await refuseRegressedCounter(tx, row, check.received, client)),
            userId: row.userId,
          };
        }
        return { ok: false, reason: "rejected", userId: row.userId };
      }
      const [account] = await tx
        .select({ email: users.email, disabledAt: users.disabledAt })
        .from(users)
        .where(eq(users.id, row.userId));
      if (!account || account.disabledAt !== null) {
        return { ok: false, reason: "account_disabled", userId: row.userId };
      }
      await markPasskeyUsed(tx, row.id, check.newCounter);
      return {
        ok: true,
        userId: row.userId,
        email: account.email,
        credentialId: row.id,
        loginTicket: taken.loginTicket,
      };
    }),
  );
}

/**
 * Opens the `mfa` session of a passwordless sign-in (#223), bound to the
 * passkey used (`credential_id`): removing the passkey ends every session
 * it opened, and a passkey removed since the check fails the insert
 * (foreign-key violation, `UserStoreError` with SQLSTATE `23503`), so a
 * removed passkey opens nothing.
 */
export async function openPasskeySession(
  userId: string,
  passkeyId: string,
  client: SessionClient,
): Promise<{ sessionId: string; token: string }> {
  return createSession({
    userId,
    assurance: "mfa",
    authMethod: PASSKEY_CREDENTIAL,
    credentialId: passkeyId,
    ...client,
  });
}
