import { decodeHref } from "./href-decode.ts";
import { scanMarkup, type ScannedTag } from "./html-scan.ts";
import { MAX_TRACKED_LINKS, MAX_TRACKED_URL_LENGTH } from "./tracking-token.ts";

/**
 * The click tracking link rewriter (#187): replaces the `href` of the
 * links of an HTML body with tracking URLs, and changes nothing else.
 * In-repo and bounded:
 *
 * - The tags come from `scanMarkup` (`html-scan.ts`): one linear pass
 *   that skips comments, declarations and raw-text elements (`script`,
 *   `style`, `title`, `textarea`, `xmp`, `noscript`, `noembed`,
 *   `noframes`, `iframe`; everything after `<plaintext>`) and stops at a
 *   construct that never ends, keeping the rest exactly as it is. The one
 *   look-ahead (a link's visible text) reads a fixed window, for at most
 *   {@link MAX_TRACKED_LINKS} links. Linear in the input.
 * - Only `<a>` tags whose `href` is quoted (`"` or `'`) and reads, without
 *   ambiguity (`href-decode.ts`), as an `http:` or `https:` URL. The URL
 *   is signed in its canonical form (`new URL(href).href`), which is also
 *   where the redirect goes.
 * - Never rewritten: `mailto:`, `tel:`, fragments, relative and any other
 *   scheme; an `href` whose entities a browser might read differently;
 *   any link to BunMail's own host (`APP_BASE_URL`, whatever the scheme or
 *   path, so `/u/` and `/t/` links in any encoding); the domain's
 *   `unsubscribe_url` (exactly, or a path under it on a `/` boundary; a
 *   site-root URL only matches itself); anchors carrying
 *   `data-bunmail-notrack` (the attribute itself is removed); anchors
 *   whose visible text is a URL (phishing filters flag a visible URL that
 *   leads elsewhere); URLs over {@link MAX_TRACKED_URL_LENGTH} characters;
 *   every link after the first {@link MAX_TRACKED_LINKS} `http(s)` links.
 * - Everything but a rewritten `href` value (and a removed
 *   `data-bunmail-notrack`) is preserved byte for byte.
 *
 * Pure: no I/O, no logging. The text part is never rewritten.
 */

/** How far after `<a ...>` its closing `</a>` is looked for, to read the visible text. */
const LINK_TEXT_WINDOW = 4096;

/** The attribute that keeps a link untracked; removed from the output. */
const NO_TRACK_ATTRIBUTE = "data-bunmail-notrack";

/** The closing `</a` of a link, in its text window. */
const LINK_CLOSE = /<\/a(?=[\s/>])/i;

/** A tag inside a link's text, removed to read the visible text. */
const INNER_TAG = /<[^>]*>/g;

/** Visible text that reads as a URL: a scheme, `www.`, or a bare host name with an optional path. */
const URL_LIKE_TEXT =
  /^(?:https?:\/\/\S+|www\.\S+|[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/?#]\S*)?)$/i;

/** What the rewriter needs from its caller. */
export interface LinkRewriteOptions {
  /** BunMail's own host name (lowercase): links to it are never rewritten. */
  ownHost: string | null;
  /** The domain's static unsubscribe URL, canonical; never rewritten (see the file comment). */
  unsubscribeUrl: string | null;
  /** The tracking URL for the link at `position`, or `null` to leave it as it is. */
  trackingUrl: (url: string, position: number) => string | null;
}

/** The rewritten HTML and how many links were rewritten. */
export interface RewriteResult {
  html: string;
  rewritten: number;
}

/** One change to the input: replace `[start, end)` with `text`. */
interface Edit {
  start: number;
  end: number;
  text: string;
}

/**
 * The canonical `http(s)` URL an href opens, or `null` when it is not
 * one, is too long, or its entities are ambiguous.
 */
function linkUrl(raw: string): string | null {
  if (raw.length > MAX_TRACKED_URL_LENGTH * 4) return null;
  const href = decodeHref(raw);
  if (href === null || !/^https?:\/\//i.test(href) || !URL.canParse(href)) return null;
  const url = new URL(href);
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.href.length > MAX_TRACKED_URL_LENGTH ? null : url.href;
}

/**
 * Whether `url` is the domain's unsubscribe URL: the same URL, or (when
 * the unsubscribe URL has no query or fragment and is not a site root) a
 * URL on the same origin whose path is it or under it on a `/` boundary.
 */
export function matchesUnsubscribeUrl(url: string, unsubscribeUrl: string): boolean {
  if (url === unsubscribeUrl) return true;
  const own = new URL(unsubscribeUrl);
  if (own.search !== "" || own.hash !== "" || own.pathname === "/") return false;
  const link = new URL(url);
  if (link.origin !== own.origin) return false;
  const base = own.pathname.endsWith("/") ? own.pathname : `${own.pathname}/`;
  return link.pathname === own.pathname || link.pathname.startsWith(base);
}

/** Whether the visible text of the link opened at `textStart` is itself a URL. */
function textIsUrl(html: string, textStart: number): boolean {
  const window = html.slice(textStart, textStart + LINK_TEXT_WINDOW);
  const close = LINK_CLOSE.exec(window);
  if (!close) return false;
  const text = (decodeHref(window.slice(0, close.index).replace(INNER_TAG, "")) ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text !== "" && URL_LIKE_TEXT.test(text);
}

/** Whether a link to `url` is never rewritten because of where it goes. */
function skippedTarget(url: string, options: LinkRewriteOptions): boolean {
  if (options.ownHost !== null && new URL(url).hostname === options.ownHost) return true;
  return (
    options.unsubscribeUrl !== null && matchesUnsubscribeUrl(url, options.unsubscribeUrl)
  );
}

/** The edits for one `<a>` tag, and whether it counted as one of the tracked links. */
function anchorEdits(
  html: string,
  tag: ScannedTag,
  options: LinkRewriteOptions,
  position: number,
  considered: number,
): { edits: Edit[]; counted: boolean; rewritten: boolean } {
  const noTrack = tag.attributes.filter((a) => a.name === NO_TRACK_ATTRIBUTE);
  if (noTrack.length > 0) {
    return {
      edits: noTrack.map((a) => ({ start: a.leadStart, end: a.end, text: "" })),
      counted: false,
      rewritten: false,
    };
  }
  const href = tag.attributes.find((a) => a.name === "href");
  if (!href?.value?.quoted || considered >= MAX_TRACKED_LINKS) {
    return { edits: [], counted: false, rewritten: false };
  }
  const url = linkUrl(html.slice(href.value.start, href.value.end));
  if (url === null) return { edits: [], counted: false, rewritten: false };
  if (skippedTarget(url, options) || textIsUrl(html, tag.end)) {
    return { edits: [], counted: true, rewritten: false };
  }
  const tracking = options.trackingUrl(url, position);
  if (tracking === null) return { edits: [], counted: true, rewritten: false };
  return {
    edits: [{ start: href.value.start, end: href.value.end, text: tracking }],
    counted: true,
    rewritten: true,
  };
}

/** Applies ordered, non-overlapping edits. */
function applyEdits(html: string, edits: readonly Edit[]): string {
  if (edits.length === 0) return html;
  const parts: string[] = [];
  let copied = 0;
  for (const edit of edits) {
    parts.push(html.slice(copied, edit.start), edit.text);
    copied = edit.end;
  }
  parts.push(html.slice(copied));
  return parts.join("");
}

/** Rewrites the links of `html` (see the file comment). */
export function rewriteLinks(html: string, options: LinkRewriteOptions): RewriteResult {
  const edits: Edit[] = [];
  let rewritten = 0;
  let considered = 0;
  scanMarkup(html, (tag) => {
    if (tag.closing || tag.name !== "a") return;
    const anchor = anchorEdits(html, tag, options, rewritten, considered);
    edits.push(...anchor.edits);
    if (anchor.counted) considered += 1;
    if (anchor.rewritten) rewritten += 1;
  });
  return { html: applyEdits(html, edits), rewritten };
}
