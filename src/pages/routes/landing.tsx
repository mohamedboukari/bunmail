/**
 * Landing page — standalone (no sidebar navigation).
 * Developer-focused home page introducing BunMail with hero,
 * curl code snippet, features grid, quick start steps, and footer.
 */
export function LandingPage() {
  return (
    <html lang="en" class="h-full">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <title>BunMail — Self-hosted Email API for Developers</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <script>
          {`
            tailwind.config = { darkMode: 'class' };
          `}
        </script>
        {/* Dark mode initialization — runs before paint to avoid flash */}
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

        {/* ─── Nav Bar ─── */}
        <nav class="border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
          <div class="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between">
            {/* Logo / brand */}
            <span class="text-lg font-semibold tracking-tight">BunMail</span>

            <div class="flex items-center gap-4">
              {/* Dark mode toggle */}
              <button
                type="button"
                aria-label="Toggle dark mode"
                class="p-2 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                onclick="(function(){var d=document.documentElement.classList;d.toggle('dark');localStorage.setItem('bm-theme',d.contains('dark')?'dark':'light')})()"
              >
                {/* Sun icon (visible in dark mode) */}
                <svg class="w-5 h-5 hidden dark:block" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="5" />
                  <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
                </svg>
                {/* Moon icon (visible in light mode) */}
                <svg class="w-5 h-5 block dark:hidden" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              </button>

              {/* Dashboard link */}
              <a
                href="/dashboard"
                class="text-sm font-medium px-4 py-2 rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors"
              >
                Dashboard
              </a>
            </div>
          </div>
        </nav>

        <main class="max-w-5xl mx-auto px-4 py-16">

          {/* ─── Hero Section ─── */}
          <section class="text-center mb-20">
            {/* Inline SVG illustration — envelope with code brackets */}
            <div class="flex justify-center mb-8">
              <svg
                width="120"
                height="120"
                viewBox="0 0 120 120"
                fill="none"
                class="text-gray-900 dark:text-gray-100"
              >
                {/* Envelope body */}
                <rect
                  x="10"
                  y="30"
                  width="100"
                  height="70"
                  rx="8"
                  stroke="currentColor"
                  stroke-width="3"
                  fill="none"
                />
                {/* Envelope flap */}
                <path
                  d="M10 38 L60 72 L110 38"
                  stroke="currentColor"
                  stroke-width="3"
                  fill="none"
                  stroke-linejoin="round"
                />
                {/* Left code bracket < */}
                <text
                  x="36"
                  y="22"
                  font-size="24"
                  font-weight="bold"
                  font-family="monospace"
                  fill="currentColor"
                >
                  {"<"}
                </text>
                {/* Slash / */}
                <text
                  x="52"
                  y="22"
                  font-size="24"
                  font-weight="bold"
                  font-family="monospace"
                  fill="currentColor"
                >
                  /
                </text>
                {/* Right code bracket > */}
                <text
                  x="66"
                  y="22"
                  font-size="24"
                  font-weight="bold"
                  font-family="monospace"
                  fill="currentColor"
                >
                  {">"}
                </text>
              </svg>
            </div>

            <h1 class="text-4xl sm:text-5xl font-bold tracking-tight mb-4">BunMail</h1>
            <p class="text-xl text-gray-500 dark:text-gray-400 mb-3">
              Self-hosted email API for developers
            </p>
            <p class="text-base text-gray-500 dark:text-gray-400 max-w-2xl mx-auto mb-8">
              Free alternative to SendGrid and Resend. Direct SMTP delivery with DKIM signing,
              email queue, and a built-in dashboard.
            </p>

            {/* CTA buttons */}
            <div class="flex items-center justify-center gap-4 flex-wrap">
              <a
                href="#quick-start"
                class="px-6 py-2.5 rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 font-medium text-sm hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors"
              >
                Get Started
              </a>
              <a
                href="/dashboard"
                class="px-6 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 font-medium text-sm hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              >
                Open Dashboard
              </a>
            </div>
          </section>

          {/* ─── Code Snippet Section ─── */}
          <section class="mb-20">
            <h2 class="text-lg font-semibold text-center mb-6">Send an email in one request</h2>
            <div class="bg-gray-900 dark:bg-gray-800 rounded-lg p-6 overflow-x-auto">
              <pre class="text-sm text-gray-100 leading-relaxed">
                <code>{`curl -X POST http://localhost:3000/api/v1/emails/send \\
  -H "Authorization: Bearer bm_live_your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "from": "hello@yourdomain.com",
    "to": "user@example.com",
    "subject": "Welcome to BunMail",
    "html": "<h1>It works!</h1>"
  }'`}</code>
              </pre>
            </div>
          </section>

          {/* ─── Features Grid (3x2) ─── */}
          <section class="mb-20">
            <h2 class="text-lg font-semibold text-center mb-8">Features</h2>
            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">

              {/* Direct SMTP */}
              <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-5">
                <div class="flex items-center gap-3 mb-2">
                  <svg class="w-5 h-5 text-gray-500 dark:text-gray-400 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                  </svg>
                  <h3 class="font-medium text-sm">Direct SMTP</h3>
                </div>
                <p class="text-sm text-gray-500 dark:text-gray-400">No third-party email provider needed</p>
              </div>

              {/* DKIM / SPF / DMARC */}
              <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-5">
                <div class="flex items-center gap-3 mb-2">
                  <svg class="w-5 h-5 text-gray-500 dark:text-gray-400 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  </svg>
                  <h3 class="font-medium text-sm">DKIM / SPF / DMARC</h3>
                </div>
                <p class="text-sm text-gray-500 dark:text-gray-400">Email authentication built in</p>
              </div>

              {/* Email Queue */}
              <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-5">
                <div class="flex items-center gap-3 mb-2">
                  <svg class="w-5 h-5 text-gray-500 dark:text-gray-400 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path d="M4 4h16v4H4zM4 10h16v4H4zM4 16h16v4H4z" />
                  </svg>
                  <h3 class="font-medium text-sm">Email Queue</h3>
                </div>
                <p class="text-sm text-gray-500 dark:text-gray-400">Automatic retries (3 attempts)</p>
              </div>

              {/* API Key Auth */}
              <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-5">
                <div class="flex items-center gap-3 mb-2">
                  <svg class="w-5 h-5 text-gray-500 dark:text-gray-400 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
                  </svg>
                  <h3 class="font-medium text-sm">API Key Auth</h3>
                </div>
                <p class="text-sm text-gray-500 dark:text-gray-400">SHA-256 hashed, rate-limited</p>
              </div>

              {/* REST API */}
              <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-5">
                <div class="flex items-center gap-3 mb-2">
                  <svg class="w-5 h-5 text-gray-500 dark:text-gray-400 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path d="M16 18l6-6-6-6M8 6l-6 6 6 6" />
                  </svg>
                  <h3 class="font-medium text-sm">REST API</h3>
                </div>
                <p class="text-sm text-gray-500 dark:text-gray-400">Simple JSON endpoints for everything</p>
              </div>

              {/* Dashboard */}
              <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-5">
                <div class="flex items-center gap-3 mb-2">
                  <svg class="w-5 h-5 text-gray-500 dark:text-gray-400 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <path d="M3 9h18M9 21V9" />
                  </svg>
                  <h3 class="font-medium text-sm">Dashboard</h3>
                </div>
                <p class="text-sm text-gray-500 dark:text-gray-400">Server-rendered UI to manage it all</p>
              </div>

            </div>
          </section>

          {/* ─── Quick Start (3 steps) ─── */}
          <section id="quick-start" class="mb-20">
            <h2 class="text-lg font-semibold text-center mb-8">Quick Start</h2>
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-6">

              {/* Step 1 */}
              <div class="text-center">
                <div class="inline-flex items-center justify-center w-8 h-8 rounded-full bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-bold mb-3">
                  1
                </div>
                <h3 class="font-medium text-sm mb-2">Clone the repo</h3>
                <div class="bg-gray-900 dark:bg-gray-800 rounded-lg px-4 py-3">
                  <code class="text-xs text-gray-100">git clone https://github.com/mohamedboukari/bunmail.git</code>
                </div>
              </div>

              {/* Step 2 */}
              <div class="text-center">
                <div class="inline-flex items-center justify-center w-8 h-8 rounded-full bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-bold mb-3">
                  2
                </div>
                <h3 class="font-medium text-sm mb-2">Configure environment</h3>
                <div class="bg-gray-900 dark:bg-gray-800 rounded-lg px-4 py-3">
                  <code class="text-xs text-gray-100">cp .env.example .env</code>
                </div>
              </div>

              {/* Step 3 */}
              <div class="text-center">
                <div class="inline-flex items-center justify-center w-8 h-8 rounded-full bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-bold mb-3">
                  3
                </div>
                <h3 class="font-medium text-sm mb-2">Start the server</h3>
                <div class="bg-gray-900 dark:bg-gray-800 rounded-lg px-4 py-3">
                  <code class="text-xs text-gray-100">bun install && bun run dev</code>
                </div>
              </div>

            </div>
          </section>

        </main>

        {/* ─── Footer ─── */}
        <footer class="border-t border-gray-200 dark:border-gray-800 py-8">
          <div class="max-w-5xl mx-auto px-4 flex items-center justify-between text-sm text-gray-500 dark:text-gray-400">
            <span>Built with Bun + Elysia</span>
            <a
              href="https://github.com/mohamedboukari/bunmail"
              target="_blank"
              rel="noopener noreferrer"
              class="hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
            >
              GitHub
            </a>
          </div>
        </footer>

      </body>
    </html>
  );
}
