import {
  SETUP_PASSWORD_MAX_LENGTH,
  SETUP_PASSWORD_MIN_LENGTH,
} from "../../modules/users/services/owner-setup-policy.service.ts";
import { INVITE_NAME_MAX_LENGTH } from "../../modules/users/services/invite-policy.service.ts";
import type { InviteRole } from "../../modules/users/types/user.types.ts";
import { INPUT_CLASS, LABEL_CLASS, SetupShell } from "./setup.tsx";

/**
 * Invitation accept pages (#217): standalone like the owner setup pages
 * (no sidebar, no session), reached from the invitation link. They share
 * the setup shell, so they carry the same strict-origin referrer meta tag
 * on top of the route's `Referrer-Policy` header: the form page has the
 * token in its URL and loads the Tailwind CDN script.
 */

/**
 * Accept form: the invitee picks a display name and a password.
 *
 * The token rides in a hidden input (escaped attribute) so the POST can
 * spend it; it is never rendered as text. The action is the fixed
 * `/dashboard/invite`, never derived from the request.
 *
 * @param token Well-formed, live invitation token from the link.
 * @param email The invited address, shown so the invitee knows which
 *              account they are creating.
 * @param role  Role the account will get.
 * @param name  The name from a failed submission, to keep it filled in.
 * @param error Optional name or password-policy message.
 */
export function InviteAcceptPage({
  token,
  email,
  role,
  name,
  error,
}: {
  token: string;
  email: string;
  role: InviteRole;
  name?: string;
  error?: string;
}) {
  return (
    <SetupShell title="Accept invitation" subtitle="Create your BunMail account">
      {!!error && (
        <div
          class="bg-red-50 text-red-800 border border-red-200 dark:bg-red-950 dark:text-red-200 dark:border-red-800 rounded-lg px-4 py-3 text-sm mb-4"
          safe
        >
          {error}
        </div>
      )}

      <p class="text-sm text-gray-600 dark:text-gray-400 mb-1">
        Account:{" "}
        <span class="font-medium text-gray-900 dark:text-gray-100" safe>
          {email}
        </span>
      </p>
      <p class="text-sm text-gray-600 dark:text-gray-400 mb-4">
        Role: <span class="font-medium text-gray-900 dark:text-gray-100">{role}</span>
      </p>

      <form method="POST" action="/dashboard/invite">
        <input type="hidden" name="token" value={token} />

        <label for="name" class={LABEL_CLASS}>
          Your name
        </label>
        <input
          type="text"
          id="name"
          name="name"
          required
          autofocus
          autocomplete="name"
          maxlength={String(INVITE_NAME_MAX_LENGTH)}
          value={name ?? ""}
          class={`${INPUT_CLASS} mb-4`}
        />

        <label for="password" class={LABEL_CLASS}>
          Password
        </label>
        <input
          type="password"
          id="password"
          name="password"
          required
          autocomplete="new-password"
          minlength={String(SETUP_PASSWORD_MIN_LENGTH)}
          maxlength={String(SETUP_PASSWORD_MAX_LENGTH)}
          class={INPUT_CLASS}
        />
        {/* A numeric constant: nothing to escape. */}
        <p class="text-xs text-gray-500 dark:text-gray-400 mt-1.5 mb-4">
          At least {SETUP_PASSWORD_MIN_LENGTH} characters. A passphrase works well.
        </p>

        <label for="confirm" class={LABEL_CLASS}>
          Confirm password
        </label>
        <input
          type="password"
          id="confirm"
          name="confirm"
          required
          autocomplete="new-password"
          minlength={String(SETUP_PASSWORD_MIN_LENGTH)}
          maxlength={String(SETUP_PASSWORD_MAX_LENGTH)}
          class={INPUT_CLASS}
        />

        <button
          type="submit"
          class="w-full mt-4 px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium rounded-lg hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors"
        >
          Create account
        </button>
      </form>
    </SetupShell>
  );
}

/**
 * Shown for every unusable invitation link: missing, malformed, unknown,
 * expired, used or revoked. One message for all of them, so the response
 * is no oracle, and it never echoes the token.
 */
export function InviteInvalidPage() {
  return (
    <SetupShell title="Invalid invitation" subtitle="Invitation">
      <h2 class="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
        This invitation link is not valid
      </h2>
      <p class="text-sm text-gray-600 dark:text-gray-400">
        It may have expired, already been used, or been replaced by a newer invitation.
        Only the most recent link works. Ask the person who invited you to send a new one.
      </p>
    </SetupShell>
  );
}

/**
 * Shown when an account took the invited address after the invitation
 * was sent. Says no more than the link holder already knows (the address
 * was on the form), and points at the login page.
 */
export function InviteAccountExistsPage() {
  return (
    <SetupShell title="Account exists" subtitle="Invitation">
      <h2 class="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
        An account already exists for this address
      </h2>
      <p class="text-sm text-gray-600 dark:text-gray-400">
        The invitation can no longer be used.{" "}
        <a href="/dashboard/login" class="underline">
          Sign in
        </a>{" "}
        instead.
      </p>
    </SetupShell>
  );
}
