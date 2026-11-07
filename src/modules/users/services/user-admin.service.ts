import { asc, eq, sql } from "drizzle-orm";
import { config } from "../../../config.ts";
import { db } from "../../../db/index.ts";
import { logger } from "../../../utils/logger.ts";
import { redactEmail } from "../../../utils/redact.ts";
import { withSanitizedErrors } from "../errors.ts";
import { users } from "../models/user.schema.ts";
import {
  isInviteRole,
  isUserRole,
  type AccountActionResult,
  type AccountSummary,
  type IssuedPasswordReset,
  type IssuePasswordResetResult,
  type SessionClient,
} from "../types/user.types.ts";
import { revokeInvitesIssuedBy } from "./invite.service.ts";
import { buildPasswordResetUrl } from "./password-reset-policy.service.ts";
import { replaceResetToken, revokeResetLinks } from "./password-reset.service.ts";
import {
  disableKeysCreatedBy,
  downgradeAdminKeysCreatedBy,
} from "./record-ownership.service.ts";
import { revokeAllUserSessions } from "./session.service.ts";
import { removalConfirmed } from "./user-admin-policy.service.ts";
import {
  ACCOUNT_LIST_LIMIT,
  NO_CLIENT,
  logRefusal,
  runAccountAction,
  statusOf,
} from "./user-admin-action.service.ts";

/**
 * Account management for the Users page (#218): change a role, deactivate,
 * reactivate, remove, transfer ownership, issue a password reset link
 * (#277). Who may do what lives in
 * `user-admin-policy.service.ts`; this module applies it to the live rows.
 *
 * Every action runs in one transaction under the `bunmail:owner` advisory
 * lock (`withOwnerLock`), so two actions never interleave: two admins
 * acting at once, or two ownership transfers racing, are applied one after
 * the other, each against what the previous one committed. Inside it, the
 * actor's and the target's rows are read with `FOR NO KEY UPDATE` and the
 * rules are checked against those LIVE values, never against the role the
 * request's session carried. The single-owner index (`users_single_owner`)
 * holds at every statement: a transfer demotes the owner before it
 * promotes the new one.
 *
 * Side effects run in the same transaction as the change:
 *
 * - deactivate and remove: every session of the target is deleted, the
 *   open invitations the target issued are revoked, and every active API
 *   key the target created is disabled (#219, with the reason
 *   `creator_deactivated` or `creator_removed`; removal disables them
 *   before the row delete sets their creator to null); deactivation also
 *   revokes the open password reset links for the target and those the
 *   target issued (#277: reactivation must not revive them);
 * - reactivate: every session of the target is deleted (a login that
 *   raced the deactivation cannot leave one behind); its API keys stay
 *   disabled (#219: a deactivation usually means a leaver or a suspected
 *   compromise, so the user creates new keys or an admin decides);
 * - admin to member: the open invitations and password reset links the
 *   target issued are revoked (a member can grant or manage nothing), and
 *   every admin API key it created becomes restricted (#219; the keys stay
 *   active, so their sending keeps working);
 *   member to admin: the target's own open reset links are revoked (#277);
 * - password reset (#277): the account's earlier open reset links are
 *   revoked and a new one is minted (`replaceResetToken`); sessions are
 *   untouched until the link is used;
 * - ownership transfer: the previous owner's open `admin` invitations are
 *   revoked (an admin cannot grant admin), and every open owner setup link
 *   too, the open password reset links it issued for admins (#277: an
 *   admin cannot manage an admin) and the new owner's own open reset links,
 *   whoever issued them; the previous owner's templates, domains and
 *   webhooks (and rows with no creator) move to the new owner (#219; API
 *   keys stay with their creator, so later account actions on the former
 *   owner still reach its keys);
 *   both accounts stay signed in. Its password check is throttled.
 *
 * Revoking those invitations is housekeeping: acceptance re-checks that
 * the inviter is enabled and may still grant the role (#217), so an
 * invitation issued in a race is dead anyway.
 *
 * Logs every outcome once: `info` for an applied change (action, actor,
 * target, old and new role or status), `warn` for a refusal (action,
 * reason). Emails only redacted, never a password. Database errors leave
 * this module as `UserStoreError` (SQLSTATE only).
 */

/**
 * The service's public surface (#387). The list and every action but the
 * ownership transfer live here; the rest is in one file per concern,
 * beside this one:
 *
 *   - `user-admin-action.service.ts`: running an action under the owner lock, its audit row and log line
 *   - `user-admin-transfer.service.ts`: the ownership transfer
 *
 * Importers keep using this module.
 */
export { transferOwnership } from "./user-admin-transfer.service.ts";

/**
 * Every account, oldest first, for the Users page. An unknown stored role
 * (unreachable while `users_role_check` holds) is skipped, never guessed.
 */
export async function listAccounts(): Promise<AccountSummary[]> {
  const rows = await withSanitizedErrors(() =>
    db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        disabledAt: users.disabledAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(asc(users.createdAt), asc(users.id))
      .limit(ACCOUNT_LIST_LIMIT),
  );
  const accounts: AccountSummary[] = [];
  for (const row of rows) {
    if (!isUserRole(row.role)) continue;
    accounts.push({
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      disabled: row.disabledAt !== null,
      createdAt: row.createdAt,
    });
  }
  return accounts;
}

/**
 * Changes an account's role between `member` and `admin` (owner only).
 * `rawRole` is the submitted value: `owner` or anything unknown is
 * `invalid_role`. Demoting an admin revokes the open invitations it
 * issued, and the password reset links it issued (#277), and makes every
 * admin API key it created restricted (#219: a member never holds a
 * management-plane key; the keys stay active); promoting a member revokes
 * its own open reset links (#277) and restores no key. The new role
 * applies on the target's next request (the session guard reads it every
 * time).
 */
export async function changeAccountRole(
  actorId: string,
  targetId: string,
  rawRole: string,
  client: SessionClient = NO_CLIENT,
): Promise<AccountActionResult> {
  if (!isInviteRole(rawRole)) {
    logRefusal("change_role", actorId, targetId, { reason: "invalid_role" });
    return { ok: false, reason: "invalid_role" };
  }
  const newRole = rawRole;
  return runAccountAction(
    "change_role",
    actorId,
    targetId,
    async (tx, _actor, target) => {
      if (target.role === newRole) return "unchanged";
      await tx
        .update(users)
        .set({ role: newRole, updatedAt: sql`now()` })
        .where(eq(users.id, target.id));
      if (newRole !== "member") {
        /**
         * Promotion: the account's open reset links are revoked (#277). One
         * issued while it was a member would otherwise come back to life
         * if it were demoted again within the hour.
         */
        const resetLinksRevoked = await revokeResetLinks(tx, { userId: target.id });
        return { oldRole: target.role, newRole, invitesRevoked: 0, resetLinksRevoked };
      }
      const invitesRevoked = await revokeInvitesIssuedBy(tx, target.id);
      const resetLinksRevoked = await revokeResetLinks(tx, { issuedBy: target.id });
      const adminKeysDowngraded = await downgradeAdminKeysCreatedBy(tx, target.id);
      return {
        oldRole: target.role,
        newRole,
        invitesRevoked,
        resetLinksRevoked,
        adminKeysDowngraded,
      };
    },
    client,
  );
}

/**
 * Deactivates an account: `disabled_at` is set (no login, the session
 * guard rejects it), every session is deleted, and the open invitations
 * it issued are revoked, as are the open password reset links for it and
 * those it issued (#277), so reactivating it revives none of them. Every
 * active API key it created is disabled (#219, `creator_deactivated`).
 */
export async function deactivateAccount(
  actorId: string,
  targetId: string,
  client: SessionClient = NO_CLIENT,
): Promise<AccountActionResult> {
  return runAccountAction(
    "deactivate",
    actorId,
    targetId,
    async (tx, _actor, target) => {
      await tx
        .update(users)
        .set({ disabledAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(users.id, target.id));
      const sessionsRevoked = await revokeAllUserSessions(target.id, tx);
      const invitesRevoked = await revokeInvitesIssuedBy(tx, target.id);
      const resetLinksRevoked =
        (await revokeResetLinks(tx, { userId: target.id })) +
        (await revokeResetLinks(tx, { issuedBy: target.id }));
      const keysDisabled = await disableKeysCreatedBy(
        tx,
        target.id,
        "creator_deactivated",
      );
      return {
        oldStatus: statusOf(target),
        newStatus: "disabled",
        sessionsRevoked,
        invitesRevoked,
        resetLinksRevoked,
        keysDisabled,
      };
    },
    client,
  );
}

/**
 * Reactivates a deactivated account: `disabled_at` is cleared, so it can
 * sign in again. Every session of the account is deleted in the same
 * transaction: a session created by a login that raced the deactivation
 * (its row inserted after the deactivation deleted the others) must never
 * come back to life. Its invitations stay revoked, and so do its API keys
 * (#219): reactivation never re-enables a key.
 */
export async function reactivateAccount(
  actorId: string,
  targetId: string,
  client: SessionClient = NO_CLIENT,
): Promise<AccountActionResult> {
  return runAccountAction(
    "reactivate",
    actorId,
    targetId,
    async (tx, _actor, target) => {
      await tx
        .update(users)
        .set({ disabledAt: null, updatedAt: sql`now()` })
        .where(eq(users.id, target.id));
      const sessionsRevoked = await revokeAllUserSessions(target.id, tx);
      return { oldStatus: statusOf(target), newStatus: "active", sessionsRevoked };
    },
    client,
  );
}

/**
 * Deletes an account for good. `confirm` must be the target's email
 * (trimmed, case-insensitive). The open invitations it issued are revoked
 * and its sessions deleted first (for the counts in the log line), and
 * every active API key it created is disabled (#219, `creator_removed`)
 * before the row delete, which cascades to its credentials and tokens and
 * sets `invited_by` on its past invitations and `created_by_user_id` on
 * its keys, templates, domains and webhooks to NULL (they then belong to
 * the owner; the next boot records that explicitly).
 */
export async function removeAccount(
  actorId: string,
  targetId: string,
  confirm: string,
  client: SessionClient = NO_CLIENT,
): Promise<AccountActionResult> {
  return runAccountAction(
    "remove",
    actorId,
    targetId,
    async (tx, _actor, target) => {
      if (!removalConfirmed(confirm, target.email)) return "confirm_mismatch";
      const invitesRevoked = await revokeInvitesIssuedBy(tx, target.id);
      const sessionsRevoked = await revokeAllUserSessions(target.id, tx);
      /** Before the delete: afterwards the keys no longer name their creator. */
      const keysDisabled = await disableKeysCreatedBy(tx, target.id, "creator_removed");
      await tx.delete(users).where(eq(users.id, target.id));
      return {
        oldRole: target.role,
        oldStatus: statusOf(target),
        newStatus: "removed",
        sessionsRevoked,
        invitesRevoked,
        keysDisabled,
        email: redactEmail(target.email),
      };
    },
    client,
  );
}

/**
 * Issues a one-time password reset link for an account (#277). The rules
 * (`reset_password` in `accountActionRefusal`: the owner resets admins and
 * members, an admin members; nobody their own account or the owner; not a
 * deactivated account) are checked on the live rows under the owner lock,
 * and the link is minted in the same transaction (`replaceResetToken`:
 * earlier open links of the account are revoked, the new one lives one
 * hour on the database clock, `invited_by` records the issuer).
 *
 * The link is built after commit, so a rolled-back token is never shown,
 * and returned for the caller's one-time reveal: it is never emailed,
 * stored, logged or put in a URL of ours. The account's sessions and
 * password are untouched until the link is used.
 */
export async function issuePasswordReset(
  actorId: string,
  targetId: string,
  client: SessionClient = NO_CLIENT,
): Promise<IssuePasswordResetResult> {
  /** Set by the locked step; a holder object, so TypeScript keeps its type. */
  const minted: { reset?: IssuedPasswordReset } = {};
  const result = await runAccountAction(
    "reset_password",
    actorId,
    targetId,
    async (tx, actor, target) => {
      const reset = await replaceResetToken(tx, target.id, actor.id);
      minted.reset = reset;
      return {
        resetId: reset.resetId,
        resetLinksRevoked: reset.replaced,
        expiresAt: reset.expiresAt.toISOString(),
      };
    },
    client,
  );
  if (!result.ok) return result;
  const { reset } = minted;
  /** Unreachable: an applied action ran the locked step. */
  if (!reset) throw new Error("Password reset applied without a token");

  const { url, usedFallback } = buildPasswordResetUrl(
    config.appBaseUrl,
    config.server.port,
    reset.token,
  );
  if (usedFallback) {
    logger.warn("Password reset link points at localhost", {
      resetId: reset.resetId,
      targetUserId: targetId,
      hint: "set APP_BASE_URL: the link points at http://localhost",
    });
  }
  return {
    ok: true,
    resetId: reset.resetId,
    url,
    usedFallback,
    expiresAt: reset.expiresAt,
  };
}
