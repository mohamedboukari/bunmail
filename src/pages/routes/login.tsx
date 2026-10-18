import {
  LOGIN_EMAIL_MAX_LENGTH,
  LOGIN_PASSWORD_MAX_LENGTH,
} from "../../modules/users/services/session-policy.service.ts";

/**
 * Login page: standalone (no sidebar navigation).
 * Shows a centered card with email and password inputs and a submit
 * button (#216). Displays an error message after a failed login; the text
 * is the same for every failure, so it never reveals whether an account
 * exists. A static hint explains the first sign-in (no database lookup, so
 * the public page reveals nothing about the setup state).
 *
 * @param error    Optional error message shown above the form.
 * @param disabled When true (login rate-limited, #109), both inputs and
 *                 the submit button are disabled so it's clear that
 *                 retrying won't help until the lockout window passes.
 */
export function LoginPage({ error, disabled }: { error?: string; disabled?: boolean }) {
  return (
    <html lang="en" class="h-full">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <title>Login | BunMail</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <script>
          {`
            tailwind.config = { darkMode: 'class' };
          `}
        </script>
        <script>
          {`
            (function() {
              var theme = localStorage.getItem('bm-theme');
              if (theme === 'dark' || (!theme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
                document.documentElement.classList.add('dark');
              }
            })();
          `}
        </script>
      </head>
      <body class="h-full bg-gray-50 dark:bg-gray-950 flex items-center justify-center">
        <div class="w-full max-w-sm mx-auto px-4">
          {/* Brand */}
          <div class="text-center mb-8">
            <h1 class="text-2xl font-semibold text-gray-900 dark:text-gray-100">
              BunMail
            </h1>
            <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">
              Sign in to your dashboard
            </p>
          </div>

          {/* Login card */}
          <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-6">
            {/* Error message (shown after a failed login) */}
            {!!error && (
              <div
                class="bg-red-50 text-red-800 border border-red-200 dark:bg-red-950 dark:text-red-200 dark:border-red-800 rounded-lg px-4 py-3 text-sm mb-4"
                safe
              >
                {error}
              </div>
            )}

            <form method="POST" action="/dashboard/login">
              <label
                for="email"
                class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5"
              >
                Email
              </label>
              <input
                type="text"
                inputmode="email"
                id="email"
                name="email"
                autocomplete="username"
                autocapitalize="none"
                spellcheck="false"
                maxlength={String(LOGIN_EMAIL_MAX_LENGTH)}
                required
                autofocus={!disabled}
                disabled={disabled}
                class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
                placeholder="you@example.com"
              />
              <label
                for="password"
                class="block text-sm font-medium text-gray-700 dark:text-gray-300 mt-4 mb-1.5"
              >
                Password
              </label>
              <input
                type="password"
                id="password"
                name="password"
                autocomplete="current-password"
                maxlength={String(LOGIN_PASSWORD_MAX_LENGTH)}
                required
                disabled={disabled}
                class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
                placeholder="Enter your password"
              />
              <button
                type="submit"
                disabled={disabled}
                class="w-full mt-4 px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium rounded-lg hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-gray-900 dark:disabled:hover:bg-gray-100"
              >
                Sign in
              </button>
            </form>
          </div>

          {/* First sign-in hint: static text, no lookup behind it */}
          <p class="text-xs text-gray-500 dark:text-gray-400 mt-4 text-center">
            First sign-in: open the owner setup link from the server logs, or run{" "}
            <code class="bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded font-mono">
              reset-owner
            </code>
            .
          </p>
        </div>
      </body>
    </html>
  );
}
