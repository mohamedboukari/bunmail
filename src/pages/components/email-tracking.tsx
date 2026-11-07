import type { Email } from "../../modules/emails/types/email.types.ts";
import type { EmailEvent } from "../../modules/emails/services/email-events.service.ts";

/**
 * Open and click tracking in the dashboard (#187): the Opened / Clicked
 * badges of the emails list and the timeline of the email page. Every
 * value from the database is rendered with `safe` (a click URL is the
 * sender's, and so attacker-chosen as far as the dashboard is concerned).
 */

const BADGE = "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium";

/** "Opened" and "Clicked" pills from the email's first open and click; nothing when neither. */
export function EngagementBadges({
  email,
}: {
  email: Pick<Email, "firstOpenedAt" | "firstClickedAt">;
}) {
  if (email.firstOpenedAt === null && email.firstClickedAt === null) return <></>;
  return (
    <span class="inline-flex gap-1 ml-1">
      {email.firstOpenedAt !== null && (
        <span class={`${BADGE} bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300`}>
          Opened
        </span>
      )}
      {email.firstClickedAt !== null && (
        <span
          class={`${BADGE} bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300`}
        >
          Clicked
        </span>
      )}
    </span>
  );
}

/** A timestamp in UTC, `YYYY-MM-DD HH:MM:SS UTC`: the timeline stays in UTC on purpose. */
function utc(value: Date): string {
  return `${value.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/**
 * The "Opens and clicks" timeline: every recorded event, oldest first,
 * with the reliability caveat. Shown when the email is tracked or has
 * events; nothing otherwise.
 */
export function TrackingTimeline({
  email,
  events,
}: {
  email: Pick<Email, "trackOpens" | "trackClicks">;
  events: readonly EmailEvent[];
}) {
  if (!email.trackOpens && !email.trackClicks && events.length === 0) return <></>;
  const tracked = [email.trackOpens ? "opens" : null, email.trackClicks ? "clicks" : null]
    .filter((kind) => kind !== null)
    .join(" and ");
  return (
    <div class="mb-6">
      <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">
        Opens and clicks
      </h2>
      <p class="text-xs text-gray-500 dark:text-gray-400 mb-2">
        {tracked === "" ? "Not tracked." : <span safe>{`Tracks ${tracked}.`}</span>} These
        numbers are unreliable: Apple Mail Privacy Protection fetches every image at
        delivery, mail proxies cache images, other clients block them, and link scanners
        click links. Events marked likely automated are a guess.
      </p>
      {events.length === 0 ? (
        <p class="text-sm text-gray-500 dark:text-gray-400">
          No opens or clicks recorded.
        </p>
      ) : (
        <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-800">
                <th class="px-4 py-2 font-medium">Time (UTC)</th>
                <th class="px-4 py-2 font-medium">Type</th>
                <th class="px-4 py-2 font-medium">Link</th>
                <th class="px-4 py-2 font-medium">Client</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr class="border-b last:border-b-0 border-gray-100 dark:border-gray-800 align-top">
                  <td class="px-4 py-2 whitespace-nowrap">
                    <time datetime={event.occurredAt.toISOString()} safe>
                      {utc(event.occurredAt)}
                    </time>
                  </td>
                  <td class="px-4 py-2">{event.type === "click" ? "Click" : "Open"}</td>
                  <td class="px-4 py-2 break-all text-gray-700 dark:text-gray-300" safe>
                    {event.url ?? ""}
                  </td>
                  <td class="px-4 py-2 whitespace-nowrap">
                    <span>
                      {event.clientKind === "image_proxy" ? "Image proxy" : "Unknown"}
                    </span>
                    {event.machine && (
                      <span
                        class={`${BADGE} ml-1 bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300`}
                      >
                        Likely automated
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
