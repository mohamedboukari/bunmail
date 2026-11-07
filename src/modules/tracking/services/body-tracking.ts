import { lastBodyClose } from "./html-scan.ts";
import { rewriteLinks, type LinkRewriteOptions } from "./link-rewriter.ts";

/**
 * What tracking adds to an HTML body at send time (#187): rewritten links
 * (clicks), then the open pixel. `composeMessageBody` applies it after it
 * has derived the text alternative from the original HTML, so tracking
 * URLs never reach the text part. Pure and deterministic: the same email
 * gives the same body on every retry, so the DKIM body hash is stable.
 */

/** The tracking of one message, built by `trackingForEmail` (or absent). */
export interface BodyTracking {
  /** The open pixel's URL, or null when opens are not tracked. */
  pixelUrl: string | null;
  /** How to rewrite the links, or null when clicks are not tracked. */
  links: LinkRewriteOptions | null;
}

/** What tracking changed in a body. */
export interface BodyTrackingResult {
  html: string;
  /** Links rewritten. */
  links: number;
  /** Whether the pixel was added. */
  pixel: boolean;
}

/** The pixel: 1x1, no alt text, no border, a block so it adds no line height. */
function pixelTag(url: string): string {
  return `<img src="${url}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px">`;
}

/**
 * `html` with the pixel inserted before its last `</body>` that is real
 * markup (not inside a comment, `<script>`, `<style>`, `<textarea>` and
 * the like: the rewriter's scan, `lastBodyClose`), or at the end when it
 * has none. `url` is BunMail's own (base URL and a hex token), so it
 * needs no escaping inside the quoted attribute.
 */
export function insertOpenPixel(html: string, url: string): string {
  const last = lastBodyClose(html);
  const tag = pixelTag(url);
  return last < 0 ? html + tag : html.slice(0, last) + tag + html.slice(last);
}

/** Applies `tracking` to an HTML body: links first, then the pixel. */
export function applyBodyTracking(
  html: string,
  tracking: BodyTracking,
): BodyTrackingResult {
  const rewritten =
    tracking.links === null ? { html, rewritten: 0 } : rewriteLinks(html, tracking.links);
  if (tracking.pixelUrl === null) {
    return { html: rewritten.html, links: rewritten.rewritten, pixel: false };
  }
  return {
    html: insertOpenPixel(rewritten.html, tracking.pixelUrl),
    links: rewritten.rewritten,
    pixel: true,
  };
}
