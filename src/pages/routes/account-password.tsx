import { BaseLayout } from "../layouts/base.tsx";
import { FlashMessage } from "../components/flash-message.tsx";
import {
  SETUP_PASSWORD_MAX_LENGTH,
  SETUP_PASSWORD_MIN_LENGTH,
} from "../../modules/users/services/owner-setup-policy.service.ts";
import { INPUT_CLASS, LABEL_CLASS } from "./setup.tsx";

/** Props for the Change password page (#279). */
interface AccountPasswordPageProps {
  /** The signed-in account's stored email, shown so the user knows which account. */
  email: string;
  /** Optional banner: the success flash after a change, or a refusal message. */
  flash?: { message: string; type: "success" | "error" };
}

/**
 * Change password page (#279, every role): the signed-in user's current
 * password, a new one and its confirmation, posted to the fixed
 * `/dashboard/account/password`. The fields are never refilled after a
 * refusal: no password is ever written into a page. Every dynamic value
 * is escaped.
 */
export function AccountPasswordPage({ email, flash }: AccountPasswordPageProps) {
  return (
    <BaseLayout title="Change password" activeNav="account">
      <h1 class="text-xl font-semibold mb-6">Change password</h1>

      {flash != null && <FlashMessage message={flash.message} type={flash.type} />}

      <div class="max-w-md bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-6">
        <p class="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Account:{" "}
          <span class="font-medium text-gray-900 dark:text-gray-100" safe>
            {email}
          </span>
        </p>

        <form method="POST" action="/dashboard/account/password">
          <label for="current" class={LABEL_CLASS}>
            Current password
          </label>
          <input
            type="password"
            id="current"
            name="current"
            required
            autocomplete="current-password"
            maxlength={String(SETUP_PASSWORD_MAX_LENGTH)}
            class={`${INPUT_CLASS} mb-4`}
          />

          <label for="password" class={LABEL_CLASS}>
            New password
          </label>
          <input
            type="password"
            id="password"
            name="password"
            required
            autocomplete="new-password"
            minlength={String(SETUP_PASSWORD_MIN_LENGTH)}
            maxlength={String(SETUP_PASSWORD_MAX_LENGTH)}
            class={INPUT_CLASS}
          />
          {/* A numeric constant: nothing to escape. */}
          <p class="text-xs text-gray-500 dark:text-gray-400 mt-1.5 mb-4">
            At least {SETUP_PASSWORD_MIN_LENGTH} characters, different from the current
            one. A passphrase works well.
          </p>

          <label for="confirm" class={LABEL_CLASS}>
            Confirm new password
          </label>
          <input
            type="password"
            id="confirm"
            name="confirm"
            required
            autocomplete="new-password"
            minlength={String(SETUP_PASSWORD_MIN_LENGTH)}
            maxlength={String(SETUP_PASSWORD_MAX_LENGTH)}
            class={INPUT_CLASS}
          />

          <p class="text-xs text-gray-500 dark:text-gray-400 mt-3">
            You stay signed in here; every other device and browser is signed out.
          </p>

          <button
            type="submit"
            class="w-full mt-4 px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium rounded-lg hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors"
          >
            Change password
          </button>
        </form>
      </div>
    </BaseLayout>
  );
}
