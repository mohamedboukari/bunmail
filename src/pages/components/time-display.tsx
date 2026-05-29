/**
 * Shared date/time formatter for the dashboard. (#104)
 *
 * The dashboard is server-rendered by a Bun process whose locale and
 * timezone are the *machine's*, not the viewer's. In production
 * (Docker) that almost always means UTC + `en-US`. Calling
 * `toLocaleString()` on the server would burn that in. To render in
 * the viewer's machine time we punt formatting to the browser:
 *
 *   - Server emits `<time datetime="<iso>" data-bm-time>` with a
 *     static UTC fallback as text content.
 *   - {@link TimeDisplayScript} (injected once via BaseLayout) walks
 *     every such element on load and rewrites:
 *       • `textContent` → relative time (`5m ago`, `Yesterday 14:32`,
 *         `Jan 5, 14:32`, `Jan 5, 2024, 14:32`) in the browser's
 *         locale + timezone.
 *       • `title` → full absolute timestamp with timezone, so a
 *         hover always reveals the exact wall-clock value.
 *
 * Design rule: every rendered string carries BOTH date and time
 * (relative phrasings like "5m ago" inherently encode both). There
 * is intentionally no date-only format — the dashboard never shows
 * a bare date.
 *
 * Usage:
 *
 *   <TimeDisplay value={email.createdAt} />                  // relative + absolute hover
 *   <TimeDisplay value={key.lastUsedAt} fallback="Never" />  // null-safe
 */

interface TimeDisplayProps {
  /** Timestamp to render. Null/undefined → fallback string. */
  value: Date | null | undefined;
  /** Text to show when value is null/undefined. Defaults to `—`. */
  fallback?: string;
  /** Optional Tailwind classes piped to the `<time>` element. */
  class?: string;
}

export function TimeDisplay({
  value,
  fallback = "—",
  class: className,
}: TimeDisplayProps) {
  if (!value) return fallback;
  const iso = value.toISOString();
  /** Pre-hydration fallback — full UTC date + time, unambiguous. */
  const utcFallback = `${iso.slice(0, 16).replace("T", " ")} UTC`;
  return (
    <time datetime={iso} data-bm-time="" title={iso} class={className} safe>
      {utcFallback}
    </time>
  );
}

/**
 * Hydration script — emitted ONCE per page (via BaseLayout). Walks
 * every `<time data-bm-time>` element after parse and rewrites its
 * textContent to a relative-time phrase ("5m ago", "Yesterday 14:32",
 * "Jan 5, 14:32") in the viewer's locale + timezone, while the
 * `title` attribute carries the full absolute timestamp.
 *
 * Runs synchronously at end-of-body so the DOM is already populated;
 * no DOMContentLoaded listener needed. Locale `undefined` =
 * browser default. Timezone is inferred by `Intl.DateTimeFormat`
 * from the host machine.
 *
 * The script is also re-runnable: if future code dynamically injects
 * new `<time data-bm-time>` elements (none today), call
 * `window.bmHydrateTimes()` to refresh them.
 */
export function TimeDisplayScript() {
  return (
    <script>
      {`
        (function() {
          function fmtAbsolute(d, now, withYear) {
            return new Intl.DateTimeFormat(undefined, {
              month: 'short',
              day: 'numeric',
              year: withYear ? 'numeric' : undefined,
              hour: '2-digit',
              minute: '2-digit'
            }).format(d);
          }
          function fmtTime(d) {
            return new Intl.DateTimeFormat(undefined, {
              hour: '2-digit', minute: '2-digit'
            }).format(d);
          }
          function fmtTooltip(d) {
            return new Intl.DateTimeFormat(undefined, {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              timeZoneName: 'short'
            }).format(d);
          }
          function relative(d, now) {
            var diffMs = now.getTime() - d.getTime();
            /** Future dates: skip relative, show absolute. */
            if (diffMs < 0) {
              return fmtAbsolute(d, now, d.getFullYear() !== now.getFullYear());
            }
            var diffSec = Math.floor(diffMs / 1000);
            if (diffSec < 60) return 'just now';
            var diffMin = Math.floor(diffSec / 60);
            if (diffMin < 60) return diffMin + 'm ago';
            var diffHr = Math.floor(diffMin / 60);
            if (diffHr < 24) return diffHr + 'h ago';
            var diffDay = Math.floor(diffHr / 24);
            if (diffDay === 1) return 'Yesterday ' + fmtTime(d);
            if (diffDay < 7) {
              return new Intl.DateTimeFormat(undefined, {
                weekday: 'short', hour: '2-digit', minute: '2-digit'
              }).format(d);
            }
            return fmtAbsolute(d, now, d.getFullYear() !== now.getFullYear());
          }
          function hydrate() {
            var now = new Date();
            document.querySelectorAll('time[data-bm-time]').forEach(function(el) {
              var iso = el.getAttribute('datetime');
              if (!iso) return;
              var d = new Date(iso);
              if (isNaN(d.getTime())) return;
              try {
                el.textContent = relative(d, now);
                el.setAttribute('title', fmtTooltip(d));
              } catch (e) { /** Locale failure — leave server fallback. */ }
            });
          }
          window.bmHydrateTimes = hydrate;
          hydrate();
        })();
      `}
    </script>
  );
}
