import type { PropsWithChildren } from "@kitajs/html";
import {
  HomeIcon,
  EmailIcon,
  SendIcon,
  KeyIcon,
  TemplateIcon,
  GlobeIcon,
  WebhookIcon,
  InboundIcon,
  DocsIcon,
  ThemeIcon,
  LogoutIcon,
} from "../assets/icons.tsx";

/**
 * Props for the base HTML layout shell.
 * Every dashboard page is rendered inside this layout.
 */
interface BaseLayoutProps {
  /** Page title — appended to "BunMail" in the <title> tag */
  title: string;
  /** Currently active nav item — used to highlight the active link */
  activeNav?:
    | "home"
    | "emails"
    | "send"
    | "api-keys"
    | "domains"
    | "templates"
    | "webhooks"
    | "inbound";
}

/**
 * Base HTML layout — wraps every dashboard page.
 *
 * Includes Tailwind CDN, dark mode inline script (prevents flash),
 * sidebar navigation, and a main content area.
 */
export function BaseLayout({
  title,
  activeNav,
  children,
}: PropsWithChildren<BaseLayoutProps>) {
  return (
    <html lang="en" class="h-full">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
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
          <main class="flex-1 overflow-y-auto p-6 lg:p-8">{children}</main>
        </div>
        {/* Prevent double form submissions — disables button + shows spinner on first click */}
        <script>
          {`
            document.querySelectorAll('form').forEach(function(form) {
              form.addEventListener('submit', function() {
                var btn = form.querySelector('button[type="submit"]');
                if (!btn || btn.disabled) return;
                btn.disabled = true;
                btn.dataset.originalText = btn.textContent;
                btn.textContent = 'Processing\u2026';
                btn.classList.add('opacity-60', 'cursor-not-allowed');
              });
            });
          `}
        </script>
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
    { id: "send", label: "Send Email", href: "/dashboard/send", icon: SendIcon },
    { id: "api-keys", label: "API Keys", href: "/dashboard/api-keys", icon: KeyIcon },
    {
      id: "templates",
      label: "Templates",
      href: "/dashboard/templates",
      icon: TemplateIcon,
    },
    { id: "domains", label: "Domains", href: "/dashboard/domains", icon: GlobeIcon },
    { id: "webhooks", label: "Webhooks", href: "/dashboard/webhooks", icon: WebhookIcon },
    { id: "inbound", label: "Inbound", href: "/dashboard/inbound", icon: InboundIcon },
  ];

  return (
    <aside class="w-64 flex-shrink-0 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 flex flex-col">
      {/* Logo / Brand */}
      <div class="p-5 border-b border-gray-200 dark:border-gray-800">
        <a href="/dashboard" class="text-lg font-semibold tracking-tight">
          BunMail
        </a>
        <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
          Self-hosted email API
        </p>
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

      {/* Bottom actions — docs, theme toggle + logout */}
      <div class="p-3 border-t border-gray-200 dark:border-gray-800 space-y-1">
        <a
          href="/api/docs"
          target="_blank"
          class="flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800/50 hover:text-gray-900 dark:hover:text-gray-100 w-full transition-colors"
        >
          <DocsIcon />
          API Docs
        </a>
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
