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
 * Wraps raw HTML with a `<style>` block that:
 * - Defaults to white background / dark text
 * - Switches to dark background / light text when `data-theme="dark"` is on `<html>`
 * The parent script toggles the attribute via a MutationObserver.
 */
function wrapWithDarkModeStyles(html: string): string {
  const styleBlock = `<style>
html, body { background: #fff; color: #111; }
html[data-theme="dark"],
html[data-theme="dark"] body { background: #0a0a0a !important; color: #e5e5e5 !important; }
html[data-theme="dark"] * { background-color: transparent !important; color: #e5e5e5 !important; border-color: #374151 !important; }
html[data-theme="dark"] a { color: #93c5fd !important; }
html[data-theme="dark"] img { opacity: 0.9; color: initial !important; }
</style>`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">${styleBlock}</head><body>${html}</body></html>`;
}

export function HtmlPreview({ html, title = "HTML preview", minHeight = "400px" }: HtmlPreviewProps) {
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
