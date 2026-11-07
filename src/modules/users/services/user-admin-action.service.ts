import { eq } from "drizzle-orm";
import { logger } from "../../../utils/logger.ts";
import { recordAuditEvent } from "../../audit/services/audit.service.ts";
import { users } from "../models/user.schema.ts";
import {
  isUserRole,
  type AccountAction,
  type AccountActionResult,
  type AccountRefusal,
  type ContentRecordCounts,
  type SessionClient,
  type Tx,
  type UserRole,
} from "../types/user.types.ts";
import { withOwnerLock } from "./owner.service.ts";
import { accountActionRefusal, type AccountParty } from "./user-admin-policy.service.ts";

/**
 * How an account action runs (#218): under the owner lock, on the locked
 * live rows, with its audit row and its one log line. The public surface
 * is `user-admin.service.ts`.
 */

/** Longest account list the Users page shows; a backstop, not paging. */
export const ACCOUNT_LIST_LIMIT = 1000;

/** No request metadata (a script, a test): the event is still recorded. */
export const NO_CLIENT: SessionClient = { ip: null, userAgent: null };

/** Status of an account in a log line; `removed` once it is deleted. */
type AccountStatus = "active" | "disabled" | "removed";

/** An account row as the rules and the log lines need it. */
export interface AccountRow extends AccountParty {
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
export function statusOf(account: AccountParty): AccountStatus {
  return account.disabled ? "disabled" : "active";
}

/** The columns an `AccountRow` is built from. */
export const ACCOUNT_COLUMNS = {
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
export function toAccountRow(
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
 * Writes an applied action to the audit log (#221), inside its
 * transaction: the change and its record commit together. The actor and
 * the target come from the locked rows, so the labels are the live
 * emails (the target's is passed explicitly: a removal deletes the row).
 */
async function recordAccountAction(
  tx: Tx,
  action: AccountAction,
  parties: { actor: AccountRow; target: AccountRow; change: AccountChange },
  client: SessionClient,
): Promise<void> {
  const { actor, target, change } = parties;
  const common = {
    actor: { type: "user" as const, id: actor.id, label: actor.email },
    ...client,
    target: { type: "user" as const, id: target.id, label: target.email },
  };
  switch (action) {
    case "change_role":
      await recordAuditEvent(
        {
          ...common,
          action: "user.role.changed",
          metadata: { from: target.role, to: change.newRole ?? target.role },
        },
        tx,
      );
      return;
    case "deactivate":
      await recordAuditEvent(
        {
          ...common,
          action: "user.deactivated",
          metadata: {
            sessionsRevoked: change.sessionsRevoked ?? 0,
            keysDisabled: change.keysDisabled ?? 0,
          },
        },
        tx,
      );
      return;
    case "reactivate":
      await recordAuditEvent({ ...common, action: "user.reactivated" }, tx);
      return;
    case "remove":
      await recordAuditEvent(
        {
          ...common,
          action: "user.removed",
          metadata: { role: target.role, keysDisabled: change.keysDisabled ?? 0 },
        },
        tx,
      );
      return;
    case "transfer_ownership":
      await recordAuditEvent(
        { ...common, action: "user.ownership.transferred", metadata: {} },
        tx,
      );
      return;
    case "reset_password":
      await recordAuditEvent(
        {
          ...common,
          action: "auth.password_reset.issued",
          metadata: {
            expiresAt: change.expiresAt ?? "",
            linksReplaced: change.resetLinksRevoked ?? 0,
          },
        },
        tx,
      );
      return;
  }
}

/** Logs a refused action at `warn`: IDs, roles and the reason only. */
export function logRefusal(
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
export async function runAccountAction(
  action: AccountAction,
  actorId: string,
  targetId: string,
  mutate: (
    tx: Tx,
    actor: AccountRow,
    target: AccountRow,
  ) => Promise<AccountChange | AccountRefusal>,
  client: SessionClient,
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
    await recordAccountAction(tx, action, { actor, target, change: result }, client);
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
