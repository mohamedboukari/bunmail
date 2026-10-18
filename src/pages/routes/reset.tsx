import {
  SETUP_PASSWORD_MAX_LENGTH,
  SETUP_PASSWORD_MIN_LENGTH,
} from "../../modules/users/services/owner-setup-policy.service.ts";
import { INPUT_CLASS, LABEL_CLASS, SetupShell } from "./setup.tsx";

/**
 * Password reset pages (#277): standalone like the owner setup and
 * invitation pages (no sidebar, no session), reached from the one-time
 * link an admin issued on the Users page. They share the setup shell, so
 * they carry the same strict-origin referrer meta tag on top of the
 * route's `Referrer-Policy` header: the form page has the token in its URL
 * and loads the Tailwind CDN script.
 */

/**
 * Reset form: the account holder picks a new password.
 *
 * The token rides in a hidden input (escaped attribute) so the POST can
 * spend it; it is never rendered as text. The action is the fixed
 * `/dashboard/reset`, never derived from the request.
 *
 * @param token Well-formed, live reset token from the link.
 * @param email The account's address, shown so the holder knows which
 *              account they are resetting.
 * @param error Optional password-policy message.
 */
export function PasswordResetPage({
  token,
  email,
  error,
}: {
  token: string;
  email: string;
  error?: string;
}) {
  return (
    <SetupShell title="Reset password" subtitle="Choose a new password">
      {!!error && (
        <div
          class="bg-red-50 text-red-800 border border-red-200 dark:bg-red-950 dark:text-red-200 dark:border-red-800 rounded-lg px-4 py-3 text-sm mb-4"
          safe
        >
          {error}
        </div>
      )}

      <p class="text-sm text-gray-600 dark:text-gray-400 mb-4">
        Account:{" "}
        <span class="font-medium text-gray-900 dark:text-gray-100" safe>
          {email}
        </span>
      </p>

      <form method="POST" action="/dashboard/reset">
        <input type="hidden" name="token" value={token} />

        <label for="password" class={LABEL_CLASS}>
          New password
        </label>
        <input
          type="password"
          id="password"
          name="password"
          required
          autofocus
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

        <p class="text-xs text-gray-500 dark:text-gray-400 mt-3">
          Every signed-in session of this account is signed out.
        </p>

        <button
          type="submit"
          class="w-full mt-4 px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium rounded-lg hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors"
        >
          Set new password
        </button>
      </form>
    </SetupShell>
  );
}

/**
 * Shown for every unusable reset link: missing, malformed, unknown,
 * expired, used, revoked, or no longer backed by its issuer. One message
 * for all of them, so the response is no oracle, and it never echoes the
 * token.
 */
export function PasswordResetInvalidPage() {
  return (
    <SetupShell title="Invalid reset link" subtitle="Password reset">
      <h2 class="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
        This password reset link is not valid
      </h2>
      <p class="text-sm text-gray-600 dark:text-gray-400">
        It may have expired, already been used, or been replaced by a newer link. Only the
        most recent link works, for one hour. Ask an administrator for a new one.
      </p>
    </SetupShell>
  );
}
