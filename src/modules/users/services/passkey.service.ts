import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { withSanitizedErrors } from "../errors.ts";
import { users } from "../models/user.schema.ts";
import { userCredentials } from "../models/user-credential.schema.ts";
import type {
  AttemptLimiter,
  PasskeySummary,
  SessionClient,
} from "../types/user.types.ts";
import { recordAuditEvent } from "../../audit/services/audit.service.ts";
import { verifyPassword } from "./password.service.ts";
import {
  recordFactorRemovalRefused,
  removalBreaksOwnerSsoRule,
} from "./sso-owner-rule.service.ts";
import { passkeyNameProblem } from "./passkey-policy.service.ts";
import { passwordHashOf } from "./two-factor.service.ts";
import { NO_CLIENT, PASSKEY_CREDENTIAL } from "./passkey-store.service.ts";

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

/**
 * The service's public surface (#387). Listing, renaming and removing
 * passkeys live here; the rest is in one file per concern, beside this
 * one:
 *
 *   - `passkey-store.service.ts`: the stored passkey row, the account's passkeys
 *   - `passkey-registration.service.ts`: adding a passkey
 *   - `passkey-assertion.service.ts`: the second login step and the passwordless sign-in
 *
 * Importers keep using this module.
 */
export { startRegistration, finishRegistration } from "./passkey-registration.service.ts";
export {
  startPasskeyTwoFactor,
  completePasskeyTwoFactor,
  startPasskeySignIn,
  completePasskeySignIn,
  openPasskeySession,
} from "./passkey-assertion.service.ts";

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
  | {
      ok: false;
      reason:
        | "not_found"
        | "rate_limited"
        | "wrong_password"
        | "sso_link_requires_second_factor";
    };

/**
 * Removes one of the account's passkeys, after the current password. In
 * order: a passkey that is not this account's is answered `not_found` at
 * once, before any password work; the password budget (`limiter`, the
 * password change's keys) is checked and counted; one argon2id verify;
 * then, in one transaction, the account row is locked and the owner rule
 * of SSO checked (#224: the owner's last second factor stays while it has
 * an SSO link, `sso_link_requires_second_factor`, recorded as
 * `auth.two_factor.removal_refused`), the row is deleted (sessions opened
 * with it go too: they are bound to it) and `auth.passkey.removed`
 * recorded.
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
  if (await limiter.take()) return { ok: false, reason: "rate_limited" };
  const hash = await passwordHashOf(userId);
  if (hash === null || !(await verifyPassword(password, hash))) {
    return { ok: false, reason: "wrong_password" };
  }
  await limiter.clear();

  const result = await withSanitizedErrors(() =>
    db.transaction(async (tx): Promise<DeletePasskeyResult> => {
      if (await removalBreaksOwnerSsoRule(tx, userId, passkeyId)) {
        return { ok: false, reason: "sso_link_requires_second_factor" };
      }
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
  if (!result.ok && result.reason === "sso_link_requires_second_factor") {
    await recordFactorRemovalRefused(userId, "passkey", client);
  }
  return result;
}
