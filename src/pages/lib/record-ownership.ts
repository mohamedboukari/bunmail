import type { DashboardAuth, UserRole } from "../../modules/users/types/user.types.ts";
import { maskEmail } from "../../utils/redact.ts";
import type { CreatorNames } from "../components/created-by.tsx";
import { roleAtLeast } from "../guards.tsx";
import * as userAdminService from "../../modules/users/services/user-admin.service.ts";

/* ─── Record ownership helpers (#219) ─── */

/**
 * The signed-in account acting on API keys and templates (#219): id and
 * role from the guard's `auth`. The services scope a member to its own
 * records; admins and the owner act on all of them.
 */
export function recordActorOf(auth: DashboardAuth): { id: string; role: UserRole } {
  return { id: auth.user.id, role: auth.user.role };
}

/** Admins and the owner manage every key and template (#219). */
export function managesAll(auth: DashboardAuth): boolean {
  return roleAtLeast(auth.user.role, "admin");
}

/** What the pages need to know about the accounts that created records (#219). */
interface CreatorDirectory {
  /** "Created by" labels by `users.id`. */
  names: CreatorNames;
  /** Active admins and the owner: only their keys may be made admin. */
  adminIds: ReadonlySet<string>;
}

/**
 * Every account, for the "Created by" columns and the admin toggle
 * (#219). The label is the account's name; without one, admins and the
 * owner see the email and a member a masked one (`a***@example.com`), so
 * members do not learn teammates' full addresses.
 */
export async function creatorDirectory(auth: DashboardAuth): Promise<CreatorDirectory> {
  const accounts = await userAdminService.listAccounts();
  const fullEmails = managesAll(auth);
  return {
    names: new Map(
      accounts.map((account) => [
        account.id,
        account.name ?? (fullEmails ? account.email : maskEmail(account.email)),
      ]),
    ),
    adminIds: new Set(
      accounts
        .filter((account) => !account.disabled && account.role !== "member")
        .map((account) => account.id),
    ),
  };
}

/** The "Created by" labels alone (see `creatorDirectory`). */
export async function creatorNames(auth: DashboardAuth): Promise<CreatorNames> {
  return (await creatorDirectory(auth)).names;
}

/** Flash text when a dashboard create needs an API key the user may use (#219). */
export const NO_USABLE_KEY_TEXT = "Create an API key first";
