/**
 * HtmlPreview: renders user-provided HTML content in a sandboxed iframe
 * with automatic dark mode support.
 *
 * Injects a small CSS reset into the srcdoc so the iframe background
 * and text color adapt when the parent page toggles dark mode. The
 * dashboard script (`assets/dashboard.js`, "Email HTML previews") keeps
 * the iframe in sync with the parent's theme through a MutationObserver
 * on <html>'s class list, and sizes it to its content.
 *
 * Remote images are blocked by default (#419): the srcdoc document starts
 * with its own `<meta http-equiv="Content-Security-Policy">`, so opening an
 * email does not fetch a tracking pixel (a read receipt that also leaks the
 * viewer's IP, time and user agent). A "Load remote images" link reloads the
 * page with `?images=1`, which renders the preview with a policy that also
 * allows `https:` images. See {@link previewCsp}. Before that, every
 * `<link>`, `<meta>`, `<base>`, `<noscript>`, `<iframe>`, `<math>` and
 * `<svg>` element of the email is removed, and any `<link`, `<meta` or
 * `<base` tag left after that is turned into text
 * ({@link sanitizeEmailForPreview}): a `<link rel="prerender">` or
 * `preconnect` reaches the network whatever the CSP says.
 */

import { logger } from "../../utils/logger.ts";

interface HtmlPreviewProps {
  html: string;
  /**
   * The detail page's own path, without a query (e.g.
   * `/dashboard/inbound/<id>`). The "Load remote images" and "Hide them"
   * links point at it, with and without `?images=1`.
   */
  pageHref: string;
  /** True when the viewer asked for remote `https:` images (`?images=1`, #419). */
  remoteImages?: boolean;
  title?: string;
  minHeight?: string;
}

/**
 * Dark-mode `<style>` block injected into every preview iframe's srcdoc:
 * - Defaults to white background / dark text
 * - Switches to dark background / light text when `data-theme="dark"` is on `<html>`
 * The dashboard script toggles the attribute via a MutationObserver.
 *
 * Extracted as a constant so the server-rendered srcdoc (`wrapWithDarkModeStyles`)
 * and the client-side live updater (fed by `LiveHtmlPreviewData`) share one source
 * of truth and produce byte-identical markup: no flash when the script takes over.
 */
const PREVIEW_STYLE_BLOCK = `<style>
html, body { background: #fff; color: #111; }
html[data-theme="dark"],
html[data-theme="dark"] body { background: #0a0a0a !important; color: #e5e5e5 !important; }
html[data-theme="dark"] * { background-color: transparent !important; color: #e5e5e5 !important; border-color: #374151 !important; }
html[data-theme="dark"] a { color: #93c5fd !important; }
html[data-theme="dark"] img { opacity: 0.9; color: initial !important; }
</style>`;

/**
 * The Content-Security-Policy the email preview document declares itself
 * (#419), in a `<meta http-equiv>` at the start of its `<head>`.
 *
 * How it combines with the page policy: a `srcdoc` iframe inherits the
 * dashboard page's CSP (`PAGE_CSP` in `src/middleware/security-headers.ts`),
 * and a policy the document declares is enforced IN ADDITION to it, so a
 * load must pass both. The meta can only tighten what the page allows,
 * never relax it, and the page CSP is left untouched.
 *
 * - `default-src 'none'`: no fetch of any other kind (media, fonts, frames,
 *   connections), not even from BunMail's own origin. Resource hints
 *   (`<link rel="prerender">`, `preconnect`, `dns-prefetch`) are NOT
 *   reliably governed by CSP, which is why {@link sanitizeEmailForPreview}
 *   removes every `<link>` from the email first.
 * - `style-src 'unsafe-inline'`: email HTML relies on inline styles and
 *   `<style>` blocks, and the preview's own dark-mode block is one. Remote
 *   stylesheets stay blocked (the page policy already refused them).
 * - `img-src data:`: `data:` images only. CSS backgrounds (`url(...)`),
 *   the `background` attribute, `srcset`, `poster` and SVG images are all
 *   governed by `img-src`, so none of them leaks an open. `cid:` images
 *   (inline attachments) are not resolved: nothing rewrites them and the
 *   page policy has no `cid:` either, as before #419.
 * - With `remoteImages` (the viewer clicked "Load remote images"): `https:`
 *   images too, never plain `http:` (the page policy forbids it anyway).
 *
 * A meta policy only governs what comes after it, so it is the first thing
 * after the charset, before the style block and the email. A meta CSP the
 * email itself carries is removed by {@link sanitizeEmailForPreview}; even
 * if one survived, it would land in `<body>`, where the browser ignores it,
 * and policies combine, so it could only tighten further.
 */
export function previewCsp(remoteImages: boolean): string {
  /** `https:` is the only remote scheme ever allowed, and only on request. */
  const imageSources = remoteImages ? "data: https:" : "data:";
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `img-src ${imageSources}`,
  ].join("; ");
}

/**
 * Wraps raw HTML into a full document carrying the dark-mode style block:
 * the live template preview, whose client-side twin in `dashboard.js`
 * builds the same document. The email previews use
 * {@link buildEmailPreviewDocument} instead (#419).
 */
function wrapWithDarkModeStyles(html: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">${PREVIEW_STYLE_BLOCK}</head><body>${html}</body></html>`;
}

/**
 * The document around the email while it is sanitized: BunMail's own head
 * is added only afterwards, so the rewriter never sees (or removes) the
 * charset and CSP metas. Contains no element the rewriter touches, so it
 * comes out byte for byte.
 */
const SANITIZE_PREFIX = "<!DOCTYPE html><html><head></head><body>";
const SANITIZE_SUFFIX = "</body></html>";

/**
 * Elements removed with their content: the network-reaching ones, plus the
 * containers in which the rewriter and a browser can disagree on what is
 * markup (see {@link sanitizeEmailForPreview}).
 */
const REMOVED_ELEMENTS = "link, meta, base, noscript, iframe, math, svg";

/**
 * A `<link`, `<meta` or `<base` start tag as a browser's tokenizer reads
 * it: the tag name in any case, ended by whitespace (`\r` included, the
 * browser turns it into `\n` first), `/`, `>` or the end of the input.
 * Character references are never decoded in a tag name, and any other
 * character (a NUL included) makes it a different name, so nothing else
 * can produce one of these elements.
 *
 * Linear time: a fixed-length check at each `<`, no nested or adjacent
 * quantifier, so the whole output is scanned (no size limit is needed).
 */
const RESIDUAL_TAG_PATTERN = /<((?:link|meta|base)(?=[\t\n\f\r />]|$))/gi;

/**
 * Removes the elements of an email that reach the network or change the
 * preview's rules regardless of its CSP (#419):
 *
 * - `<link>`: `rel="prerender"` makes Chrome send a full GET when the
 *   preview opens, `preconnect` / `dns-prefetch` open a connection (a
 *   per-recipient host name leaks the open), `preload` / `prefetch` /
 *   `modulepreload` / `stylesheet` fetch. None is needed to show an email.
 * - `<meta>`: `name="referrer"` would override the page's Referrer-Policy
 *   (the dashboard URL in the Referer of loaded images), `http-equiv`
 *   `refresh` / `Content-Security-Policy` / others change behaviour.
 * - `<base>`: would rebase relative URLs (the CSP already blocks the
 *   fetches; removing it is cheap).
 * - `<noscript>`, with its content: the sandboxed preview runs no script,
 *   so the browser parses its content as markup, while the rewriter (like
 *   any parser with scripting on) reads it as text; a `<link>` inside it
 *   would otherwise survive.
 * - `<math>` and `<svg>`, with their content (#454): inside foreign
 *   content the rewriter and a browser can disagree on which elements are
 *   raw text, so a crafted email could carry one of the elements above
 *   past the rewriter and have the browser create it. Email clients do
 *   not render MathML, and most do not render inline SVG either.
 * - `<iframe>`, with its content (#454): a `srcdoc` attribute is a whole
 *   nested document, entity-encoded, which neither pass reads. The CSP
 *   already blocks an iframe's `src`.
 *
 * Then a backstop (#454): any `<link`, `<meta` or `<base` start tag still
 * in the output (inside what the rewriter read as raw text, wherever a
 * browser might read it as markup) has its `<` written `&lt;`, so it can
 * only ever be text. In real raw text (a `<style>` block) that changes the
 * text, which is harmless.
 *
 * Uses Bun's built-in `HTMLRewriter` (lol-html, a streaming spec
 * tokenizer: linear time, no tree), never a regex, for the removal. The
 * email is rewritten in its final position, between `<body>` and
 * `</body></html>`, so an unterminated tag at its end (`<link
 * rel=prerender href=... `) is completed by the closing tags exactly as
 * the browser would, and removed. Removing more than the browser would see
 * (when the two disagree on what is text) only drops content, never lets a
 * hint through.
 *
 * Fails safe: if the rewriter throws or its output does not start with the
 * prefix, the result is `null` and the preview shows nothing of the email.
 *
 * @returns The sanitized body content (everything after `<body>`), or `null`.
 */
export function sanitizeEmailForPreview(html: string): string | null {
  try {
    const rewritten = new HTMLRewriter()
      .on(REMOVED_ELEMENTS, {
        element(element) {
          element.remove();
        },
      })
      .transform(`${SANITIZE_PREFIX}${html}${SANITIZE_SUFFIX}`);
    if (!rewritten.startsWith(SANITIZE_PREFIX)) {
      logger.warn("Email preview sanitizer produced an unexpected document", {
        length: html.length,
      });
      return null;
    }
    return rewritten
      .slice(SANITIZE_PREFIX.length)
      .replace(RESIDUAL_TAG_PATTERN, "&lt;$1");
  } catch (error) {
    logger.warn("Email preview sanitizer failed: preview left empty", {
      length: html.length,
      error: error instanceof Error ? error.name : "unknown",
    });
    return null;
  }
}

/**
 * Builds the email preview document (#419): BunMail's head (charset, the
 * preview CSP, the dark-mode style block), then the sanitized email. The
 * sanitized body already carries its closing `</body></html>` (unless an
 * unterminated construct at the end of the email swallowed them, which the
 * browser tolerates). When sanitizing failed, the body is a short notice.
 */
function buildEmailPreviewDocument(html: string, remoteImages: boolean): string {
  const body =
    sanitizeEmailForPreview(html) ??
    "<p>This email could not be prepared for a safe preview.</p></body></html>";
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${previewCsp(remoteImages)}">${PREVIEW_STYLE_BLOCK}</head><body>${body}`;
}

/**
 * Encodes a whole srcdoc document for the `srcdoc` attribute.
 *
 * `@kitajs/html` escapes only `"` in attribute values, which keeps the
 * attribute closed but lets the browser decode entities: an email that
 * shows the text `&lt;img src=...&gt;` would become a real `<img>` in the
 * preview. Escaping `&`, `<`, `>`, `"` and `'` here first means the iframe
 * parses exactly the stored HTML; the result has no `"` left, so
 * `@kitajs/html` emits it unchanged (no double escaping).
 */
function encodeSrcdoc(doc: string): string {
  return Bun.escapeHTML(doc);
}

/**
 * Cheap scan for remote image references in email HTML (#419): an
 * `http(s)://` or protocol-relative (`//`) URL in a `src`, `srcset`,
 * `background` or `poster` attribute (any candidate of a quoted `srcset`),
 * or in a CSS `url(...)` or `image-set(...)`.
 *
 * It only decides whether to show the "Remote images are hidden" notice;
 * the blocking itself is the preview's CSP, which does not depend on it. A
 * reference it misses (an entity- or backslash-escaped URL, an SVG
 * `<image href>`, one past {@link REMOTE_IMAGE_SCAN_LIMIT}) is still
 * blocked, just without the notice. A match in a `data-src=` attribute or
 * in text shows the notice needlessly, which is harmless.
 *
 * Linear time on hostile input (an inbound email can be 10 MB): no two
 * adjacent quantifiers can match the same characters (the older
 * `=\s*["']?\s*` backtracked quadratically on a run of spaces), and the
 * `srcset` branch scans one quoted value, stopping at the next quote.
 */
const REMOTE_IMAGE_PATTERN =
  /(?:\b(?:src|srcset|background|poster)\s*=|\b(?:url|image-set)\()\s*(?:["']\s*)?(?:https?:)?\/\/|\bsrcset\s*=\s*["'][^"']*,\s*(?:https?:)?\/\//i;

/**
 * Only the first 1,000,000 characters of an email are scanned for the
 * notice, bounding the work per page view whatever the email's size.
 */
const REMOTE_IMAGE_SCAN_LIMIT = 1_000_000;

/** True when `html` seems to reference a remote image (see {@link REMOTE_IMAGE_PATTERN}). */
export function hasRemoteImages(html: string): boolean {
  return REMOTE_IMAGE_PATTERN.test(html.slice(0, REMOTE_IMAGE_SCAN_LIMIT));
}

/**
 * Sample values used to render `{{variable}}` placeholders in template previews.
 * Common names get a realistic value; anything else falls back to its own name
 * (handled in `renderPreviewSamples`). Shared with the client script verbatim.
 */
const PREVIEW_SAMPLE_VALUES: Record<string, string> = {
  name: "Alex Doe",
  firstName: "Alex",
  lastName: "Doe",
  fullName: "Alex Doe",
  company: "Acme Inc",
  email: "alex@example.com",
  url: "https://example.com",
  link: "https://example.com",
  code: "123456",
  amount: "$42.00",
  date: "Jan 1, 2026",
};

/**
 * Substitutes every `{{variable}}` with a sample value so a template preview
 * resembles a real, sent email instead of showing raw placeholders.
 *
 * Mirrors the `/\{\{(\w+)\}\}/g` matcher of `renderTemplate()` in
 * `template.service.ts` (so spaced/invalid placeholders like `{{ x }}` are
 * left untouched in both), but always fills matched placeholders with a sample
 * value rather than leaving unmatched ones as-is. Keep this in sync with the
 * client-side `substitute()` in `assets/dashboard.js`.
 */
export function renderPreviewSamples(html: string): string {
  /** `{{{var}}}` (raw, #250) and `{{var}}`: samples are plain text either way. */
  return html.replace(
    /\{\{\{(\w+)\}\}\}|\{\{(\w+)\}\}/g,
    (_match, rawKey: string | undefined, key: string | undefined) => {
      const name = rawKey ?? key ?? "";
      return PREVIEW_SAMPLE_VALUES[name] ?? name;
    },
  );
}

/** `id` of the preview's container, the target of the image links (`#html-preview`). */
const PREVIEW_ANCHOR = "html-preview";

/**
 * The email preview of the outbound and inbound detail pages, with remote
 * images blocked unless `remoteImages` (#419).
 *
 * Above the iframe, server-rendered (no script, so it works under the
 * dashboard's `script-src 'self'`):
 * - remote images blocked and the HTML references some: "Remote images are
 *   hidden to protect your privacy." with a "Load remote images" link to
 *   `pageHref?images=1`;
 * - remote images loaded: a note with a "Hide them" link back to `pageHref`.
 */
export function HtmlPreview({
  html,
  pageHref,
  remoteImages = false,
  title = "HTML preview",
  minHeight = "400px",
}: HtmlPreviewProps): JSX.Element {
  const wrappedHtml = encodeSrcdoc(buildEmailPreviewDocument(html, remoteImages));
  /** The notice only when something was actually held back. */
  const showBlockedNotice = !remoteImages && hasRemoteImages(html);

  return (
    <div class="relative" id={PREVIEW_ANCHOR}>
      {showBlockedNotice && (
        <p class="html-preview-images-notice mb-3 px-3 py-2 text-xs rounded border border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-900/20 dark:text-amber-200">
          Remote images are hidden to protect your privacy.{" "}
          <a
            href={`${pageHref}?images=1#${PREVIEW_ANCHOR}`}
            class="font-medium underline hover:no-underline"
          >
            Load remote images
          </a>
        </p>
      )}
      {remoteImages && (
        <p class="html-preview-images-notice mb-3 px-3 py-2 text-xs rounded border border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-800 dark:bg-gray-800/40 dark:text-gray-300">
          Remote images are shown: loading them can tell the sender this email was opened.{" "}
          <a
            href={`${pageHref}#${PREVIEW_ANCHOR}`}
            class="font-medium underline hover:no-underline"
          >
            Hide them
          </a>
        </p>
      )}
      <iframe
        srcdoc={wrappedHtml}
        class="html-preview-frame w-full border-0 rounded"
        style={`min-height:${minHeight}`}
        sandbox="allow-same-origin"
        title={title}
      ></iframe>
    </div>
  );
}

interface LiveHtmlPreviewProps {
  /** `id` of the `<textarea>` whose value drives this preview. */
  textareaId: string;
  /** Initial HTML to seed the first (pre-JS) paint: e.g. a saved template body. */
  initialHtml?: string | null;
  title?: string;
  minHeight?: string;
}

/**
 * LiveHtmlPreview: a sandboxed iframe that mirrors a `<textarea>` as the user
 * types, with `{{variable}}` placeholders rendered as sample values.
 *
 * The first paint is server-rendered from `initialHtml` (so the saved template
 * shows immediately and degrades gracefully without JS); thereafter
 * the dashboard script updates the iframe's `srcdoc` on every keystroke.
 * Stays `sandbox="allow-same-origin"` (no `allow-scripts`) so embedded scripts
 * never execute: same posture as the static {@link HtmlPreview}.
 */
export function LiveHtmlPreview({
  textareaId,
  initialHtml = "",
  title = "Template HTML preview",
  minHeight = "240px",
}: LiveHtmlPreviewProps) {
  const wrappedHtml = encodeSrcdoc(
    wrapWithDarkModeStyles(renderPreviewSamples(initialHtml ?? "")),
  );

  return (
    <iframe
      srcdoc={wrappedHtml}
      class="live-html-preview-frame w-full border-0 rounded"
      style={`min-height:${minHeight}`}
      sandbox="allow-same-origin"
      title={title}
      data-source={textareaId}
    ></iframe>
  );
}

/**
 * Data block: include once per page that uses LiveHtmlPreview.
 *
 * The dashboard script (`assets/dashboard.js`, "Live template previews")
 * binds each live preview iframe to its source textarea and re-renders the
 * sample-substituted HTML (debounced) on input, keeping dark mode and the
 * height in sync. It reads the shared style block and sample dictionary
 * from this JSON block, so the client output exactly matches the
 * server-rendered first paint.
 *
 * `type="application/json"` is data, never run, so the CSP's
 * `script-src 'self'` allows it. Every `<` is written as `\u003c` (still
 * the same JSON), so the style block's `</style>` can never close the
 * element early. The content is built only from the constants above.
 */
export function LiveHtmlPreviewData() {
  const safeJson = JSON.stringify({
    style: PREVIEW_STYLE_BLOCK,
    samples: PREVIEW_SAMPLE_VALUES,
  }).replace(/</g, "\\u003c");

  return (
    <script type="application/json" id="bm-live-preview-data">
      {safeJson}
    </script>
  );
}
