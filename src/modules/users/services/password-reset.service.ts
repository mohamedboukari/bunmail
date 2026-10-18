import { and, eq, gt, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { generateId } from "../../../utils/id.ts";
import { withSanitizedErrors } from "../errors.ts";
import { users } from "../models/user.schema.ts";
import { userCredentials } from "../models/user-credential.schema.ts";
import { userTokens } from "../models/user-token.schema.ts";
import {
  USER_ROLES,
  literals,
  type CompletePasswordResetResult,
  type DbExecutor,
  type IssuedPasswordReset,
  type PasswordResetTarget,
  type SessionClient,
  type TokenPurpose,
  type Tx,
  type UserRole,
} from "../types/user.types.ts";
import { grantableRoles } from "./invite-policy.service.ts";
import { revokeInvitesIssuedBy } from "./invite.service.ts";
import { withOwnerLock } from "./owner.service.ts";
import { PASSWORD_RESET_TTL_MINUTES } from "./password-reset-policy.service.ts";
import { hashPassword } from "./password.service.ts";
import { createSession, revokeAllUserSessions } from "./session.service.ts";
import { removeTwoFactor } from "./two-factor.service.ts";
import { locateSession } from "./session-location.service.ts";
import { sessionIp } from "./session-policy.service.ts";
import { hashToken, mintToken } from "./token.service.ts";

/**
 * Admin-issued password reset links (#277).
 *
 * An admin or the owner issues a link for an account it may manage from
 * the Users page (`issuePasswordReset` in `user-admin.service.ts` checks
 * the rules on the live rows under the `bunmail:owner` lock and calls
 * `replaceResetToken` here). The link is a `user_tokens` row of purpose
 * `password_reset`: `user_id` is the account, `invited_by` records who
 * issued it, 256-bit token with only its SHA-256 stored, one hour to live
 * on the database clock. It is shown once to the issuer and never emailed.
 * One live link per account: issuing a new one revokes the earlier ones.
 *
 * Completing it (`/dashboard/reset`) spends the token with a conditional
 * `UPDATE` that re-checks, on the live rows, that the account still
 * exists and is enabled, and that the issuer still exists, is enabled and
 * may still manage the account's current role. It then replaces the
 * password (every session bound to the old credential goes with it, by
 * cascade), signs the account out everywhere, revokes its other open
 * tokens and the invitations and reset links it issued, and opens a fresh
 * session bound to the new credential, all in one transaction under the
 * owner lock (so it never interleaves with a role change, a deactivation
 * or a removal).
 *
 * Never logs a token, its hash, the link or a password; callers log the
 * outcome. Database errors leave this module as `UserStoreError`
 * (SQLSTATE only).
 */

/** The token purpose this service mints and spends. */
const PASSWORD_RESET: TokenPurpose = "password_reset";

/** The credential type the reset form replaces. */
const PASSWORD_CREDENTIAL = "password";

/** An open reset link: not spent, not revoked (may be expired). */
function openReset(): SQL | undefined {
  return and(
    eq(userTokens.purpose, PASSWORD_RESET),
    isNull(userTokens.usedAt),
    isNull(userTokens.revokedAt),
  );
}

/**
 * The issuer may still manage the account: `invited_by` names an
 * existing, enabled account other than the target, the target still
 * exists and is enabled, and the issuer's current role manages the
 * target's current role (`grantableRoles`, the same table as the Users
 * page's `canManage`: the owner manages admins and members, an admin
 * members; nobody manages the owner). Literal value lists (code
 * constants). A link whose issuer was deleted (`invited_by` set to NULL),
 * disabled or demoted, or whose account was disabled or promoted beyond
 * the issuer's reach, can no longer be used.
 */
function issuerStillManages(): SQL {
  const clauses = USER_ROLES.filter((role) => grantableRoles(role).length > 0).map(
    (role) =>
      sql`(issuer.role = ${sql.raw(`'${role}'`)} AND target.role IN (${literals(grantableRoles(role))}))`,
  );
  return sql`EXISTS (SELECT 1 FROM ${users} AS issuer, ${users} AS target WHERE issuer.id = ${userTokens.invitedBy} AND target.id = ${userTokens.userId} AND issuer.id <> target.id AND issuer.disabled_at IS NULL AND target.disabled_at IS NULL AND (${sql.join(clauses, sql` OR `)}))`;
}

/**
 * A usable reset link: open, unexpired on the database clock (`now()`,
 * so replicas with skewed clocks agree), and its issuer still manages
 * the account.
 */
function usableReset(): SQL | undefined {
  return and(openReset(), gt(userTokens.expiresAt, sql`now()`), issuerStillManages());
}

/** Which open reset links `revokeResetLinks` revokes. */
type ResetLinkMatch =
  | { userId: string }
  | {
      issuedBy: string;
      /** Only links whose account currently has this role. */
      targetRole?: UserRole;
    };

/** The `WHERE` clause (besides "open") for a `ResetLinkMatch`. */
function resetLinkMatch(match: ResetLinkMatch): SQL | undefined {
  if ("userId" in match) return eq(userTokens.userId, match.userId);
  const { targetRole } = match;
  return and(
    eq(userTokens.invitedBy, match.issuedBy),
    targetRole === undefined
      ? undefined
      : inArray(
          userTokens.userId,
          db.select({ id: users.id }).from(users).where(eq(users.role, targetRole)),
        ),
  );
}

/**
 * Revokes open reset links: those for the account `userId`, or those the
 * account `issuedBy` issued (only for accounts of `targetRole`, when
 * given). Housekeeping for deactivation, demotion and ownership transfer
 * (#218): `usableReset` already refuses those links, but a link must not
 * come back to life when the account is reactivated or promoted again, or
 * ownership comes back, within the hour.
 *
 * @returns how many links were revoked.
 */
export async function revokeResetLinks(
  executor: DbExecutor,
  match: ResetLinkMatch,
): Promise<number> {
  const rows = await executor
    .update(userTokens)
    .set({ revokedAt: sql`now()` })
    .where(and(openReset(), resetLinkMatch(match)))
    .returning({ id: userTokens.id });
  return rows.length;
}

/**
 * Replaces the open reset links of `userId` with a fresh one issued by
 * `issuerId`. Must run under the owner lock (the caller checked the rules
 * on the locked rows), which is what keeps "one live link per account"
 * true. The expiry is set on the database clock, the interval inlined as
 * a literal (a code constant), and read back.
 */
export async function replaceResetToken(
  tx: Tx,
  userId: string,
  issuerId: string,
): Promise<IssuedPasswordReset> {
  const replaced = await revokeResetLinks(tx, { userId });
  const { token, hash } = mintToken();
  const resetId = generateId("utk");
  const [inserted] = await tx
    .insert(userTokens)
    .values({
      id: resetId,
      userId,
      purpose: PASSWORD_RESET,
      invitedBy: issuerId,
      tokenHash: hash,
      expiresAt: sql`now() + ${sql.raw(`interval '${Math.trunc(PASSWORD_RESET_TTL_MINUTES)} minutes'`)}`,
    })
    .returning({ expiresAt: userTokens.expiresAt });
  /** Unreachable: an INSERT ... RETURNING that did not throw returns its row. */
  if (!inserted) throw new Error("Password reset insert returned no row");
  return { resetId, token, expiresAt: inserted.expiresAt, replaced };
}

/**
 * Looks up a usable reset token (see `usableReset`). Read-only: `GET
 * /dashboard/reset` uses it to render the form without spending the
 * token, so link scanners and prefetchers cannot burn it. Returns `null`
 * for every invalid case so callers cannot tell them apart.
 */
export async function findLivePasswordReset(
  token: string,
): Promise<PasswordResetTarget | null> {
  const [row] = await withSanitizedErrors(() =>
    db
      .select({ resetId: userTokens.id, userId: users.id, email: users.email })
      .from(userTokens)
      .innerJoin(users, eq(users.id, userTokens.userId))
      .where(and(usableReset(), eq(userTokens.tokenHash, hashToken(token))))
      .limit(1),
  );
  return row ?? null;
}

/**
 * Completes a password reset (#277). Order matters on this
 * unauthenticated path:
 *
 * 1. A cheap indexed lookup first: a dead token never reaches argon2id.
 * 2. `hashPassword` outside the transaction, so the owner lock is never
 *    held during argon2id.
 * 3. Under the owner lock, in one transaction: spend the token with a
 *    conditional `UPDATE ... SET used_at = now()` on `usableReset` (an
 *    issuer or account changed since the lookup makes it invalid; a
 *    concurrent second submission gets no row); replace the `password`
 *    credential (sessions bound to the old one go with it, by cascade);
 *    revoke every other open token of the account, and the invitations
 *    and reset links it issued; delete every session of the account; open the new session (after the
 *    delete, so it survives); touch `users.updated_at`.
 *
 * The account's TOTP second factor and recovery codes are removed too
 * (#220): an admin-issued reset is the recovery path for a lost
 * authenticator, and the session opened here is a `password` session of
 * an account without a second factor (under `REQUIRE_2FA` the user then
 * has to enrol again before using the dashboard).
 *
 * All or nothing: a failure rolls back every step, sessions included.
 *
 * @param password - Already checked against the setup policy by the caller.
 * @param client   - Request metadata stored with the new session.
 */
export async function completePasswordReset(
  token: string,
  password: string,
  client: SessionClient = { ip: null, userAgent: null },
): Promise<CompletePasswordResetResult> {
  if (!(await findLivePasswordReset(token))) return { ok: false, reason: "invalid" };

  const secretHash = await hashPassword(password);
  const tokenHash = hashToken(token);

  const result = await withOwnerLock(async (tx): Promise<CompletePasswordResetResult> => {
    const [spent] = await tx
      .update(userTokens)
      .set({ usedAt: sql`now()` })
      .where(and(usableReset(), eq(userTokens.tokenHash, tokenHash)))
      .returning({
        resetId: userTokens.id,
        userId: userTokens.userId,
        issuedBy: userTokens.invitedBy,
      });
    if (!spent?.userId || !spent.issuedBy) return { ok: false, reason: "invalid" };
    const { resetId, userId, issuedBy } = spent;

    await tx
      .delete(userCredentials)
      .where(
        and(
          eq(userCredentials.userId, userId),
          eq(userCredentials.type, PASSWORD_CREDENTIAL),
        ),
      );
    /**
     * Deleting the old credential also deletes, by cascade, every session
     * bound to it (`sessions.credential_id`), and makes a login that
     * verified the old password a moment ago fail to open its session.
     */
    const credentialId = generateId("crd");
    await tx.insert(userCredentials).values({
      id: credentialId,
      userId,
      type: PASSWORD_CREDENTIAL,
      secretHash,
    });
    const twoFactorRemoved = await removeTwoFactor(tx, userId);

    const revokedTokens = await tx
      .update(userTokens)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(userTokens.userId, userId),
          isNull(userTokens.usedAt),
          isNull(userTokens.revokedAt),
        ),
      )
      .returning({ id: userTokens.id });

    /**
     * What the account issued dies with its old password: whoever held it
     * may have issued invitations or reset links (deactivation does the
     * same). Its legitimate pending invitations die too; they can be sent
     * again.
     */
    const issuedTokensRevoked =
      (await revokeInvitesIssuedBy(tx, userId)) +
      (await revokeResetLinks(tx, { issuedBy: userId }));

    const sessionsRevoked = await revokeAllUserSessions(userId, tx);
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

    const [account] = await tx
      .update(users)
      .set({ updatedAt: sql`now()` })
      .where(eq(users.id, userId))
      .returning({ email: users.email });
    /** Unreachable: `usableReset` saw the account under the same lock. Rolls back. */
    if (!account) throw new Error("Password reset account vanished");

    return {
      ok: true,
      resetId,
      userId,
      email: account.email,
      issuedBy,
      sessionsRevoked,
      tokensRevoked: revokedTokens.length,
      issuedTokensRevoked,
      twoFactorRemoved,
      sessionId: session.sessionId,
      sessionToken: session.token,
    };
  });
  /** Committed: look the new session's location up in the background (#281). */
  if (result.ok) void locateSession(result.sessionId, sessionIp(client.ip));
  return result;
}
