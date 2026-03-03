import type { PropsWithChildren } from "@kitajs/html";

/**
 * Props for the base HTML layout shell.
 * Every dashboard page is rendered inside this layout.
 */
interface BaseLayoutProps {
  /** Page title — appended to "BunMail" in the <title> tag */
  title: string;
  /** Currently active nav item — used to highlight the active link */
  activeNav?: "home" | "emails" | "api-keys" | "domains";
}

/**
 * Base HTML layout — wraps every dashboard page.
 *
 * Includes Tailwind CDN, dark mode inline script (prevents flash),
 * sidebar navigation, and a main content area.
 */
export function BaseLayout({ title, activeNav, children }: PropsWithChildren<BaseLayoutProps>) {
  return (
    <html lang="en" class="h-full">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title safe>{`${title} — BunMail`}</title>
        {/* Tailwind CSS via CDN */}
        <script src="https://cdn.tailwindcss.com"></script>
        <script>
          {`
            tailwind.config = { darkMode: 'class' };
          `}
        </script>
        {/* Inline dark mode script — runs before paint to prevent flash of wrong theme */}
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
        <div class="flex h-full">
          {/* Sidebar navigation */}
          <Nav activeNav={activeNav} />

          {/* Main content area */}
          <main class="flex-1 overflow-y-auto p-6 lg:p-8">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}

/**
 * Sidebar navigation component.
 * Shows nav links, theme toggle, and logout button.
 */
function Nav({ activeNav }: { activeNav?: string }) {
  /** Nav items with their labels, paths, and SVG icons */
  const links = [
    { id: "home", label: "Dashboard", href: "/dashboard", icon: HomeIcon },
    { id: "emails", label: "Emails", href: "/dashboard/emails", icon: EmailIcon },
    { id: "api-keys", label: "API Keys", href: "/dashboard/api-keys", icon: KeyIcon },
    { id: "domains", label: "Domains", href: "/dashboard/domains", icon: GlobeIcon },
  ];

  return (
    <aside class="w-64 flex-shrink-0 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 flex flex-col">
      {/* Logo / Brand */}
      <div class="p-5 border-b border-gray-200 dark:border-gray-800">
        <a href="/dashboard" class="text-lg font-semibold tracking-tight">
          BunMail
        </a>
        <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Self-hosted email API</p>
      </div>

      {/* Navigation links */}
      <nav class="flex-1 p-3 space-y-1">
        {links.map((link) => {
          const isActive = activeNav === link.id;
          return (
            <a
              href={link.href}
              class={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                isActive
                  ? "bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                  : "text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800/50 hover:text-gray-900 dark:hover:text-gray-100"
              }`}
            >
              <link.icon />
              {link.label}
            </a>
          );
        })}
      </nav>

      {/* Bottom actions — theme toggle + logout */}
      <div class="p-3 border-t border-gray-200 dark:border-gray-800 space-y-1">
        {/* Theme toggle button */}
        <button
          onclick="toggleTheme()"
          class="flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800/50 hover:text-gray-900 dark:hover:text-gray-100 w-full transition-colors"
        >
          <ThemeIcon />
          <span id="theme-label">Toggle theme</span>
        </button>
        <script>
          {`
            function toggleTheme() {
              var isDark = document.documentElement.classList.toggle('dark');
              localStorage.setItem('bm-theme', isDark ? 'dark' : 'light');
            }
          `}
        </script>

        {/* Logout form */}
        <form method="POST" action="/dashboard/logout">
          <button
            type="submit"
            class="flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800/50 hover:text-gray-900 dark:hover:text-gray-100 w-full transition-colors"
          >
            <LogoutIcon />
            Logout
          </button>
        </form>
      </div>
    </aside>
  );
}

/* ─── SVG Icon Components ─── */

function HomeIcon() {
  return (
    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
      <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12l8.954-8.955a1.126 1.126 0 011.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
    </svg>
  );
}

function EmailIcon() {
  return (
    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
      <path stroke-linecap="round" stroke-linejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
      <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
      <path stroke-linecap="round" stroke-linejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 003 12c0-1.605.42-3.113 1.157-4.418" />
    </svg>
  );
}

function ThemeIcon() {
  return (
    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
      <path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
    </svg>
  );
}

function LogoutIcon() {
  return (
    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
      <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
    </svg>
  );
}
