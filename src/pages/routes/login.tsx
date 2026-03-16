/**
 * Login page — standalone (no sidebar navigation).
 * Shows a centered card with a password input and submit button.
 * Displays an error message if the password was wrong.
 */
export function LoginPage({ error }: { error?: string }) {
  return (
    <html lang="en" class="h-full">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <title>Login — BunMail</title>
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
            {/* Error message (shown after wrong password) */}
            {error && (
              <div class="bg-red-50 text-red-800 border border-red-200 dark:bg-red-950 dark:text-red-200 dark:border-red-800 rounded-lg px-4 py-3 text-sm mb-4">
                {error}
              </div>
            )}

            <form method="POST" action="/dashboard/login">
              <label
                for="password"
                class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5"
              >
                Password
              </label>
              <input
                type="password"
                id="password"
                name="password"
                required
                autofocus
                class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500 focus:border-transparent"
                placeholder="Enter dashboard password"
              />
              <button
                type="submit"
                class="w-full mt-4 px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium rounded-lg hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors"
              >
                Sign in
              </button>
            </form>
          </div>
        </div>
      </body>
    </html>
  );
}

/**
 * Dashboard disabled page — shown when DASHBOARD_PASSWORD is not set.
 * Informs the user they need to configure the password to access the dashboard.
 */
export function DashboardDisabledPage() {
  return (
    <html lang="en" class="h-full">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <title>Dashboard Disabled — BunMail</title>
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
        <div class="text-center px-4">
          <h1 class="text-2xl font-semibold text-gray-900 dark:text-gray-100">
            Dashboard Disabled
          </h1>
          <p class="text-sm text-gray-500 dark:text-gray-400 mt-2 max-w-md">
            Set the{" "}
            <code class="bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded text-xs font-mono">
              DASHBOARD_PASSWORD
            </code>{" "}
            environment variable to enable the dashboard.
          </p>
        </div>
      </body>
    </html>
  );
}
