import { BaseLayout } from "../layouts/base.tsx";
import { FlashMessage } from "../components/flash-message.tsx";
import { PasskeyCeremony } from "../components/passkey-ceremony.tsx";
import { TimeDisplay } from "../components/time-display.tsx";
import { SETUP_PASSWORD_MAX_LENGTH } from "../../modules/users/services/owner-setup-policy.service.ts";
import { PASSKEY_NAME_MAX_LENGTH } from "../../modules/users/services/passkey-policy.service.ts";
import type { PasskeySummary } from "../../modules/users/types/user.types.ts";
import { INPUT_CLASS, LABEL_CLASS } from "./setup.tsx";

/** Props for the Passkeys page (#223). */
interface AccountPasskeysPageProps {
  /** The signed-in user's passkeys, oldest first. */
  passkeys: PasskeySummary[];
  /** False when `APP_BASE_URL` is unset or unusable: passkeys are off. */
  enabled: boolean;
  /** True when `REQUIRE_2FA` covers this account and it has no second factor yet. */
  required: boolean;
  /** Optional banner after an action. */
  flash?: { message: string; type: "success" | "error" };
}

/** The primary button style. */
const PRIMARY_BUTTON =
  "px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium rounded-lg hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors";

/** A small secondary button. */
const SMALL_BUTTON =
  "px-3 py-1.5 border border-gray-300 dark:border-gray-700 text-xs font-medium rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors";

/** A small destructive button. */
const SMALL_DANGER_BUTTON =
  "px-3 py-1.5 bg-red-600 text-white text-xs font-medium rounded-lg hover:bg-red-700 transition-colors";

/** A card around one section. */
const CARD_CLASS =
  "max-w-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-6 mb-6";

/** The current password field (re-authentication, #220 pattern). Never refilled. */
function PasswordInput({ id, compact }: { id: string; compact?: boolean }) {
  return (
    <>
      <label for={id} class={compact ? "sr-only" : LABEL_CLASS}>
        Current password
      </label>
      <input
        type="password"
        id={id}
        name="password"
        required
        autocomplete="current-password"
        maxlength={String(SETUP_PASSWORD_MAX_LENGTH)}
        placeholder={compact ? "Current password" : undefined}
        class={compact ? `${INPUT_CLASS} text-xs` : `${INPUT_CLASS} mb-4`}
      />
    </>
  );
}

/** One passkey: its name, dates, and the rename and remove forms. */
function PasskeyRow({ passkey }: { passkey: PasskeySummary }) {
  return (
    <li class="py-4 border-b border-gray-200 dark:border-gray-800 last:border-b-0">
      <p class="text-sm font-medium text-gray-900 dark:text-gray-100 break-all" safe>
        {passkey.name}
      </p>
      <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5 mb-3">
        Added <TimeDisplay value={passkey.createdAt} />. Last used{" "}
        <TimeDisplay value={passkey.lastUsedAt} fallback="never" />.
      </p>
      <div class="flex flex-col sm:flex-row gap-3">
        <form
          method="POST"
          action={`/dashboard/account/passkeys/${passkey.id}/rename`}
          class="flex gap-2 items-center"
        >
          <label for={`rename-${passkey.id}`} class="sr-only">
            New name
          </label>
          <input
            type="text"
            id={`rename-${passkey.id}`}
            name="name"
            required
            maxlength={String(PASSKEY_NAME_MAX_LENGTH)}
            value={passkey.name}
            class={`${INPUT_CLASS} text-xs`}
          />
          <button type="submit" class={SMALL_BUTTON}>
            Rename
          </button>
        </form>
        <form
          method="POST"
          action={`/dashboard/account/passkeys/${passkey.id}/delete`}
          class="flex gap-2 items-center"
          data-confirm="Remove this passkey? It will no longer sign in, and the sessions opened with it are signed out."
        >
          <PasswordInput id={`delete-password-${passkey.id}`} compact />
          <button type="submit" class={SMALL_DANGER_BUTTON}>
            Remove
          </button>
        </form>
      </div>
    </li>
  );
}

/**
 * Passkeys page (#223, every role): the signed-in user's passkeys (name,
 * added, last used), each renameable and removable (removing needs the
 * current password), and a form to add one: a name and the current
 * password, then the browser's passkey prompt (`dashboard.js`, bound by
 * `data-passkey-*`). A passkey signs in on its own (passwordless) and is
 * a second factor after the password. Off, with a note, when
 * `APP_BASE_URL` is unset. Every stored value is escaped.
 */
export function AccountPasskeysPage({
  passkeys,
  enabled,
  required,
  flash,
}: AccountPasskeysPageProps) {
  return (
    <BaseLayout title="Passkeys" activeNav="account-passkeys">
      <h1 class="text-xl font-semibold mb-6">Passkeys</h1>

      {flash != null && <FlashMessage message={flash.message} type={flash.type} />}

      {required && (
        <div class="max-w-2xl bg-amber-50 text-amber-900 border border-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-800 rounded-lg px-4 py-3 text-sm mb-6">
          Your role requires a second factor. Add a passkey, or set up an authenticator
          app on the Two-factor page, to continue using the dashboard.
        </div>
      )}

      {!enabled && (
        <div class="max-w-2xl bg-amber-50 text-amber-900 border border-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-800 rounded-lg px-4 py-3 text-sm mb-6">
          Passkeys are switched off on this server: an administrator must set APP_BASE_URL
          to the dashboard's https:// address first.
        </div>
      )}

      <div class={CARD_CLASS}>
        <p class="text-sm text-gray-600 dark:text-gray-400">
          A passkey signs you in with your device's screen lock or a security key, without
          the password, and cannot be phished. After a password sign-in it also works as
          the second factor.
        </p>
        {passkeys.length === 0 ? (
          <p class="text-sm text-gray-500 dark:text-gray-400 mt-4">No passkeys yet.</p>
        ) : (
          <ul class="mt-2">
            {passkeys.map((passkey) => (
              <PasskeyRow passkey={passkey} />
            ))}
          </ul>
        )}
      </div>

      {enabled && (
        <div class={CARD_CLASS}>
          <h2 class="text-base font-semibold mb-2">Add a passkey</h2>
          <PasskeyCeremony
            mode="create"
            optionsUrl="/dashboard/account/passkeys/options"
            finishUrl="/dashboard/account/passkeys"
          >
            <form data-passkey-start>
              <label for="passkey-name" class={LABEL_CLASS}>
                Name
              </label>
              <input
                type="text"
                id="passkey-name"
                name="name"
                required
                maxlength={String(PASSKEY_NAME_MAX_LENGTH)}
                placeholder="For example: MacBook, YubiKey"
                class={`${INPUT_CLASS} mb-4`}
              />
              <PasswordInput id="add-password" />
              {passkeys.length === 0 && (
                <p class="text-xs text-gray-500 dark:text-gray-400 mb-4">
                  If this is your first second factor, adding it signs you out on every
                  other device and browser.
                </p>
              )}
              <button type="submit" class={PRIMARY_BUTTON}>
                Add a passkey
              </button>
            </form>
          </PasskeyCeremony>
        </div>
      )}
    </BaseLayout>
  );
}
