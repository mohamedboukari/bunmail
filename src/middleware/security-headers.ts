import { Elysia } from "elysia";

/**
 * Browser security headers on every response (#255).
 *
 * Applied in `onRequest`, so they reach every response the app builds:
 * plain bodies, redirects, `Response` objects returned by handlers and
 * the error handler's pages alike. Handlers may still override one (the
 * public auth pages keep `Referrer-Policy: strict-origin`).
 *
 * The CSP is a baseline that cannot break anything the dashboard does
 * today: no plugins, no `<base>` rewriting, forms only to this origin,
 * no framing by other sites. `script-src` / `style-src` come once the
 * Tailwind CDN script and the inline scripts are gone (#255, part 2).
 * The email preview's `srcdoc` iframe inherits this policy, which only
 * stops a previewed email from doing what the sandbox forbids anyway.
 *
 * Config-free by design (the caller passes what it needs), so the unit
 * test imports it without an environment, like `login-rate-limit.ts`.
 */

/** The baseline Content-Security-Policy (#255, part 1). */
export const BASELINE_CSP =
  "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

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
 *   own caching.
 */
export function securityHeaders(
  pathname: string,
  opts: { httpsBaseUrl: boolean },
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-security-policy": BASELINE_CSP,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    /** Not `no-referrer`: that makes browsers send `Origin: null` on same-origin POSTs (#215). */
    "referrer-policy": "same-origin",
  };
  if (opts.httpsBaseUrl) headers["strict-transport-security"] = HSTS;
  if (pathname === "/dashboard" || pathname.startsWith("/dashboard/")) {
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
