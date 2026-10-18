import { BaseLayout } from "../layouts/base.tsx";
import { FlashMessage } from "../components/flash-message.tsx";
import { EmptyState } from "../components/empty-state.tsx";
import { TimeDisplay } from "../components/time-display.tsx";
import type {
  InviteRole,
  PendingInvitation,
} from "../../modules/users/types/user.types.ts";

/** Props for the Invitations page (#217). */
interface InvitationsPageProps {
  /** Pending invitations: open and unexpired, newest first. */
  invitations: PendingInvitation[];
  /**
   * Roles the signed-in account may grant (`grantableRoles`): the role
   * select lists only these, and only invitations of these roles get the
   * Resend and Revoke buttons. The service checks again on submit.
   */
  grantable: readonly InviteRole[];
  /** Optional flash message (after create, resend or revoke). */
  flash?: { message: string; type: "success" | "error" };
  /**
   * The accept link of an invitation whose email did not go out, shown
   * once to the inviter (one-time reveal, #280).
   */
  revealedLink?: string;
}

/** Shared table header cell styling. */
const TH_CLASS = "text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400";

/**
 * Invitations page (#217, admins and the owner): an invite form, the
 * pending invitations with Resend and Revoke, and the one-time link
 * reveal when an invitation email could not be sent. Every dynamic value
 * is escaped.
 */
export function InvitationsPage({
  invitations,
  grantable,
  flash,
  revealedLink,
}: InvitationsPageProps) {
  return (
    <BaseLayout title="Invitations" activeNav="users">
      <h1 class="text-xl font-semibold mb-6">Invitations</h1>

      {flash != null && <FlashMessage message={flash.message} type={flash.type} />}

      {/* Invitation link shown once when the email did not go out */}
      {!!revealedLink && (
        <div class="bg-amber-50 text-amber-900 border border-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-800 rounded-lg px-4 py-3 text-sm mb-4">
          <p class="font-medium mb-1">
            Copy this invitation link now and send it to the invitee yourself. It won't be
            shown again:
          </p>
          <code
            class="block bg-amber-100 dark:bg-amber-900 px-3 py-2 rounded font-mono text-xs break-all select-all"
            safe
          >
            {revealedLink}
          </code>
          <p class="text-xs mt-2">
            Anyone with this link can create the account, so share it privately. Lost it?
            Use Resend below for a new one.
          </p>
        </div>
      )}

      {/* Invite form */}
      <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4 mb-6">
        <form method="POST" action="/dashboard/invitations" class="flex flex-wrap gap-3">
          <input
            type="email"
            name="email"
            required
            maxlength="254"
            placeholder="teammate@yourcompany.com"
            class="flex-1 min-w-[240px] px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-hidden focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500 focus:border-transparent"
          />
          <select
            name="role"
            aria-label="Role"
            class="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
          >
            {grantable.map((role) => (
              <option value={role}>{role}</option>
            ))}
          </select>
          <button
            type="submit"
            class="px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium rounded-lg hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors whitespace-nowrap"
          >
            Send invitation
          </button>
        </form>
        <p class="text-xs text-gray-500 dark:text-gray-400 mt-2">
          Members can read the dashboard and send email; admins can also manage keys,
          domains, webhooks and invitations. Inviting an address again replaces its
          pending invitation.
        </p>
      </div>

      {invitations.length === 0 ? (
        <EmptyState message="No pending invitations." />
      ) : (
        <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-gray-200 dark:border-gray-800">
                <th class={TH_CLASS}>Email</th>
                <th class={TH_CLASS}>Role</th>
                <th class={TH_CLASS}>Invited by</th>
                <th class={TH_CLASS}>Created</th>
                <th class={TH_CLASS}>Expires</th>
                <th class={TH_CLASS}>Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
              {invitations.map((invitation) => (
                <tr class="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                  <td class="px-4 py-3 font-medium text-gray-900 dark:text-gray-100" safe>
                    {invitation.email}
                  </td>
                  <td class="px-4 py-3 text-gray-600 dark:text-gray-300">
                    {invitation.role}
                  </td>
                  <td class="px-4 py-3 text-gray-600 dark:text-gray-300" safe>
                    {invitation.invitedBy ?? "(deleted account)"}
                  </td>
                  <td class="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    <TimeDisplay value={invitation.createdAt} />
                  </td>
                  <td class="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    <TimeDisplay value={invitation.expiresAt} />
                  </td>
                  <td class="px-4 py-3">
                    {grantable.includes(invitation.role) ? (
                      <div class="flex items-center gap-3">
                        <form
                          method="POST"
                          action={`/dashboard/invitations/${invitation.id}/resend`}
                        >
                          <button
                            type="submit"
                            class="text-xs text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 font-medium"
                          >
                            Resend
                          </button>
                        </form>
                        <form
                          method="POST"
                          action={`/dashboard/invitations/${invitation.id}/revoke`}
                        >
                          <button
                            type="submit"
                            class="text-xs text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 font-medium"
                            data-confirm="Revoke this invitation? Its link stops working."
                          >
                            Revoke
                          </button>
                        </form>
                      </div>
                    ) : (
                      <span class="text-xs text-gray-400 dark:text-gray-500">
                        Owner only
                      </span>
                    )}
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
