import { Elysia } from "elysia";

/**
 * Browser security headers on every response (#255).
 *
 * Applied in `onRequest`, so they reach every response the app builds:
 * plain bodies, redirects, `Response` objects returned by handlers and
 * the error handler's pages alike. Handlers may still override one (the
 * public auth pages keep `Referrer-Policy: strict-origin`).
 *
 * Two Content-Security-Policies, chosen by path:
 *
 * - {@link PAGE_CSP} on the pages BunMail renders itself: the landing page
 *   (`/`) and the dashboard (`/dashboard...`), plus the HTML 404 page,
 *   which sets it on its own response (any path can 404). Since #255 part
 *   2 those pages load only BunMail's own stylesheet and script (no
 *   Tailwind CDN, no inline script, no `on*=` attribute), so
 *   `script-src 'self'` blocks any injected script. `style-src` keeps
 *   `'unsafe-inline'` because the email preview is a `srcdoc` iframe,
 *   which inherits this policy, and email HTML relies on inline styles;
 *   `img-src https:` keeps remote images in previews working as before
 *   (plain `http:` images, remote fonts and remote stylesheets inside a
 *   previewed email no longer load).
 * - {@link BASELINE_CSP} everywhere else, which cannot break anything:
 *   no plugins, no `<base>` rewriting, forms only to this origin, no
 *   framing by other sites. The OpenAPI reference at `/api/docs` (Scalar,
 *   loaded from a CDN with inline scripts) must stay on it; the API's
 *   JSON responses need no more.
 *
 * Config-free by design (the caller passes what it needs), so the unit
 * test imports it without an environment, like `login-rate-limit.ts`.
 */

/** The baseline Content-Security-Policy (#255, part 1), for every response. */
export const BASELINE_CSP =
  "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** The full Content-Security-Policy for BunMail's own HTML pages (#255, part 2). */
export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self'",
  "connect-src 'self'",
  BASELINE_CSP,
].join("; ");

/** True for the dashboard (`/dashboard`, `/dashboard/...`), never `/dashboardx`. */
function isDashboardPath(pathname: string): boolean {
  return pathname === "/dashboard" || pathname.startsWith("/dashboard/");
}

/** One year: the usual HSTS lifetime. No `includeSubDomains`: other subdomains may not serve HTTPS. */
const HSTS = "max-age=31536000";

/**
 * The security headers for a response to `pathname`.
 *
 * - `Strict-Transport-Security` only when the dashboard is served over
 *   HTTPS (`APP_BASE_URL` is `https://`); browsers ignore it over plain
 *   HTTP anyway, and it must not pin a host that has no certificate.
 * - `Cache-Control: no-store` on the dashboard (`/dashboard/...`): its
 *   pages show mail, keys and one-time secrets and must not stay in a
 *   browser or proxy cache. The landing page, favicon and API keep their
 *   own caching, and so do the dashboard's static assets, whose handler
 *   overrides it (`static-assets.tsx`).
 */
export function securityHeaders(
  pathname: string,
  opts: { httpsBaseUrl: boolean },
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-security-policy":
      pathname === "/" || isDashboardPath(pathname) ? PAGE_CSP : BASELINE_CSP,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    /** Not `no-referrer`: that makes browsers send `Origin: null` on same-origin POSTs (#215). */
    "referrer-policy": "same-origin",
  };
  if (opts.httpsBaseUrl) headers["strict-transport-security"] = HSTS;
  if (isDashboardPath(pathname)) {
    headers["cache-control"] = "no-store";
  }
  return headers;
}

/**
 * Elysia plugin that sets {@link securityHeaders} on every response.
 *
 * @param opts.httpsBaseUrl True when `APP_BASE_URL` is an `https://` URL.
 */
export function securityHeadersPlugin(opts: { httpsBaseUrl: boolean }): Elysia {
  return new Elysia({ name: "security-headers" }).onRequest(({ request, set }) => {
    Object.assign(set.headers, securityHeaders(new URL(request.url).pathname, opts));
  });
}
