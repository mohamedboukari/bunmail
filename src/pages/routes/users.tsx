import { BaseLayout } from "../layouts/base.tsx";
import { FlashMessage } from "../components/flash-message.tsx";
import { EmptyState } from "../components/empty-state.tsx";
import { TimeDisplay } from "../components/time-display.tsx";
import {
  allowedAccountActions,
  type AccountParty,
} from "../../modules/users/services/user-admin-policy.service.ts";
import type {
  AccountAction,
  AccountSummary,
} from "../../modules/users/types/user.types.ts";

/** Props for the Users page (#218). */
interface UsersPageProps {
  /** Every account, oldest first. */
  accounts: AccountSummary[];
  /**
   * The signed-in account: its row is marked, and each row gets only the
   * buttons `allowedAccountActions` grants it. The service checks again.
   */
  viewer: AccountParty;
  /** Optional flash message (after an action). */
  flash?: { message: string; type: "success" | "error" };
  /**
   * A password reset link (#277), shown once right after the viewer
   * issued it (one-time reveal bound to the viewer's session).
   */
  revealedResetLink?: string;
}

/** Shared table header cell styling. */
const TH_CLASS = "text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400";

/** Small text button inside a row's action forms. */
const ACTION_BUTTON =
  "text-xs font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100";

/** Small destructive text button. */
const DANGER_BUTTON =
  "text-xs font-medium text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300";

/** Text input inside an expanded action (password, removal confirmation). */
const INPUT_CLASS =
  "w-56 px-2 py-1 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-xs";

/** The role badge's colors. */
const ROLE_CLASS: Record<AccountSummary["role"], string> = {
  owner: "bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  admin: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  member: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

/** The forms of one account's allowed actions. */
function AccountActions({
  account,
  actions,
}: {
  account: AccountSummary;
  actions: AccountAction[];
}) {
  if (actions.length === 0) {
    return <span class="text-xs text-gray-400 dark:text-gray-500">None</span>;
  }
  const base = `/dashboard/users/${account.id}`;
  const otherRole = account.role === "admin" ? "member" : "admin";
  return (
    <div class="flex flex-wrap items-start gap-3">
      {actions.includes("change_role") && (
        <form method="POST" action={`${base}/role`}>
          <input type="hidden" name="role" value={otherRole} />
          <button type="submit" class={ACTION_BUTTON}>
            {otherRole === "admin" ? "Make admin" : "Make member"}
          </button>
        </form>
      )}
      {actions.includes("reset_password") && (
        <form method="POST" action={`${base}/reset-password`}>
          <button
            type="submit"
            class={ACTION_BUTTON}
            onclick="return confirm('Create a one-time password reset link for this account? It is shown to you once and works for one hour; any earlier link stops working.')"
          >
            Reset password
          </button>
        </form>
      )}
      {actions.includes("deactivate") && (
        <form method="POST" action={`${base}/deactivate`}>
          <button
            type="submit"
            class={DANGER_BUTTON}
            onclick="return confirm('Deactivate this account? It is signed out everywhere and cannot sign in until reactivated.')"
          >
            Deactivate
          </button>
        </form>
      )}
      {actions.includes("reactivate") && (
        <form method="POST" action={`${base}/reactivate`}>
          <button type="submit" class={ACTION_BUTTON}>
            Reactivate
          </button>
        </form>
      )}
      {actions.includes("transfer_ownership") && (
        <details>
          <summary class={`${ACTION_BUTTON} cursor-pointer`}>Make owner</summary>
          <form method="POST" action={`${base}/transfer`} class="mt-2 space-y-2">
            <p class="text-xs text-gray-500 dark:text-gray-400 max-w-xs">
              You become an admin and this account becomes the owner. Confirm with your
              password.
            </p>
            <input
              type="password"
              name="password"
              required
              autocomplete="current-password"
              aria-label="Your password"
              placeholder="Your password"
              class={INPUT_CLASS}
            />
            <button type="submit" class={`${DANGER_BUTTON} block`}>
              Transfer ownership
            </button>
          </form>
        </details>
      )}
      {actions.includes("remove") && (
        <details>
          <summary class={`${DANGER_BUTTON} cursor-pointer`}>Remove</summary>
          <form method="POST" action={`${base}/remove`} class="mt-2 space-y-2">
            <p class="text-xs text-gray-500 dark:text-gray-400 max-w-xs">
              Deletes the account for good. Type{" "}
              <span class="font-mono" safe>
                {account.email}
              </span>{" "}
              to confirm.
            </p>
            <input
              type="text"
              name="confirm"
              required
              autocomplete="off"
              aria-label="Email of the account to remove"
              class={INPUT_CLASS}
            />
            <button type="submit" class={`${DANGER_BUTTON} block`}>
              Remove account
            </button>
          </form>
        </details>
      )}
    </div>
  );
}

/**
 * Users page (#218, admins and the owner): every account with its role
 * and status, and the actions the viewer may take on each. Every dynamic
 * value is escaped; no event handler attribute carries a dynamic value.
 */
export function UsersPage({
  accounts,
  viewer,
  flash,
  revealedResetLink,
}: UsersPageProps) {
  return (
    <BaseLayout title="Users" activeNav="users">
      <div class="flex items-center justify-between mb-6">
        <h1 class="text-xl font-semibold">Users</h1>
        <a
          href="/dashboard/invitations"
          class="px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium rounded-lg hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors"
        >
          Invitations
        </a>
      </div>

      {flash != null && <FlashMessage message={flash.message} type={flash.type} />}

      {/* Password reset link (#277), shown once to the admin who issued it */}
      {!!revealedResetLink && (
        <div class="bg-amber-50 text-amber-900 border border-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-800 rounded-lg px-4 py-3 text-sm mb-4">
          <p class="font-medium mb-1">
            Copy this password reset link now and give it to the account holder yourself.
            It won't be shown again:
          </p>
          <code
            class="block bg-amber-100 dark:bg-amber-900 px-3 py-2 rounded font-mono text-xs break-all select-all"
            safe
          >
            {revealedResetLink}
          </code>
          <p class="text-xs mt-2">
            Anyone with this link can set the account's password, so share it privately.
            It works once, for one hour. Lost it? Create a new one: the old link stops
            working.
          </p>
        </div>
      )}

      <p class="text-xs text-gray-500 dark:text-gray-400 mb-4">
        The owner manages admins and members and is the only one who can change roles or
        hand over ownership; admins manage members. Nobody changes their own account here,
        and the owner is never deactivated, removed or given a reset link (the owner uses
        reset-owner).
      </p>

      {accounts.length === 0 ? (
        <EmptyState message="No accounts." />
      ) : (
        <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-gray-200 dark:border-gray-800">
                <th class={TH_CLASS}>Name</th>
                <th class={TH_CLASS}>Email</th>
                <th class={TH_CLASS}>Role</th>
                <th class={TH_CLASS}>Status</th>
                <th class={TH_CLASS}>Created</th>
                <th class={TH_CLASS}>Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
              {accounts.map((account) => (
                <tr class="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors align-top">
                  <td class="px-4 py-3 font-medium text-gray-900 dark:text-gray-100">
                    <span safe>{account.name ?? "(no name)"}</span>
                    {account.id === viewer.id && (
                      <span class="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">
                        (you)
                      </span>
                    )}
                  </td>
                  <td class="px-4 py-3 text-gray-600 dark:text-gray-300" safe>
                    {account.email}
                  </td>
                  <td class="px-4 py-3">
                    <span
                      class={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${ROLE_CLASS[account.role]}`}
                    >
                      {account.role}
                    </span>
                  </td>
                  <td class="px-4 py-3">
                    {account.disabled ? (
                      <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300">
                        Disabled
                      </span>
                    ) : (
                      <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                        Active
                      </span>
                    )}
                  </td>
                  <td class="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    <TimeDisplay value={account.createdAt} />
                  </td>
                  <td class="px-4 py-3">
                    <AccountActions
                      account={account}
                      actions={allowedAccountActions(viewer, {
                        id: account.id,
                        role: account.role,
                        disabled: account.disabled,
                      })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </BaseLayout>
  );
}
