import { BaseLayout } from "../layouts/base.tsx";
import { FlashMessage } from "../components/flash-message.tsx";
import { EmptyState } from "../components/empty-state.tsx";
import { TimeDisplay } from "../components/time-display.tsx";
import { EmailChipInput, EmailChipInputScript } from "../components/email-chip-input.tsx";
import { creatorLabel, type CreatorNames } from "../components/created-by.tsx";
import type {
  ApiKey,
  ApiKeyDisabledReason,
} from "../../modules/api-keys/types/api-key.types.ts";

/**
 * Props for the API keys list page.
 */
interface ApiKeysPageProps {
  /** The keys the viewer may see (#219): all of them, or a member's own (active + revoked) */
  keys: ApiKey[];
  /** Display names of accounts, for the "Created by" column (#219). */
  creators: CreatorNames;
  /**
   * Active admins and the owner (#219): only their keys (and keys with no
   * creator, the owner's) get a "Make admin" button. The server refuses
   * any other promotion anyway.
   */
  adminCreatorIds: ReadonlySet<string>;
  /**
   * The viewer is an admin or the owner (#219): sees every key, the
   * "Created by" column, the admin checkbox and the admin toggle. A
   * member gets none of them (the server ignores or refuses them anyway).
   */
  canManageAll: boolean;
  /** Optional flash message (e.g. after creating or revoking a key) */
  flash?: { message: string; type: "success" | "error" };
  /** If a key was just created, show the raw key once */
  rawKey?: string;
}

/** Status badge text of an inactive key, by why it is inactive (#219). */
const DISABLED_LABEL: Record<ApiKeyDisabledReason, string> = {
  revoked: "Revoked",
  creator_deactivated: "Disabled: creator deactivated",
  creator_removed: "Disabled: creator removed",
};

/**
 * Status badge text of an inactive key. No stored reason means a key
 * revoked before reasons were recorded; an unknown value (unreachable
 * while the check constraint holds) reads as disabled.
 */
function disabledLabel(reason: string | null): string {
  if (reason === null) return DISABLED_LABEL.revoked;
  const known = Object.entries(DISABLED_LABEL).find(([value]) => value === reason);
  return known ? known[1] : "Disabled";
}

/**
 * "Created by" label of a key (#219). A removed user's keys lose their
 * creator (it becomes the owner), so they are named by their reason.
 */
function keyCreatorLabel(key: ApiKey, creators: CreatorNames): string {
  if (key.disabledReason === "creator_removed") return "Removed account";
  return creatorLabel(key.createdByUserId, creators);
}

/**
 * Whether a key may be promoted to admin (#219): no creator (the owner's)
 * or a creator who is an active admin or the owner.
 */
function mayHoldAdmin(key: ApiKey, adminCreatorIds: ReadonlySet<string>): boolean {
  return key.createdByUserId === null || adminCreatorIds.has(key.createdByUserId);
}

/**
 * API Keys page: shows a create form and table of API keys (#219: every
 * key for admins and the owner, a member's own keys for a member).
 * After creating a key, the raw key is displayed in a flash message (shown once).
 */
export function ApiKeysPage({
  keys,
  creators,
  adminCreatorIds,
  canManageAll,
  flash,
  rawKey,
}: ApiKeysPageProps) {
  return (
    <BaseLayout title="API Keys" activeNav="api-keys">
      <h1 class="text-xl font-semibold mb-2">API Keys</h1>
      <p class="text-sm text-gray-500 dark:text-gray-400 mb-6">
        {canManageAll
          ? "Every key on this server. Keys belong to the account that created them; deactivating or removing an account disables its keys."
          : "The keys you created. Your keys are restricted (send-only); ask an admin for an admin key."}
      </p>

      {/* Flash message */}
      {flash != null && <FlashMessage message={flash.message} type={flash.type} />}

      {/* Raw key shown once after creation */}
      {!!rawKey && (
        <div class="bg-emerald-50 text-emerald-800 border border-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:border-emerald-800 rounded-lg px-4 py-3 text-sm mb-4">
          <p class="font-medium mb-1">
            API key created: copy it now, it won't be shown again:
          </p>
          <code
            class="block bg-emerald-100 dark:bg-emerald-900 px-3 py-2 rounded font-mono text-xs break-all select-all"
            safe
          >
            {rawKey}
          </code>
        </div>
      )}

      {/* Create API key form */}
      <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4 mb-6">
        <form method="POST" action="/dashboard/api-keys" class="space-y-3">
          <input
            type="text"
            name="name"
            required
            placeholder="Key name (e.g. Production)"
            class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500 focus:border-transparent"
          />
          <div>
            <label
              for="allowedSenders"
              class="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-1"
            >
              Allowed senders (optional)
            </label>
            <EmailChipInput
              name="allowedSenders"
              id="allowedSenders"
              placeholder="noreply@yourdomain.com"
            />
            <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Leave empty to let this key send from any registered domain. When set, the
              key can only send <strong>From</strong> these exact addresses: this stops it
              from spoofing other identities (e.g. your CEO).
            </p>
          </div>
          {canManageAll && (
            <label class="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                name="isAdmin"
                class="mt-0.5 h-4 w-4 rounded border-gray-300 dark:border-gray-600"
              />
              <span class="text-sm text-gray-700 dark:text-gray-300">
                Admin key
                <span class="block text-xs text-gray-500 dark:text-gray-400">
                  Can manage keys, domains, and read inbound mail. Leave unchecked for a
                  restricted <strong>send-only</strong> key (recommended for keys you hand
                  to apps or developers).
                </span>
              </span>
            </label>
          )}
          <button
            type="submit"
            class="px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium rounded-lg hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors whitespace-nowrap"
          >
            Create Key
          </button>
        </form>
      </div>

      {keys.length === 0 ? (
        <EmptyState message="No API keys yet. Create one above to get started." />
      ) : (
        /* API keys table */
        <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-gray-200 dark:border-gray-800">
                <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  Name
                </th>
                <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  Prefix
                </th>
                <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  Status
                </th>
                <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  Access
                </th>
                {canManageAll && (
                  <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                    Created by
                  </th>
                )}
                <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  Last Used
                </th>
                <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  Created
                </th>
                <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  Allowed senders
                </th>
                <th class="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
              {keys.map((key) => (
                <tr class="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                  <td class="px-4 py-3 font-medium text-gray-900 dark:text-gray-100" safe>
                    {key.name}
                  </td>
                  <td
                    class="px-4 py-3 font-mono text-xs text-gray-500 dark:text-gray-400"
                    safe
                  >
                    {key.keyPrefix}...
                  </td>
                  <td class="px-4 py-3">
                    {key.isActive ? (
                      <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                        Active
                      </span>
                    ) : (
                      <span
                        class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"
                        safe
                      >
                        {disabledLabel(key.disabledReason)}
                      </span>
                    )}
                  </td>
                  {/* Access: Admin vs Restricted + a promote/demote toggle (#130) */}
                  <td class="px-4 py-3">
                    <div class="flex items-center gap-2">
                      {key.isAdmin ? (
                        <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                          Admin
                        </span>
                      ) : (
                        <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300">
                          Restricted
                        </span>
                      )}
                      {canManageAll &&
                        key.isActive &&
                        (key.isAdmin || mayHoldAdmin(key, adminCreatorIds)) && (
                          <form
                            method="POST"
                            action={`/dashboard/api-keys/${key.id}/admin`}
                            class="inline"
                          >
                            <input
                              type="hidden"
                              name="isAdmin"
                              value={key.isAdmin ? "false" : "true"}
                            />
                            <button
                              type="submit"
                              class="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 underline"
                            >
                              {key.isAdmin ? "Make restricted" : "Make admin"}
                            </button>
                          </form>
                        )}
                    </div>
                  </td>
                  {canManageAll && (
                    <td
                      class="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap"
                      safe
                    >
                      {keyCreatorLabel(key, creators)}
                    </td>
                  )}
                  <td class="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    <TimeDisplay value={key.lastUsedAt} fallback="Never" />
                  </td>
                  <td class="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    <TimeDisplay value={key.createdAt} />
                  </td>
                  <td class="px-4 py-3 min-w-[240px]">
                    {key.isActive ? (
                      <form
                        method="POST"
                        action={`/dashboard/api-keys/${key.id}/senders`}
                        class="flex flex-col gap-1.5"
                      >
                        <EmailChipInput
                          name="allowedSenders"
                          initial={key.allowedSenders}
                          placeholder="Any registered domain"
                        />
                        <button
                          type="submit"
                          class="self-start text-xs text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 font-medium"
                        >
                          Save senders
                        </button>
                      </form>
                    ) : key.allowedSenders.length > 0 ? (
                      <span class="text-xs text-gray-500 dark:text-gray-400" safe>
                        {key.allowedSenders.join(", ")}
                      </span>
                    ) : (
                      <span class="text-xs text-gray-400 dark:text-gray-500">Any</span>
                    )}
                  </td>
                  <td class="px-4 py-3">
                    {key.isActive && (
                      <form method="POST" action={`/dashboard/api-keys/${key.id}/revoke`}>
                        <button
                          type="submit"
                          class="text-xs text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 font-medium"
                          onclick="return confirm('Are you sure you want to revoke this key?')"
                        >
                          Revoke
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Wires up the create-form + per-row allowed-senders chip inputs. */}
      <EmailChipInputScript />
    </BaseLayout>
  );
}
