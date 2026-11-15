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
 *   - The dashboard script (`assets/dashboard.js`, "Time display")
 *     walks every such element once the page is parsed and rewrites:
 *       • `textContent` → relative time (`5m ago`, `Yesterday 14:32`,
 *         `Jan 5, 14:32`, `Jan 5, 2024, 14:32`) in the browser's
 *         locale + timezone.
 *       • `title` → full absolute timestamp with timezone, so a
 *         hover always reveals the exact wall-clock value.
 *
 * Design rule: every rendered string carries BOTH date and time
 * (relative phrasings like "5m ago" inherently encode both). There
 * is intentionally no date-only format: the dashboard never shows
 * a bare date.
 *
 * Usage:
 *
 *   <TimeDisplay value={email.createdAt} />                  // relative + absolute hover
 *   <TimeDisplay value={key.lastUsedAt} fallback="Never" />  // null-safe
 *
 * A Postgres `infinity` / `-infinity` timestamp (a hand-edited row) is not
 * an instant and shows the fallback too (#457, see `finiteDate`).
 */

import { finiteDate } from "../../utils/finite-date.ts";

interface TimeDisplayProps {
  /** Timestamp to render. Null/undefined (or not a finite instant) → fallback string. */
  value: Date | null | undefined;
  /** Text to show when there is no instant to render. Defaults to `n/a`. */
  fallback?: string;
  /** Optional Tailwind classes piped to the `<time>` element. */
  class?: string;
}

export function TimeDisplay({
  value,
  fallback = "n/a",
  class: className,
}: TimeDisplayProps) {
  const at = finiteDate(value);
  if (at === null) return fallback;
  const iso = at.toISOString();
  /** Pre-hydration fallback: full UTC date + time, unambiguous. */
  const utcFallback = `${iso.slice(0, 16).replace("T", " ")} UTC`;
  return (
    <time datetime={iso} data-bm-time="" title={iso} class={className} safe>
      {utcFallback}
    </time>
  );
}
