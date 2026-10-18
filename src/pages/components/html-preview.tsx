/**
 * HtmlPreview: renders user-provided HTML content in a sandboxed iframe
 * with automatic dark mode support.
 *
 * Injects a small CSS reset into the srcdoc so the iframe background
 * and text color adapt when the parent page toggles dark mode. The
 * dashboard script (`assets/dashboard.js`, "Email HTML previews") keeps
 * the iframe in sync with the parent's theme through a MutationObserver
 * on <html>'s class list, and sizes it to its content.
 */

interface HtmlPreviewProps {
  html: string;
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

/** Wraps raw HTML into a full document carrying the dark-mode style block. */
function wrapWithDarkModeStyles(html: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">${PREVIEW_STYLE_BLOCK}</head><body>${html}</body></html>`;
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

export function HtmlPreview({
  html,
  title = "HTML preview",
  minHeight = "400px",
}: HtmlPreviewProps) {
  const wrappedHtml = wrapWithDarkModeStyles(html);

  return (
    <div class="relative">
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
  const wrappedHtml = wrapWithDarkModeStyles(renderPreviewSamples(initialHtml ?? ""));

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
