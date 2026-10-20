import { and, asc, eq, ne, sql } from "drizzle-orm";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
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
  PasskeyFailure,
  PasskeySignInResult,
  PasskeySummary,
  PasskeyTwoFactorResult,
  PendingSession,
  RelyingParty,
  SessionClient,
  Tx,
} from "../types/user.types.ts";
import { recordAuditEvent } from "../../audit/services/audit.service.ts";
import { verifyPassword } from "./password.service.ts";
import { passkeyChallenges } from "./passkey-challenge.service.ts";
import {
  PASSKEY_CEREMONY_TIMEOUT_MS,
  PASSKEY_RP_NAME,
  counterRegressed,
  passkeyNameProblem,
  transportsFromColumn,
  transportsToColumn,
  userHandleOf,
} from "./passkey-policy.service.ts";
import {
  createSession,
  elevatePendingSession,
  lockPendingSession,
  raiseSessionToMfa,
} from "./session.service.ts";
import { hashToken, mintToken } from "./token.service.ts";
import { passwordHashOf } from "./two-factor.service.ts";

/**
 * Passkeys (WebAuthn) for the dashboard (#223): adding one, the second
 * login step with one, a passwordless sign-in with one, and listing,
 * renaming and removing them. Verification is `@simplewebauthn/server`
 * (pinned); this module decides what is asked for and what is accepted.
 *
 * **Storage.** A passkey is a `user_credentials` row of type `passkey`:
 * the credential id (base64url) in `provider_account_id` (unique across
 * every account), the COSE public key (base64url) in `public_key`, the
 * signature counter in `counter`, the user's label in `name`, the
 * reported transports in `transports`. Nothing secret is stored: the
 * private key never leaves the authenticator.
 *
 * **What every ceremony requires.** The relying party is `APP_BASE_URL`
 * (`relyingPartyFrom`): its hostname is the RP ID and its origin the only
 * origin accepted, compared exactly. `userVerification: "required"` (the
 * authenticator checked a PIN or a biometric), checked on every response;
 * `attestationType: "none"`; discoverable credentials
 * (`residentKey: "required"`), so a passwordless sign-in needs no email.
 * Challenges are single-use and live 5 minutes
 * (`passkey-challenge.service.ts`).
 *
 * **Clone detection.** The library is handed a stored counter of 0, so it
 * never refuses on the counter itself; this module applies the rule
 * (`counterRegressed`) only after the signature verified, so the alert
 * and the audit row it causes cannot be triggered without the key. A
 * regression refuses the assertion and is recorded
 * (`auth.passkey.counter_regressed`).
 *
 * Never logs a public key, a challenge or a response (the routes log with
 * their IDs). Database errors leave this module as `UserStoreError`.
 */

/** The credential type of a passkey. */
const PASSKEY_CREDENTIAL = "passkey";

/** SQLSTATE of a unique violation: the credential id is registered already. */
const UNIQUE_VIOLATION = "23505";

/** No request metadata (a script, a test): events are still recorded. */
const NO_CLIENT: SessionClient = { ip: null, userAgent: null };

/** A stored passkey, as the ceremonies read it. */
interface PasskeyRow {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  name: string;
  transports: string | null;
}

/** The passkey columns every ceremony selects. */
const passkeyColumns = {
  id: userCredentials.id,
  userId: userCredentials.userId,
  credentialId: userCredentials.providerAccountId,
  publicKey: userCredentials.publicKey,
  counter: userCredentials.counter,
  name: userCredentials.name,
  transports: userCredentials.transports,
};

/** A selected row with the columns that a passkey always has, or null when one is missing. */
function toPasskeyRow(row: {
  id: string;
  userId: string;
  credentialId: string | null;
  publicKey: string | null;
  counter: number | null;
  name: string | null;
  transports: string | null;
}): PasskeyRow | null {
  if (row.credentialId === null || row.publicKey === null) return null;
  return {
    id: row.id,
    userId: row.userId,
    credentialId: row.credentialId,
    publicKey: row.publicKey,
    counter: row.counter ?? 0,
    name: row.name ?? "Passkey",
    transports: row.transports,
  };
}

/** The account's passkeys, oldest first. */
async function passkeysOf(
  executor: typeof db | Tx,
  userId: string,
): Promise<PasskeyRow[]> {
  const rows = await executor
    .select(passkeyColumns)
    .from(userCredentials)
    .where(
      and(
        eq(userCredentials.userId, userId),
        eq(userCredentials.type, PASSKEY_CREDENTIAL),
      ),
    )
    .orderBy(asc(userCredentials.createdAt), asc(userCredentials.id));
  return rows.map(toPasskeyRow).filter((row) => row !== null);
}

/** Why a library call failed, for a `debug` line: the error class only (messages quote challenges). */
function failureName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

/* ─── Listing ─── */

/** The account's passkeys for the Passkeys page. Never the key or the counter. */
export async function listPasskeys(userId: string): Promise<PasskeySummary[]> {
  const rows = await withSanitizedErrors(() =>
    db
      .select({
        id: userCredentials.id,
        name: userCredentials.name,
        createdAt: userCredentials.createdAt,
        lastUsedAt: userCredentials.lastUsedAt,
      })
      .from(userCredentials)
      .where(
        and(
          eq(userCredentials.userId, userId),
          eq(userCredentials.type, PASSKEY_CREDENTIAL),
        ),
      )
      .orderBy(asc(userCredentials.createdAt), asc(userCredentials.id)),
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name ?? "Passkey",
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  }));
}

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
  if (limiter.isLimited()) return { ok: false, reason: "rate_limited" };
  limiter.record();
  const hash = await passwordHashOf(input.userId);
  if (hash === null || !(await verifyPassword(input.password, hash))) {
    return { ok: false, reason: "wrong_password" };
  }
  limiter.clear();

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
  if (limiter.isLimited()) return { ok: false, reason: "rate_limited" };
  limiter.record();
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
): Promise<{ binding: string; options: PublicKeyCredentialRequestOptionsJSON }> {
  const binding = mintToken().token;
  const challenge = passkeyChallenges.issue("sign_in", hashToken(binding), {
    userId: null,
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
      return { ok: true, userId: row.userId, email: account.email, credentialId: row.id };
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

/* ─── Managing ─── */

/**
 * Renames one of the account's passkeys. The ownership check is in the
 * `WHERE`, so another account's passkey id changes nothing (`not_found`).
 */
export async function renamePasskey(
  userId: string,
  passkeyId: string,
  name: string,
): Promise<
  | { ok: true }
  | { ok: false; reason: "invalid_name"; problem: string }
  | { ok: false; reason: "not_found" }
> {
  const problem = passkeyNameProblem(name);
  if (problem !== null) return { ok: false, reason: "invalid_name", problem };
  const rows = await withSanitizedErrors(() =>
    db
      .update(userCredentials)
      .set({ name, updatedAt: sql`now()` })
      .where(
        and(
          eq(userCredentials.id, passkeyId),
          eq(userCredentials.userId, userId),
          eq(userCredentials.type, PASSKEY_CREDENTIAL),
        ),
      )
      .returning({ id: userCredentials.id }),
  );
  return rows.length > 0 ? { ok: true } : { ok: false, reason: "not_found" };
}

/** Result of removing a passkey: its name, or why nothing was removed. */
type DeletePasskeyResult =
  | { ok: true; name: string }
  | { ok: false; reason: "not_found" | "rate_limited" | "wrong_password" };

/**
 * Removes one of the account's passkeys, after the current password. In
 * order: a passkey that is not this account's is answered `not_found` at
 * once, before any password work; the password budget (`limiter`, the
 * password change's keys) is checked and counted; one argon2id verify;
 * then the row is deleted (sessions opened with it go too: they are bound
 * to it) and `auth.passkey.removed` recorded, in one transaction.
 *
 * Removing the last second factor is allowed, as turning TOTP off is
 * (#220): under `REQUIRE_2FA` the guard then holds the account on its
 * Two-factor and Passkeys pages until it enrols again.
 */
export async function deletePasskey(
  userId: string,
  passkeyId: string,
  password: string,
  limiter: AttemptLimiter,
  client: SessionClient = NO_CLIENT,
): Promise<DeletePasskeyResult> {
  const [found] = await withSanitizedErrors(() =>
    db
      .select({ id: userCredentials.id })
      .from(userCredentials)
      .where(
        and(
          eq(userCredentials.id, passkeyId),
          eq(userCredentials.userId, userId),
          eq(userCredentials.type, PASSKEY_CREDENTIAL),
        ),
      ),
  );
  if (!found) return { ok: false, reason: "not_found" };
  if (limiter.isLimited()) return { ok: false, reason: "rate_limited" };
  limiter.record();
  const hash = await passwordHashOf(userId);
  if (hash === null || !(await verifyPassword(password, hash))) {
    return { ok: false, reason: "wrong_password" };
  }
  limiter.clear();

  return withSanitizedErrors(() =>
    db.transaction(async (tx): Promise<DeletePasskeyResult> => {
      const [removed] = await tx
        .delete(userCredentials)
        .where(
          and(
            eq(userCredentials.id, passkeyId),
            eq(userCredentials.userId, userId),
            eq(userCredentials.type, PASSKEY_CREDENTIAL),
          ),
        )
        .returning({ name: userCredentials.name });
      if (!removed) return { ok: false, reason: "not_found" };
      const name = removed.name ?? "Passkey";
      await tx
        .update(users)
        .set({ updatedAt: sql`now()` })
        .where(eq(users.id, userId));
      await recordAuditEvent(
        {
          action: "auth.passkey.removed",
          actor: { type: "user", id: userId },
          ...client,
          target: { type: "passkey", id: passkeyId, label: name },
        },
        tx,
      );
      return { ok: true, name };
    }),
  );
}
