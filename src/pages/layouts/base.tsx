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
  NoEntryIcon,
  DocsIcon,
  ThemeIcon,
  LogoutIcon,
  UsersIcon,
} from "../assets/icons.tsx";
import { PageAssets } from "../static-assets.tsx";
import { viewerIsAdmin } from "../viewer.ts";

/**
 * Props for the base HTML layout shell.
 * Every dashboard page is rendered inside this layout.
 */
interface BaseLayoutProps {
  /** Page title: appended to "BunMail" in the <title> tag */
  title: string;
  /** Currently active nav item: used to highlight the active link */
  activeNav?:
    | "home"
    | "emails"
    | "send"
    | "api-keys"
    | "domains"
    | "templates"
    | "webhooks"
    | "inbound"
    | "dmarc-reports"
    | "suppressions"
    | "users";
}

/**
 * Base HTML layout: wraps every dashboard page.
 *
 * Includes the self-hosted stylesheet and script (`static-assets.tsx`;
 * the script sets the dark theme before paint, hydrates `<time>` elements
 * and stops double submits), sidebar navigation, and a main content area.
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
        <title safe>{`${title}: BunMail`}</title>
        {/* Self-hosted stylesheet + script (#255): the script sets the theme before paint */}
        <PageAssets />
      </head>
      {/* data-submit-once: dashboard.js disables a form's button once it submits */}
      <body
        class="h-full bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100"
        data-submit-once
      >
        <div class="flex h-full">
          {/* Sidebar navigation */}
          <Nav activeNav={activeNav} />

          {/* Main content area */}
          <main class="flex-1 overflow-y-auto p-6 lg:p-8">{children}</main>
        </div>
      </body>
    </html>
  );
}

/**
 * Sidebar navigation component.
 * Shows nav links, theme toggle, and logout button.
 *
 * Links to admin-only pages (`adminOnly`) are shown to admins and the
 * owner only (#218): the viewer's role comes from the request-scoped
 * holder the session guard fills (`viewer.ts`). When it is unknown they
 * are hidden (fail closed). Display only: the routes check the role.
 */
function Nav({ activeNav }: { activeNav?: string }) {
  const showAdminLinks = viewerIsAdmin();

  /** Nav items with their labels, paths, and SVG icons */
  const allLinks = [
    { id: "home", label: "Dashboard", href: "/dashboard", icon: HomeIcon },
    { id: "emails", label: "Emails", href: "/dashboard/emails", icon: EmailIcon },
    { id: "send", label: "Send Email", href: "/dashboard/send", icon: SendIcon },
    {
      id: "api-keys",
      label: "API Keys",
      href: "/dashboard/api-keys",
      icon: KeyIcon,
    },
    {
      id: "templates",
      label: "Templates",
      href: "/dashboard/templates",
      icon: TemplateIcon,
    },
    { id: "domains", label: "Domains", href: "/dashboard/domains", icon: GlobeIcon },
    { id: "webhooks", label: "Webhooks", href: "/dashboard/webhooks", icon: WebhookIcon },
    { id: "inbound", label: "Inbound", href: "/dashboard/inbound", icon: InboundIcon },
    {
      id: "dmarc-reports",
      label: "DMARC",
      href: "/dashboard/dmarc-reports",
      icon: GlobeIcon,
    },
    {
      id: "suppressions",
      label: "Suppressions",
      href: "/dashboard/suppressions",
      icon: NoEntryIcon,
    },
    {
      id: "users",
      label: "Users",
      href: "/dashboard/users",
      icon: UsersIcon,
      adminOnly: true,
    },
  ];
  const links = allLinks.filter((link) => showAdminLinks || !link.adminOnly);

  return (
    <aside class="w-64 shrink-0 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 flex flex-col">
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
              <span safe>{link.label}</span>
            </a>
          );
        })}
      </nav>

      {/* Bottom actions: docs, theme toggle + logout */}
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
          type="button"
          data-action="toggle-theme"
          class="flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800/50 hover:text-gray-900 dark:hover:text-gray-100 w-full transition-colors"
        >
          <ThemeIcon />
          <span id="theme-label">Toggle theme</span>
        </button>

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
