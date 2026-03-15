/**
 * 404 Not Found page — standalone (no sidebar navigation).
 * Matches the landing page aesthetic with a centered message,
 * a subtle illustration, and navigation links back to safety.
 */
export function NotFoundPage() {
  return (
    <html lang="en" class="h-full">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>404 — BunMail</title>
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
      <body class="h-full bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">

        {/* Nav Bar */}
        <nav class="border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
          <div class="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between">
            <a href="/" class="text-lg font-semibold tracking-tight">BunMail</a>
            <div class="flex items-center gap-4">
              <button
                type="button"
                aria-label="Toggle dark mode"
                class="p-2 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                onclick="(function(){var d=document.documentElement.classList;d.toggle('dark');localStorage.setItem('bm-theme',d.contains('dark')?'dark':'light')})()"
              >
                <svg class="w-5 h-5 hidden dark:block" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="5" />
                  <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
                </svg>
                <svg class="w-5 h-5 block dark:hidden" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              </button>
              <a
                href="/dashboard"
                class="text-sm font-medium px-4 py-2 rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors"
              >
                Dashboard
              </a>
            </div>
          </div>
        </nav>

        {/* 404 Content */}
        <main class="flex flex-col items-center justify-center min-h-[calc(100vh-65px)] px-4">
          {/* Lost envelope illustration */}
          <div class="mb-8">
            <svg
              width="140"
              height="140"
              viewBox="0 0 140 140"
              fill="none"
              class="text-gray-300 dark:text-gray-700"
            >
              {/* Envelope body */}
              <rect
                x="20"
                y="45"
                width="100"
                height="70"
                rx="8"
                stroke="currentColor"
                stroke-width="2.5"
                fill="none"
              />
              {/* Envelope flap */}
              <path
                d="M20 53 L70 85 L120 53"
                stroke="currentColor"
                stroke-width="2.5"
                fill="none"
                stroke-linejoin="round"
              />
              {/* Question mark */}
              <text
                x="56"
                y="38"
                font-size="32"
                font-weight="bold"
                font-family="monospace"
                fill="currentColor"
              >
                ?
              </text>
            </svg>
          </div>

          <h1 class="text-6xl font-bold tracking-tight mb-3">404</h1>
          <p class="text-xl text-gray-500 dark:text-gray-400 mb-2">Page not found</p>
          <p class="text-sm text-gray-400 dark:text-gray-500 mb-8 max-w-md text-center">
            The page you're looking for doesn't exist or has been moved.
          </p>

          {/* Navigation links */}
          <div class="flex items-center gap-4 flex-wrap justify-center">
            <a
              href="/"
              class="px-6 py-2.5 rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 font-medium text-sm hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors"
            >
              Back to Home
            </a>
            <a
              href="/api/docs"
              class="px-6 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 font-medium text-sm hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            >
              API Docs
            </a>
            <a
              href="/dashboard"
              class="px-6 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 font-medium text-sm hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            >
              Dashboard
            </a>
          </div>
        </main>

      </body>
    </html>
  );
}
