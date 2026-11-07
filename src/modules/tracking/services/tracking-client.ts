import type { TrackingClientKind } from "../types/tracking.types.ts";

/**
 * What the request tells about who fetched a pixel or followed a link
 * (#187). Only these coarse results are stored: the user agent itself,
 * like the IP address, never is.
 */

/** How much of a `User-Agent` is read. */
const MAX_USER_AGENT_READ = 512;

/**
 * Fixed, lowercased substrings of the user agents of mail providers'
 * image proxies: Gmail (`GoogleImageProxy`, `via ggpht.com`) and Yahoo
 * (`YahooMailProxy`). Apple Mail Privacy Protection sends an ordinary
 * browser user agent and cannot be told apart this way.
 */
const IMAGE_PROXY_MARKERS: readonly string[] = [
  "googleimageproxy",
  "ggpht.com",
  "yahoomailproxy",
];

/** `image_proxy` for a known mail image proxy, else `unknown`. */
export function clientKindOf(userAgent: string | null): TrackingClientKind {
  if (userAgent === null || userAgent === "") return "unknown";
  const read = userAgent.slice(0, MAX_USER_AGENT_READ).toLowerCase();
  return IMAGE_PROXY_MARKERS.some((marker) => read.includes(marker))
    ? "image_proxy"
    : "unknown";
}

/**
 * A click's URL as stored: without query string, fragment and
 * credentials. Query strings often carry tokens; the full URL is still
 * in the email's HTML.
 */
export function storedClickUrl(url: string): string {
  const parsed = new URL(url);
  parsed.search = "";
  parsed.hash = "";
  parsed.username = "";
  parsed.password = "";
  return parsed.href;
}
