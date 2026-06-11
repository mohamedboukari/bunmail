/**
 * HtmlPreview — renders user-provided HTML content in a sandboxed iframe
 * with automatic dark mode support.
 *
 * Injects a small CSS reset into the srcdoc so the iframe background
 * and text color adapt when the parent page toggles dark mode.
 * A MutationObserver on <html>'s class list keeps the iframe in sync
 * with the parent's theme in real time.
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
 * The parent script toggles the attribute via a MutationObserver.
 *
 * Extracted as a constant so the server-rendered srcdoc (`wrapWithDarkModeStyles`)
 * and the client-side live updater (`LiveHtmlPreviewScript`) share one source of
 * truth and produce byte-identical markup — no flash when the script takes over.
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
 * client-side `substitute()` in `LiveHtmlPreviewScript`.
 */
export function renderPreviewSamples(html: string): string {
  return html.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    return PREVIEW_SAMPLE_VALUES[key] ?? key;
  });
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

/**
 * Script block — include once per page that uses HtmlPreview.
 * Observes the root <html> element for dark mode class changes
 * and propagates theme to all preview iframes.
 */
export function HtmlPreviewScript() {
  return (
    <script>
      {`
        (function() {
          function syncIframeThemes() {
            var isDark = document.documentElement.classList.contains('dark');
            document.querySelectorAll('iframe.html-preview-frame').forEach(function(iframe) {
              try {
                var doc = iframe.contentDocument;
                if (doc && doc.documentElement) {
                  doc.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
                }
              } catch(e) {}
            });
          }

          // Sync on load
          window.addEventListener('load', function() {
            setTimeout(syncIframeThemes, 100);
          });

          // Watch for dark mode toggling
          var observer = new MutationObserver(function(mutations) {
            mutations.forEach(function(m) {
              if (m.attributeName === 'class') syncIframeThemes();
            });
          });
          observer.observe(document.documentElement, { attributes: true });

          function autoResizeIframes() {
            document.querySelectorAll('iframe.html-preview-frame').forEach(function(iframe) {
              try {
                var doc = iframe.contentDocument;
                if (doc && doc.body) {
                  iframe.style.height = doc.body.scrollHeight + 'px';
                }
              } catch(e) {}
            });
          }

          // Sync theme + resize when iframes finish loading
          document.querySelectorAll('iframe.html-preview-frame').forEach(function(iframe) {
            iframe.addEventListener('load', function() {
              setTimeout(function() { syncIframeThemes(); autoResizeIframes(); }, 50);
            });
          });
        })();
      `}
    </script>
  );
}

interface LiveHtmlPreviewProps {
  /** `id` of the `<textarea>` whose value drives this preview. */
  textareaId: string;
  /** Initial HTML to seed the first (pre-JS) paint — e.g. a saved template body. */
  initialHtml?: string | null;
  title?: string;
  minHeight?: string;
}

/**
 * LiveHtmlPreview — a sandboxed iframe that mirrors a `<textarea>` as the user
 * types, with `{{variable}}` placeholders rendered as sample values.
 *
 * The first paint is server-rendered from `initialHtml` (so the saved template
 * shows immediately and degrades gracefully without JS); thereafter
 * `LiveHtmlPreviewScript` updates the iframe's `srcdoc` on every keystroke.
 * Stays `sandbox="allow-same-origin"` (no `allow-scripts`) so embedded scripts
 * never execute — same posture as the static {@link HtmlPreview}.
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
 * Script block — include once per page that uses LiveHtmlPreview.
 * Binds each live preview iframe to its source textarea, re-rendering the
 * sample-substituted HTML (debounced) on input, and keeps dark mode +
 * auto-resize in sync. Targets the `live-html-preview-frame` class only, so it
 * never collides with the static {@link HtmlPreviewScript}.
 */
export function LiveHtmlPreviewScript() {
  // Inline the shared style block + sample dictionary so client output exactly
  // matches the server-rendered first paint. JSON.stringify keeps them as valid
  // JS string/object literals regardless of their contents.
  const styleLiteral = JSON.stringify(PREVIEW_STYLE_BLOCK);
  const samplesLiteral = JSON.stringify(PREVIEW_SAMPLE_VALUES);

  return (
    <script>
      {`
        (function() {
          var STYLE = ${styleLiteral};
          var SAMPLES = ${samplesLiteral};

          // Mirrors renderPreviewSamples() in html-preview.tsx and the
          // {{\\w+}} matcher of renderTemplate(): fill placeholders with sample
          // values, falling back to the variable name itself.
          function substitute(html) {
            return html.replace(/\\{\\{(\\w+)\\}\\}/g, function(match, key) {
              return Object.prototype.hasOwnProperty.call(SAMPLES, key) ? SAMPLES[key] : key;
            });
          }
          function wrap(html) {
            return '<!DOCTYPE html><html><head><meta charset="UTF-8">' + STYLE + '</head><body>' + html + '</body></html>';
          }
          function applyTheme(iframe) {
            try {
              var isDark = document.documentElement.classList.contains('dark');
              var doc = iframe.contentDocument;
              if (doc && doc.documentElement) {
                doc.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
              }
            } catch(e) {}
          }
          function resize(iframe) {
            try {
              var doc = iframe.contentDocument;
              if (doc && doc.body) iframe.style.height = doc.body.scrollHeight + 'px';
            } catch(e) {}
          }

          document.querySelectorAll('iframe.live-html-preview-frame').forEach(function(iframe) {
            var sourceId = iframe.getAttribute('data-source');
            var source = sourceId ? document.getElementById(sourceId) : null;
            if (!source) return;

            var timer = null;
            function render() {
              iframe.srcdoc = wrap(substitute(source.value || ''));
            }
            // Re-sync theme + height each time the (re)loaded srcdoc is ready.
            iframe.addEventListener('load', function() {
              setTimeout(function() { applyTheme(iframe); resize(iframe); }, 30);
            });
            source.addEventListener('input', function() {
              if (timer) clearTimeout(timer);
              timer = setTimeout(render, 150);
            });
            // First paint is server-rendered; just adopt the current theme/size.
            applyTheme(iframe);
            resize(iframe);
          });

          // Keep live previews in sync when the page toggles dark mode.
          var observer = new MutationObserver(function(mutations) {
            mutations.forEach(function(m) {
              if (m.attributeName === 'class') {
                document.querySelectorAll('iframe.live-html-preview-frame').forEach(applyTheme);
              }
            });
          });
          observer.observe(document.documentElement, { attributes: true });
        })();
      `}
    </script>
  );
}
