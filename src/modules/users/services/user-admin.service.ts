import { and, asc, eq, isNull, sql } from "drizzle-orm";
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
  type DbExecutor,
  type InviteRole,
  type Tx,
  type UserRole,
} from "../types/user.types.ts";
import { withOwnerLock } from "./owner.service.ts";
import { verifyPassword } from "./password.service.ts";
import { revokeAllUserSessions } from "./session.service.ts";
import {
  accountActionRefusal,
  removalConfirmed,
  type AccountParty,
} from "./user-admin-policy.service.ts";

/**
 * Account management for the Users page (#218): change a role, deactivate,
 * reactivate, remove, transfer ownership. Who may do what lives in
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
 * - deactivate and remove: every session of the target is deleted, and
 *   the open invitations the target issued are revoked;
 * - reactivate: every session of the target is deleted (a login that
 *   raced the deactivation cannot leave one behind);
 * - admin to member: the open invitations the target issued are revoked
 *   (a member can grant nothing);
 * - ownership transfer: the previous owner's open `admin` invitations are
 *   revoked (an admin cannot grant admin), and every open owner setup link
 *   too; both accounts stay signed in. Its password check is throttled.
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

/**
 * Revokes the open (unspent, unrevoked) invitations `inviterId` issued,
 * or only those granting `role` when it is given.
 *
 * @returns how many invitations were revoked.
 */
async function revokeInvitesIssuedBy(
  executor: DbExecutor,
  inviterId: string,
  role?: InviteRole,
): Promise<number> {
  const rows = await executor
    .update(userTokens)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(userTokens.purpose, "invite"),
        isNull(userTokens.usedAt),
        isNull(userTokens.revokedAt),
        eq(userTokens.invitedBy, inviterId),
        role === undefined ? undefined : eq(userTokens.role, role),
      ),
    )
    .returning({ id: userTokens.id });
  return rows.length;
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
 * issued. The new role applies on the target's next request (the session
 * guard reads it every time).
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
      const invitesRevoked =
        newRole === "member" ? await revokeInvitesIssuedBy(tx, target.id) : 0;
      return { oldRole: target.role, newRole, invitesRevoked };
    },
  );
}

/**
 * Deactivates an account: `disabled_at` is set (no login, the session
 * guard rejects it), every session is deleted, and the open invitations
 * it issued are revoked.
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
    return {
      oldStatus: statusOf(target),
      newStatus: "disabled",
      sessionsRevoked,
      invitesRevoked,
    };
  });
}

/**
 * Reactivates a deactivated account: `disabled_at` is cleared, so it can
 * sign in again. Every session of the account is deleted in the same
 * transaction: a session created by a login that raced the deactivation
 * (its row inserted after the deactivation deleted the others) must never
 * come back to life. Its invitations stay revoked.
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
 * and its sessions deleted first (for the counts in the log line); the
 * row delete then cascades to its credentials and tokens, and
 * `invited_by` on its past invitations becomes NULL.
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
    await tx.delete(users).where(eq(users.id, target.id));
    return {
      oldRole: target.role,
      oldStatus: statusOf(target),
      newStatus: "removed",
      sessionsRevoked,
      invitesRevoked,
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
 *    concurrent transfer or deactivation may have won), then: demote the
 *    owner to admin, promote the target to owner (in that order, so the
 *    single-owner index holds at every statement), revoke the previous
 *    owner's open `admin` invitations, and revoke every open owner setup
 *    link (one minted for the previous owner by `reset-owner` would
 *    otherwise come back to life if ownership ever returned to it).
 *    Sessions are untouched: both accounts stay signed in, with their new
 *    roles from the next request.
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
      return {
        oldRole: newOwner.role,
        newRole: "owner",
        previousOwnerRole: "admin",
        invitesRevoked,
        setupLinksRevoked: setupLinks.length,
      };
    },
  );
  if (result.ok) limiter.clear();
  return result;
}
