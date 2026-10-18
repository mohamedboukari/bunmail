import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { config } from "../../../config.ts";
import { db } from "../../../db/index.ts";
import { logger } from "../../../utils/logger.ts";
import { redactEmail } from "../../../utils/redact.ts";
import { withSanitizedErrors } from "../errors.ts";
import { users } from "../models/user.schema.ts";
import { userCredentials } from "../models/user-credential.schema.ts";
import { userTokens } from "../models/user-token.schema.ts";
import {
  isInviteRole,
  isUserRole,
  type AccountAction,
  type AccountActionResult,
  type AccountRefusal,
  type AccountSummary,
  type AttemptLimiter,
  type IssuedPasswordReset,
  type IssuePasswordResetResult,
  type ContentRecordCounts,
  type Tx,
  type UserRole,
} from "../types/user.types.ts";
import { revokeInvitesIssuedBy } from "./invite.service.ts";
import { withOwnerLock } from "./owner.service.ts";
import { buildPasswordResetUrl } from "./password-reset-policy.service.ts";
import { replaceResetToken, revokeResetLinks } from "./password-reset.service.ts";
import { verifyPassword } from "./password.service.ts";
import {
  disableKeysCreatedBy,
  downgradeAdminKeysCreatedBy,
  moveOwnerRecords,
} from "./record-ownership.service.ts";
import { revokeAllUserSessions } from "./session.service.ts";
import {
  accountActionRefusal,
  removalConfirmed,
  type AccountParty,
} from "./user-admin-policy.service.ts";

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

/** Longest account list the Users page shows; a backstop, not paging. */
const ACCOUNT_LIST_LIMIT = 1000;

/** Status of an account in a log line; `removed` once it is deleted. */
type AccountStatus = "active" | "disabled" | "removed";

/** An account row as the rules and the log lines need it. */
interface AccountRow extends AccountParty {
  /** Stored (lower-cased) email. PII: log it redacted. */
  email: string;
}

/** What an applied action changed, for its log line. */
interface AccountChange {
  oldRole?: UserRole;
  newRole?: UserRole;
  oldStatus?: AccountStatus;
  newStatus?: AccountStatus;
  sessionsRevoked?: number;
  invitesRevoked?: number;
  /** The previous owner's new role (ownership transfer). */
  previousOwnerRole?: UserRole;
  /** Open owner setup links revoked (ownership transfer). */
  setupLinksRevoked?: number;
  /** The target's email, redacted: only for a removal, whose row is gone. */
  email?: string;
  /** Open password reset links revoked (#277). */
  resetLinksRevoked?: number;
  /** `user_tokens.id` of a new password reset link (#277); never the token. */
  resetId?: string;
  /** API keys of the target disabled (#219, deactivation and removal). */
  keysDisabled?: number;
  /** Admin API keys of the target made restricted (#219, demotion to member). */
  adminKeysDowngraded?: number;
  /** Templates, domains and webhooks moved to the new owner (#219, ownership transfer; keys never move). */
  recordsMoved?: ContentRecordCounts;
  /** When that link expires, ISO 8601. */
  expiresAt?: string;
}

/** Outcome of the locked part of an action. */
type LockedOutcome =
  | { ok: true; actorRole: UserRole; change: AccountChange }
  | { ok: false; reason: AccountRefusal; actorRole?: UserRole; targetRole?: UserRole };

/** The log message of each applied action. */
const APPLIED_MESSAGE: Record<AccountAction, string> = {
  change_role: "Account role changed",
  deactivate: "Account deactivated",
  reactivate: "Account reactivated",
  remove: "Account removed",
  transfer_ownership: "Ownership transferred",
  reset_password: "Password reset link issued",
};

/** `active` or `disabled`, from the row. */
function statusOf(account: AccountParty): AccountStatus {
  return account.disabled ? "disabled" : "active";
}

/** The columns an `AccountRow` is built from. */
const ACCOUNT_COLUMNS = {
  id: users.id,
  email: users.email,
  role: users.role,
  disabledAt: users.disabledAt,
};

/**
 * Builds an `AccountRow` from a selected row; `null` when there is no row
 * or its role is unknown (unreachable while `users_role_check` holds:
 * fail closed, never guess).
 */
function toAccountRow(
  row: { id: string; email: string; role: string; disabledAt: Date | null } | undefined,
): AccountRow | null {
  if (!row || !isUserRole(row.role)) return null;
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    disabled: row.disabledAt !== null,
  };
}

/**
 * Reads one account and locks its row (`FOR NO KEY UPDATE`: blocks other
 * writers of the row, not an invitation insert that references it).
 */
async function lockAccount(tx: Tx, id: string): Promise<AccountRow | null> {
  const [row] = await tx
    .select(ACCOUNT_COLUMNS)
    .from(users)
    .where(eq(users.id, id))
    .limit(1)
    .for("no key update");
  return toAccountRow(row);
}

/** Logs a refused action at `warn`: IDs, roles and the reason only. */
function logRefusal(
  action: AccountAction,
  actorId: string,
  targetUserId: string,
  details: { reason: AccountRefusal; actorRole?: UserRole; targetRole?: UserRole },
): void {
  logger.warn("Account action refused", { action, actorId, targetUserId, ...details });
}

/**
 * Runs one action: under the owner lock, reads and locks the actor and the
 * target, checks the rules (`accountActionRefusal`) against those live
 * rows, then lets `mutate` check its own input and write. `mutate`
 * returns the change for the log line, or a refusal (nothing written).
 * Logs the outcome after the transaction, so a rolled-back change is
 * never logged as applied.
 */
async function runAccountAction(
  action: AccountAction,
  actorId: string,
  targetId: string,
  mutate: (
    tx: Tx,
    actor: AccountRow,
    target: AccountRow,
  ) => Promise<AccountChange | AccountRefusal>,
): Promise<AccountActionResult> {
  const outcome = await withOwnerLock(async (tx): Promise<LockedOutcome> => {
    const actor = await lockAccount(tx, actorId);
    if (!actor || actor.disabled) return { ok: false, reason: "actor_inactive" };
    const target = await lockAccount(tx, targetId);
    if (!target) return { ok: false, reason: "not_found", actorRole: actor.role };
    const roles = { actorRole: actor.role, targetRole: target.role };

    const refusal = accountActionRefusal(action, actor, target);
    if (refusal) return { ok: false, reason: refusal, ...roles };

    const result = await mutate(tx, actor, target);
    if (typeof result === "string") return { ok: false, reason: result, ...roles };
    return { ok: true, actorRole: actor.role, change: result };
  });

  if (!outcome.ok) {
    logRefusal(action, actorId, targetId, {
      reason: outcome.reason,
      actorRole: outcome.actorRole,
      targetRole: outcome.targetRole,
    });
    return { ok: false, reason: outcome.reason };
  }
  logger.info(APPLIED_MESSAGE[action], {
    action,
    actorId,
    actorRole: outcome.actorRole,
    targetUserId: targetId,
    ...outcome.change,
  });
  return { ok: true };
}

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
): Promise<AccountActionResult> {
  return runAccountAction("deactivate", actorId, targetId, async (tx, _actor, target) => {
    await tx
      .update(users)
      .set({ disabledAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(users.id, target.id));
    const sessionsRevoked = await revokeAllUserSessions(target.id, tx);
    const invitesRevoked = await revokeInvitesIssuedBy(tx, target.id);
    const resetLinksRevoked =
      (await revokeResetLinks(tx, { userId: target.id })) +
      (await revokeResetLinks(tx, { issuedBy: target.id }));
    const keysDisabled = await disableKeysCreatedBy(tx, target.id, "creator_deactivated");
    return {
      oldStatus: statusOf(target),
      newStatus: "disabled",
      sessionsRevoked,
      invitesRevoked,
      resetLinksRevoked,
      keysDisabled,
    };
  });
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
): Promise<AccountActionResult> {
  return runAccountAction("reactivate", actorId, targetId, async (tx, _actor, target) => {
    await tx
      .update(users)
      .set({ disabledAt: null, updatedAt: sql`now()` })
      .where(eq(users.id, target.id));
    const sessionsRevoked = await revokeAllUserSessions(target.id, tx);
    return { oldStatus: statusOf(target), newStatus: "active", sessionsRevoked };
  });
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
): Promise<AccountActionResult> {
  return runAccountAction("remove", actorId, targetId, async (tx, _actor, target) => {
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
  });
}

/** The actor's `password` credential hash, or `null` when it has none. */
async function passwordHashOf(userId: string): Promise<string | null> {
  const [row] = await withSanitizedErrors(() =>
    db
      .select({ secretHash: userCredentials.secretHash })
      .from(userCredentials)
      .where(
        and(eq(userCredentials.userId, userId), eq(userCredentials.type, "password")),
      )
      .limit(1),
  );
  return row?.secretHash ?? null;
}

/** Reads an account without locking it, for the checks before argon2id. */
async function readAccount(id: string): Promise<AccountRow | null> {
  const [row] = await withSanitizedErrors(() =>
    db.select(ACCOUNT_COLUMNS).from(users).where(eq(users.id, id)).limit(1),
  );
  return toAccountRow(row);
}

/**
 * Makes an active admin the owner (owner only), confirmed with the
 * owner's current password. In order:
 *
 * 1. The rules, on rows read without a lock: a request that would be
 *    refused anyway never reaches argon2id.
 * 2. The failed-attempt budget (`limiter`, per actor and per client IP,
 *    built by the route from the login limiter): over budget is refused
 *    (`rate_limited`) with no argon2id work. Otherwise the attempt is
 *    counted at once, before the verify and with no await in between, so
 *    a parallel burst cannot run more verifies than the budget allows.
 * 3. The password, checked outside the lock so it is never held during
 *    argon2id. Wrong (or no password credential): refused, nothing changes.
 * 4. Under the owner lock, the rules again on the locked live rows (a
 *    concurrent transfer or deactivation may have won), then: revoke the
 *    open password reset links the owner issued for admins and every open
 *    reset link of the target, whoever issued it (#277; they would
 *    otherwise come back to life if ownership returned), demote the
 *    owner to admin, promote the target to owner (in that order, so the
 *    single-owner index holds at every statement), revoke the previous
 *    owner's open `admin` invitations, and revoke every open owner setup
 *    link (one minted for the previous owner by `reset-owner` would
 *    otherwise come back to life if ownership ever returned to it), and
 *    move the previous owner's templates, domains and webhooks (and rows
 *    with no creator, which were the owner's) to the new owner (#219;
 *    API keys stay with their creator). Sessions are untouched: both accounts stay signed in, with
 *    their new roles from the next request.
 * 5. A completed transfer clears the budget.
 */
export async function transferOwnership(
  actorId: string,
  targetId: string,
  password: string,
  limiter: AttemptLimiter,
): Promise<AccountActionResult> {
  const action: AccountAction = "transfer_ownership";
  const [actor, target] = await Promise.all([
    readAccount(actorId),
    readAccount(targetId),
  ]);
  if (!actor || actor.disabled) {
    logRefusal(action, actorId, targetId, { reason: "actor_inactive" });
    return { ok: false, reason: "actor_inactive" };
  }
  if (!target) {
    logRefusal(action, actorId, targetId, { reason: "not_found", actorRole: actor.role });
    return { ok: false, reason: "not_found" };
  }
  const early = accountActionRefusal(action, actor, target);
  if (early) {
    logRefusal(action, actorId, targetId, {
      reason: early,
      actorRole: actor.role,
      targetRole: target.role,
    });
    return { ok: false, reason: early };
  }

  /** Checked and counted with no await in between (see step 2 above). */
  if (limiter.isLimited()) {
    logRefusal(action, actorId, targetId, {
      reason: "rate_limited",
      actorRole: actor.role,
      targetRole: target.role,
    });
    return { ok: false, reason: "rate_limited" };
  }
  limiter.record();

  const hash = await passwordHashOf(actorId);
  if (hash === null || !(await verifyPassword(password, hash))) {
    logRefusal(action, actorId, targetId, {
      reason: "wrong_password",
      actorRole: actor.role,
      targetRole: target.role,
    });
    return { ok: false, reason: "wrong_password" };
  }

  const result = await runAccountAction(
    action,
    actorId,
    targetId,
    async (tx, owner, newOwner) => {
      /**
       * Before the role changes (#277): the previous owner's links for
       * admins, and every open link of the new owner whoever issued it.
       */
      const resetLinksRevoked =
        (await revokeResetLinks(tx, { issuedBy: owner.id, targetRole: "admin" })) +
        (await revokeResetLinks(tx, { userId: newOwner.id }));
      await tx
        .update(users)
        .set({ role: "admin", updatedAt: sql`now()` })
        .where(eq(users.id, owner.id));
      await tx
        .update(users)
        .set({ role: "owner", updatedAt: sql`now()` })
        .where(eq(users.id, newOwner.id));
      const invitesRevoked = await revokeInvitesIssuedBy(tx, owner.id, "admin");
      const setupLinks = await tx
        .update(userTokens)
        .set({ revokedAt: sql`now()` })
        .where(
          and(
            eq(userTokens.purpose, "owner_setup"),
            isNull(userTokens.usedAt),
            isNull(userTokens.revokedAt),
          ),
        )
        .returning({ id: userTokens.id });
      const recordsMoved = await moveOwnerRecords(tx, owner.id, newOwner.id);
      return {
        oldRole: newOwner.role,
        newRole: "owner",
        previousOwnerRole: "admin",
        invitesRevoked,
        setupLinksRevoked: setupLinks.length,
        resetLinksRevoked,
        recordsMoved,
      };
    },
  );
  if (result.ok) limiter.clear();
  return result;
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
