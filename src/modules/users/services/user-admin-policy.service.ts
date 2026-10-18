import type { AccountAction, AccountRefusal, UserRole } from "../types/user.types.ts";
import { grantableRoles } from "./invite-policy.service.ts";

/**
 * Rules for managing dashboard accounts (#218): who may change the role
 * of, deactivate, reactivate, remove, hand ownership to or issue a
 * password reset link for whom. The
 * database side lives in `user-admin.service.ts`, which applies these
 * rules to the live rows inside its transaction; the Users page uses
 * them only to decide which buttons to show.
 *
 * - Nobody acts on their own account, and nobody acts on the owner: the
 *   owner is never demoted, deactivated or removed here (ownership moves
 *   only by transfer, which demotes the owner as its own step).
 * - Changing a role (member to admin or back) is the owner's alone.
 * - Deactivating, reactivating and removing follow the invitation rules
 *   (`grantableRoles`): an account may manage the roles it could invite.
 *   The owner manages admins and members, an admin manages members, a
 *   member manages nobody.
 * - Ownership goes from the owner to an active admin only.
 * - A password reset link (#277) follows the deactivation rules (the
 *   owner resets admins and members, an admin members), and is never
 *   issued for a deactivated account: reactivate it first. The owner's
 *   password is reset with `bun run src/db/reset-owner.ts` only.
 *
 * Pure: no I/O, no config, so it unit-tests without mocks.
 */

/** The account acting, or being acted on, as the rules see it. */
export interface AccountParty {
  /** `users.id`. */
  id: string;
  /** The account's current role. */
  role: UserRole;
  /** True when the account is deactivated. */
  disabled: boolean;
}

/** Every action, in the order the Users page shows its buttons. */
const ACTIONS: readonly AccountAction[] = [
  "change_role",
  "reset_password",
  "deactivate",
  "reactivate",
  "transfer_ownership",
  "remove",
];

/** True when `actorRole` may manage (deactivate, reactivate, remove) a `targetRole` account. */
function canManage(actorRole: UserRole, targetRole: UserRole): boolean {
  return grantableRoles(actorRole).some((role) => role === targetRole);
}

/**
 * Why `actor` may not perform `action` on `target`, or `null` when the
 * rules allow it. Covers who may act on whom and the target's state
 * (`unchanged` for a no-op, `not_eligible` for a transfer to anyone but
 * an active admin, `account_disabled` for a reset of a deactivated
 * account). The action's own input (the new role, the removal
 * confirmation, the password) is checked by the service.
 */
export function accountActionRefusal(
  action: AccountAction,
  actor: AccountParty,
  target: AccountParty,
): AccountRefusal | null {
  if (actor.id === target.id) return "self";
  if (target.role === "owner") return "target_is_owner";
  switch (action) {
    case "change_role":
      return actor.role === "owner" ? null : "role_not_allowed";
    case "deactivate":
      if (!canManage(actor.role, target.role)) return "role_not_allowed";
      return target.disabled ? "unchanged" : null;
    case "reactivate":
      if (!canManage(actor.role, target.role)) return "role_not_allowed";
      return target.disabled ? null : "unchanged";
    case "remove":
      return canManage(actor.role, target.role) ? null : "role_not_allowed";
    case "transfer_ownership":
      if (actor.role !== "owner") return "role_not_allowed";
      return target.role === "admin" && !target.disabled ? null : "not_eligible";
    case "reset_password":
      if (!canManage(actor.role, target.role)) return "role_not_allowed";
      return target.disabled ? "account_disabled" : null;
  }
}

/**
 * The actions `actor` may use on `target` right now, for the Users page:
 * only these get a button. The service checks everything again on submit.
 */
export function allowedAccountActions(
  actor: AccountParty,
  target: AccountParty,
): AccountAction[] {
  return ACTIONS.filter((action) => accountActionRefusal(action, actor, target) === null);
}

/**
 * True when the removal confirmation names the target: the submitted
 * value, trimmed and lower-cased, equals the stored (lower-cased) email.
 */
export function removalConfirmed(confirm: string, email: string): boolean {
  return confirm.trim().toLowerCase() === email;
}
