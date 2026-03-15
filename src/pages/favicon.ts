import { Elysia } from "elysia";

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="5" y="25" width="90" height="60" rx="8" fill="#111" stroke="#e5e5e5" stroke-width="3"/>
  <path d="M5 33 L50 63 L95 33" fill="none" stroke="#e5e5e5" stroke-width="3" stroke-linejoin="round"/>
  <text x="28" y="20" font-size="22" font-weight="bold" font-family="monospace" fill="#e5e5e5">&lt;/&gt;</text>
</svg>`;

/**
 * Serves the BunMail favicon as /favicon.svg with aggressive caching.
 * All pages reference this via `<link rel="icon" href="/favicon.svg">`.
 */
export const faviconPlugin = new Elysia({ detail: { hide: true } })
  .get("/favicon.svg", () => {
    return new Response(FAVICON_SVG, {
      headers: {
        "content-type": "image/svg+xml",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  });
