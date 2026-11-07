import { TimeDisplay } from "../components/time-display.tsx";
import {
  PREVIOUS_DKIM_SELECTOR_ADVICE,
  dkimRecordHost,
} from "../../modules/domains/services/dkim-keys.ts";
import type { Domain } from "../../modules/domains/types/domain.types.ts";

/** Classes of a small action button in the DKIM key panel. */
const PANEL_BUTTON =
  "px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-700 text-gray-900 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors whitespace-nowrap";

/**
 * The DKIM key and its rotation (#250): the active selector, a pending
 * rotation with Complete and Cancel, or a button to start one, and the
 * previous selector with what to do with its record. Each button asks
 * for confirmation; the routes are admin-only.
 */
export function DkimKeyPanel({ domain }: { domain: Domain }) {
  const pending = domain.dkimPendingSelector;
  const previous = domain.dkimPreviousSelector;
  return (
    <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-5 mb-6">
      <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
        DKIM Key
      </h2>
      <p class="text-sm text-gray-700 dark:text-gray-300 mb-4">
        Mail is signed with selector{" "}
        <code class="font-mono" safe>
          {domain.dkimSelector}
        </code>
        {domain.dkimRotatedAt != null && (
          <span>
            {" "}
            since <TimeDisplay value={domain.dkimRotatedAt} />
          </span>
        )}
        .
      </p>

      {pending == null ? (
        <div class="flex flex-col sm:flex-row sm:items-center gap-3">
          <p class="text-sm text-gray-500 dark:text-gray-400 flex-1">
            Rotating creates a new key under a dated selector. Mail stays signed with the
            current key until you publish the new record and complete the rotation.
          </p>
          <form method="POST" action={`/dashboard/domains/${domain.id}/dkim/rotate`}>
            <button
              type="submit"
              class={PANEL_BUTTON}
              data-confirm="Start a DKIM key rotation? A new key is created; mail stays signed with the current key until you complete the rotation."
            >
              Rotate DKIM key
            </button>
          </form>
        </div>
      ) : (
        <div class="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950 p-4">
          <p class="text-sm text-amber-900 dark:text-amber-200 mb-1">
            Rotation pending: selector{" "}
            <code class="font-mono" safe>
              {pending}
            </code>
            {domain.dkimPendingCreatedAt != null && (
              <span>
                , started <TimeDisplay value={domain.dkimPendingCreatedAt} />
              </span>
            )}
            .
          </p>
          <p class="text-sm text-amber-900 dark:text-amber-200 mb-3">
            Publish the TXT record at{" "}
            <code class="font-mono break-all" safe>
              {dkimRecordHost(pending, domain.name)}
            </code>{" "}
            (listed under Required DNS Records as pending), wait for it to resolve, then
            complete the rotation. Completing checks the record first.
          </p>
          <div class="flex flex-wrap gap-3">
            <form
              method="POST"
              action={`/dashboard/domains/${domain.id}/dkim/rotate/complete`}
            >
              <button
                type="submit"
                class={PANEL_BUTTON}
                data-confirm="Switch to the new DKIM key? Mail is signed with it from now on."
              >
                Complete rotation
              </button>
            </form>
            <form
              method="POST"
              action={`/dashboard/domains/${domain.id}/dkim/rotate/cancel`}
            >
              <button
                type="submit"
                class={PANEL_BUTTON}
                data-confirm="Cancel the DKIM key rotation? The pending key is discarded."
              >
                Cancel rotation
              </button>
            </form>
          </div>
        </div>
      )}

      {previous != null && (
        <p class="text-sm text-gray-500 dark:text-gray-400 mt-4">
          Previous selector{" "}
          <code class="font-mono" safe>
            {previous}
          </code>{" "}
          (
          <code class="font-mono break-all" safe>
            {dkimRecordHost(previous, domain.name)}
          </code>
          ), no longer used to sign. <span>{PREVIOUS_DKIM_SELECTOR_ADVICE}</span>
        </p>
      )}
    </div>
  );
}
