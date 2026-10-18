import { BaseLayout } from "../layouts/base.tsx";
import { FlashMessage } from "../components/flash-message.tsx";
import { EmptyState } from "../components/empty-state.tsx";
import { TimeDisplay } from "../components/time-display.tsx";
import { describeUserAgent } from "../../modules/users/services/user-agent.service.ts";
import type { UserSessionSummary } from "../../modules/users/types/user.types.ts";

/** Props for the Active sessions page (#281). */
interface AccountSessionsPageProps {
  /** The signed-in user's live sessions, most recently active first. */
  sessions: UserSessionSummary[];
  /** The session of this request: marked "This device". */
  currentSessionId: string;
  /** Optional banner after an action. */
  flash?: { message: string; type: "success" | "error" };
}

/** Shared table header cell styling. */
const TH_CLASS = "text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400";

/** Small destructive text button. */
const DANGER_BUTTON =
  "text-xs font-medium text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300";

/**
 * Active sessions page (#281, every role): one row per live session of
 * the signed-in user, with the device (browser and system from the user
 * agent), IP, approximate location (only when GeoIP stored one), signed
 * in at and last active, and "This device" on the current one. Each row
 * signs that session out; one button signs out every other session.
 * Only the user's own sessions: other users' sessions are managed on the
 * Users page. Every stored value is escaped.
 */
export function AccountSessionsPage({
  sessions,
  currentSessionId,
  flash,
}: AccountSessionsPageProps) {
  /** The location column only appears when some session has one. */
  const showLocation = sessions.some((session) => session.location !== null);
  const others = sessions.filter((session) => session.id !== currentSessionId).length;

  return (
    <BaseLayout title="Active sessions" activeNav="account-sessions">
      <h1 class="text-xl font-semibold mb-6">Active sessions</h1>

      {flash != null && <FlashMessage message={flash.message} type={flash.type} />}

      <p class="text-xs text-gray-500 dark:text-gray-400 mb-4">
        Every device and browser signed in to your account. Sign out any you do not
        recognize, then change your password.
        {showLocation &&
          " Locations are approximate, from the IP address: a VPN or proxy shows its own location."}
      </p>

      {sessions.length === 0 ? (
        <EmptyState message="No active sessions." />
      ) : (
        <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-gray-200 dark:border-gray-800">
                <th class={TH_CLASS}>Device</th>
                <th class={TH_CLASS}>IP address</th>
                {showLocation && <th class={TH_CLASS}>Approximate location</th>}
                <th class={TH_CLASS}>Signed in</th>
                <th class={TH_CLASS}>Last active</th>
                <th class={TH_CLASS}>Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
              {sessions.map((session) => {
                const isCurrent = session.id === currentSessionId;
                return (
                  <tr class="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors align-top">
                    <td class="px-4 py-3 font-medium text-gray-900 dark:text-gray-100">
                      <span safe>{describeUserAgent(session.userAgent)}</span>
                      {isCurrent && (
                        <span class="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                          This device
                        </span>
                      )}
                    </td>
                    <td class="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-300">
                      <span safe>{session.ip ?? "Unknown"}</span>
                    </td>
                    {showLocation && (
                      <td class="px-4 py-3 text-gray-600 dark:text-gray-300">
                        <span safe>{session.location ?? "Unknown"}</span>
                      </td>
                    )}
                    <td class="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                      <TimeDisplay value={session.createdAt} />
                    </td>
                    <td class="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                      <TimeDisplay value={session.lastSeenAt} />
                    </td>
                    <td class="px-4 py-3">
                      <form
                        method="POST"
                        action={`/dashboard/account/sessions/${encodeURIComponent(session.id)}/revoke`}
                      >
                        <button
                          type="submit"
                          class={DANGER_BUTTON}
                          data-confirm={
                            isCurrent
                              ? "Sign out of this device? You will need to sign in again."
                              : "Sign out this device? It will need to sign in again."
                          }
                        >
                          {isCurrent ? "Sign out here" : "Sign out"}
                        </button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {others > 0 && (
        <form
          method="POST"
          action="/dashboard/account/sessions/revoke-others"
          class="mt-4"
        >
          <button
            type="submit"
            class="px-4 py-2 border border-red-300 dark:border-red-800 text-red-700 dark:text-red-300 text-sm font-medium rounded-lg hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
            data-confirm="Sign out every other device? Only this browser stays signed in."
          >
            Sign out all other devices
          </button>
        </form>
      )}
    </BaseLayout>
  );
}
