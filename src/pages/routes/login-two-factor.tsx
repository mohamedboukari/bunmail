import { SetupShell, INPUT_CLASS, LABEL_CLASS } from "./setup.tsx";

/** Longest value the code field takes: a recovery code with spaces to spare. */
export const TWO_FACTOR_CODE_MAX_LENGTH = 64;

/**
 * The second login step (#220): standalone like the login page, reached
 * only with a `pending` session (the password was right). One field takes
 * either the six-digit code from the authenticator app or one of the
 * account's recovery codes. "Use another account" signs the pending
 * session out (`POST /dashboard/logout`).
 *
 * @param error Optional message shown above the form (the same for every
 *              wrong, expired or reused code).
 */
export function LoginTwoFactorPage({ error }: { error?: string }) {
  return (
    <SetupShell title="Two-factor authentication" subtitle="One more step to sign in">
      {!!error && (
        <div
          class="bg-red-50 text-red-800 border border-red-200 dark:bg-red-950 dark:text-red-200 dark:border-red-800 rounded-lg px-4 py-3 text-sm mb-4"
          safe
        >
          {error}
        </div>
      )}

      <form method="POST" action="/dashboard/login/two-factor">
        <label for="code" class={LABEL_CLASS}>
          Authentication code
        </label>
        <input
          type="text"
          id="code"
          name="code"
          inputmode="text"
          autocomplete="one-time-code"
          autocapitalize="none"
          spellcheck="false"
          maxlength={String(TWO_FACTOR_CODE_MAX_LENGTH)}
          required
          autofocus
          class={INPUT_CLASS}
          placeholder="123456"
        />
        <p class="text-xs text-gray-500 dark:text-gray-400 mt-1.5">
          The 6-digit code from your authenticator app. Lost your phone? Enter one of your
          recovery codes instead.
        </p>
        <button
          type="submit"
          class="w-full mt-4 px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium rounded-lg hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors"
        >
          Verify
        </button>
      </form>

      <form method="POST" action="/dashboard/logout" class="mt-3 text-center">
        <button
          type="submit"
          class="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
        >
          Cancel and use another account
        </button>
      </form>
    </SetupShell>
  );
}
