import { and, eq, sql } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { generateId } from "../../../utils/id.ts";
import { UserStoreError, withSanitizedErrors } from "../errors.ts";
import { users } from "../models/user.schema.ts";
import { userCredentials } from "../models/user-credential.schema.ts";
import { userTokens } from "../models/user-token.schema.ts";
import {
  isInviteRole,
  type AcceptInvitationResult,
  type InviteAcceptance,
  type InviteTarget,
  type SessionClient,
} from "../types/user.types.ts";
import { hashPassword } from "./password.service.ts";
import { createSession } from "./session.service.ts";
import { locateSession } from "./session-location.service.ts";
import { sessionIp } from "./session-policy.service.ts";
import { hashToken } from "./token.service.ts";
import { recordAuditEvent } from "../../audit/services/audit.service.ts";
import {
  PASSWORD_CREDENTIAL,
  UNIQUE_VIOLATION,
  acceptableInvite,
  emailHasAccount,
  revokeOpenInvites,
  withInviteLock,
} from "./invite-store.service.ts";

/**
 * Accepting an invitation (#217): the read-only token lookup for the form
 * and the acceptance transaction. The public surface is
 * `invite.service.ts`.
 */

/**
 * Looks up an acceptable invitation token: live, and its inviter still
 * an enabled account that may grant its role. Read-only: `GET
 * /dashboard/invite` uses it to render the form without spending the
 * token, so link scanners and prefetchers cannot burn it. Returns `null`
 * for every invalid case (unknown, expired, used, revoked, inviter gone,
 * disabled or demoted) so callers cannot tell them apart.
 */
export async function findLiveInvitation(token: string): Promise<InviteTarget | null> {
  const [row] = await withSanitizedErrors(() =>
    db
      .select({ id: userTokens.id, email: userTokens.email, role: userTokens.role })
      .from(userTokens)
      .where(and(acceptableInvite(), eq(userTokens.tokenHash, hashToken(token))))
      .limit(1),
  );
  if (!row?.email || !row.role || !isInviteRole(row.role)) return null;
  return { invitationId: row.id, email: row.email, role: row.role };
}

/**
 * Accepts an invitation: creates the account and signs it in (#217).
 * Order matters on this unauthenticated path:
 *
 * 1. A cheap indexed lookup first: a dead token never reaches argon2id.
 * 2. `hashPassword` outside the transaction, so the address lock is never
 *    held during argon2id.
 * 3. Under the address lock, in one transaction: refuse if an account
 *    took the address meanwhile (its open invitations are revoked, since
 *    none can be accepted any more); spend the token with a conditional
 *    `UPDATE ... SET used_at = now()` on the live predicate plus the
 *    inviter re-check (`inviterStillGrants`: an inviter deleted, disabled
 *    or demoted since sending makes the token invalid; a concurrent
 *    second submission gets no row); insert the user with the invited
 *    role and the name; insert the `password` credential; revoke every
 *    other open invitation for the address; open the session.
 *
 * `email_verified_at` stays null: the link may have been shared by hand
 * (when no system sender is configured), which proves nothing about the
 * mailbox.
 *
 * All or nothing: a failure rolls back every step. A unique violation on
 * `users.email` (an account created outside the invitation lock, e.g. the
 * owner bootstrap) is reported as `account_exists`.
 *
 * @param acceptance - Name (trimmed here again) and password, both
 *                     already checked against the policy by the caller.
 * @param client     - Request metadata stored with the new session.
 */
export async function acceptInvitation(
  token: string,
  acceptance: InviteAcceptance,
  client: SessionClient = { ip: null, userAgent: null },
): Promise<AcceptInvitationResult> {
  const target = await findLiveInvitation(token);
  if (!target) return { ok: false, reason: "invalid" };

  const secretHash = await hashPassword(acceptance.password);
  const tokenHash = hashToken(token);
  const name = acceptance.name.trim();

  let result: AcceptInvitationResult;
  try {
    result = await withInviteLock(
      target.email,
      async (tx): Promise<AcceptInvitationResult> => {
        if (await emailHasAccount(tx, target.email)) {
          await revokeOpenInvites(tx, target.email);
          return { ok: false, reason: "account_exists" };
        }

        const [spent] = await tx
          .update(userTokens)
          .set({ usedAt: sql`now()` })
          .where(and(acceptableInvite(), eq(userTokens.tokenHash, tokenHash)))
          .returning({
            invitationId: userTokens.id,
            email: userTokens.email,
            role: userTokens.role,
            invitedBy: userTokens.invitedBy,
          });
        if (!spent?.email || !spent.role || !isInviteRole(spent.role)) {
          return { ok: false, reason: "invalid" };
        }
        const { email, role } = spent;

        const userId = generateId("usr");
        await tx.insert(users).values({ id: userId, email, name, role });
        const credentialId = generateId("crd");
        await tx.insert(userCredentials).values({
          id: credentialId,
          userId,
          type: PASSWORD_CREDENTIAL,
          secretHash,
        });
        await revokeOpenInvites(tx, email);

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
        /** Recorded with the new account (#221): both commit, or neither. */
        await recordAuditEvent(
          {
            action: "user.invitation.accepted",
            actor: { type: "user", id: userId, label: email },
            ...client,
            target: { type: "invitation", id: spent.invitationId, label: email },
            metadata: { role, invitedBy: spent.invitedBy },
          },
          tx,
        );
        return {
          ok: true,
          userId,
          email,
          role,
          invitedBy: spent.invitedBy,
          sessionId: session.sessionId,
          sessionToken: session.token,
        };
      },
    );
  } catch (error: unknown) {
    if (error instanceof UserStoreError && error.sqlState === UNIQUE_VIOLATION) {
      return { ok: false, reason: "account_exists" };
    }
    throw error;
  }
  /** Committed: look the new session's location up in the background (#281). */
  if (result.ok) void locateSession(result.sessionId, sessionIp(client.ip));
  return result;
}
