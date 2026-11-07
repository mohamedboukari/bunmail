import type { Domain } from "../../modules/domains/types/domain.types.ts";

/**
 * The domain's open and click tracking opt-in (#187): two checkboxes,
 * saved by `POST /dashboard/domains/:id/tracking` (admins only). Says
 * when `TRACKING_ENABLED` keeps everything off, and that open counts are
 * unreliable.
 */
export function TrackingPanel({
  domain,
  trackingEnabled,
}: {
  domain: Pick<Domain, "id" | "trackOpens" | "trackClicks">;
  /** `TRACKING_ENABLED`: off, nothing is tracked whatever is ticked here. */
  trackingEnabled: boolean;
}) {
  return (
    <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-5 mb-6">
      <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
        Open and Click Tracking
      </h2>
      <p class="text-sm text-gray-500 dark:text-gray-400 mb-2">
        Off by default. Applies to mail queued after you save, with exactly one recipient;
        transactional mail is tracked only when the send asks, and any send can opt out.
        Tracking is personal data: tell your recipients.
      </p>
      <p class="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Open counts are unreliable: Apple Mail fetches every image on delivery, other
        clients block images, and link scanners click links.
      </p>
      {!trackingEnabled && (
        <p class="text-sm text-amber-700 dark:text-amber-400 mb-4">
          TRACKING_ENABLED is off on this server, so nothing is tracked whatever is ticked
          here.
        </p>
      )}
      <form
        method="POST"
        action={`/dashboard/domains/${domain.id}/tracking`}
        class="flex flex-col gap-3"
      >
        <label class="inline-flex items-center gap-2 text-sm text-gray-900 dark:text-gray-100">
          <input
            type="checkbox"
            name="trackOpens"
            value="true"
            checked={domain.trackOpens}
          />
          Track opens (a 1x1 image)
        </label>
        <label class="inline-flex items-center gap-2 text-sm text-gray-900 dark:text-gray-100">
          <input
            type="checkbox"
            name="trackClicks"
            value="true"
            checked={domain.trackClicks}
          />
          Track clicks (links go through this server)
        </label>
        <button
          type="submit"
          class="self-start px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium rounded-lg hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors whitespace-nowrap"
        >
          Save
        </button>
      </form>
    </div>
  );
}
