import type { PropsWithChildren } from "@kitajs/html";
import {
  SETUP_PASSWORD_MAX_LENGTH,
  SETUP_PASSWORD_MIN_LENGTH,
} from "../../modules/users/services/owner-setup-policy.service.ts";
import { PageAssets } from "../static-assets.tsx";

/**
 * Owner setup pages (#215): standalone like the login page (no sidebar,
 * no session), reached from the one-time link BunMail logs on first boot.
 *
 * Every page carries `<meta name="referrer" content="strict-origin">` on top
 * of the `Referrer-Policy` header the route sets: the form page has the
 * token in its URL and loads the dashboard stylesheet and script, so no
 * request it makes may carry that URL in a `Referer` (the origin only). Not
 * `no-referrer`: browsers then send `Origin: null` on the form POST and
 * the same-origin check rejects it (see `setAuthPageHeaders`).
 */

/** Shared input styling, matching the login form. */
export const INPUT_CLASS =
  "w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-hidden focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500 focus:border-transparent";

/** Shared label styling, matching the login form. */
export const LABEL_CLASS =
  "block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5";

/**
 * HTML shell shared by the setup pages, the invitation accept pages
 * (#217, `invite.tsx`) and the password reset pages (#277, `reset.tsx`),
 * whose URLs carry a one-time token too: the same
 * head as the login page plus the strict-origin referrer meta tag, and a
 * centered column.
 *
 * @param title    Static page title, prefixed to "| BunMail".
 * @param subtitle Static line under the brand heading.
 */
export function SetupShell({
  title,
  subtitle,
  children,
}: PropsWithChildren<{ title: string; subtitle: string }>) {
  return (
    <html lang="en" class="h-full">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="referrer" content="strict-origin" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <title safe>{`${title} | BunMail`}</title>
        <PageAssets />
      </head>
      <body class="h-full bg-gray-50 dark:bg-gray-950 flex items-center justify-center">
        <div class="w-full max-w-sm mx-auto px-4">
          {/* Brand */}
          <div class="text-center mb-8">
            <h1 class="text-2xl font-semibold text-gray-900 dark:text-gray-100">
              BunMail
            </h1>
            <p class="text-sm text-gray-500 dark:text-gray-400 mt-1" safe>
              {subtitle}
            </p>
          </div>

          <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-6">
            {children}
          </div>
        </div>
      </body>
    </html>
  );
}

/**
 * Owner setup form: the owner sets the account password.
 *
 * The token rides in a hidden input (escaped attribute) so the POST can
 * spend it; it is never rendered as text. The action is the fixed
 * `/dashboard/setup`, never derived from the request.
 *
 * @param token Well-formed, live setup token from the link.
 * @param email The owner's stored email, shown so the operator knows which
 *              account they are claiming.
 * @param error Optional password-policy message from a failed submission.
 */
export function OwnerSetupPage({
  token,
  email,
  error,
}: {
  token: string;
  email: string;
  error?: string;
}) {
  return (
    <SetupShell title="Owner setup" subtitle="Set the owner account password">
      {!!error && (
        <div
          class="bg-red-50 text-red-800 border border-red-200 dark:bg-red-950 dark:text-red-200 dark:border-red-800 rounded-lg px-4 py-3 text-sm mb-4"
          safe
        >
          {error}
        </div>
      )}

      <p class="text-sm text-gray-600 dark:text-gray-400 mb-4">
        Owner account:{" "}
        <span class="font-medium text-gray-900 dark:text-gray-100" safe>
          {email}
        </span>
      </p>

      <form method="POST" action="/dashboard/setup">
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

        <button
          type="submit"
          class="w-full mt-4 px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium rounded-lg hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors"
        >
          Save password
        </button>
      </form>
    </SetupShell>
  );
}

/**
 * Shown for every unusable link: missing, malformed, unknown, expired,
 * used or replaced. One message for all of them, so the response is no
 * oracle, and it never echoes the token.
 */
export function OwnerSetupInvalidPage() {
  return (
    <SetupShell title="Invalid setup link" subtitle="Owner setup">
      <h2 class="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
        This setup link is not valid
      </h2>
      <p class="text-sm text-gray-600 dark:text-gray-400 mb-3">
        It may have expired, already been used, or been replaced by a newer link. Only the
        most recent link works.
      </p>
      <p class="text-sm text-gray-600 dark:text-gray-400">
        To get a fresh link, run{" "}
        <code class="bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded text-xs font-mono">
          bun run src/db/reset-owner.ts
        </code>{" "}
        on the server (in Docker:{" "}
        <code class="bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded text-xs font-mono">
          docker compose exec app bun run src/db/reset-owner.ts
        </code>
        ).
      </p>
    </SetupShell>
  );
}
