import { BaseLayout } from "../layouts/base.tsx";
import { FlashMessage } from "../components/flash-message.tsx";
import { TimeDisplay } from "../components/time-display.tsx";
import { SETUP_PASSWORD_MAX_LENGTH } from "../../modules/users/services/owner-setup-policy.service.ts";
import type { SsoLinkSummary } from "../../modules/users/types/sso.types.ts";
import { INPUT_CLASS } from "./setup.tsx";

/**
 * One row of the Sign-in methods page: a configured provider (linked or
 * not), or a link whose provider is no longer configured.
 */
export interface SsoMethodRow {
  /** The provider's id in `SSO_PROVIDERS`; `null` for a link whose provider is gone. */
  providerId: string | null;
  /** The provider's label (`SSO_<ID>_LABEL`), or the issuer's host. Rendered escaped. */
  label: string;
  /** The account's link at this provider, if any. */
  link: SsoLinkSummary | null;
}

/** Why the page offers no "Link" button at all. */
export type SsoPageNotice =
  "none" | "not_configured" | "off" | "owner_needs_second_factor";

/** Props for the Sign-in methods page (#224). */
interface AccountSsoPageProps {
  /** One row per configured provider, then the links of providers no longer configured. */
  rows: SsoMethodRow[];
  /** What keeps linking from being offered, if anything. */
  notice: SsoPageNotice;
  /** Optional banner after an action. */
  flash?: { message: string; type: "success" | "error" };
}

/** A small secondary button. */
const SMALL_BUTTON =
  "px-3 py-1.5 border border-gray-300 dark:border-gray-700 text-xs font-medium rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors";

/** A small destructive button. */
const SMALL_DANGER_BUTTON =
  "px-3 py-1.5 bg-red-600 text-white text-xs font-medium rounded-lg hover:bg-red-700 transition-colors";

/** A card around one section. */
const CARD_CLASS =
  "max-w-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-6 mb-6";

/** An amber note above the card. */
const NOTE_CLASS =
  "max-w-2xl bg-amber-50 text-amber-900 border border-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-800 rounded-lg px-4 py-3 text-sm mb-6";

/** What each notice says: static text. */
const NOTICE_TEXT: Record<Exclude<SsoPageNotice, "none">, string> = {
  not_configured: "Single sign-on is not set up on this server.",
  off: "Single sign-on is switched off on this server: an administrator must set APP_BASE_URL to the dashboard's https:// address first.",
  owner_needs_second_factor:
    "As the owner, you can link a single sign-on account only while you have a second factor. Set up an authenticator app on the Two-factor page or add a passkey first.",
};

/** The current password field (re-authentication), compact, never refilled. */
function PasswordInput({ id }: { id: string }) {
  return (
    <>
      <label for={id} class="sr-only">
        Current password
      </label>
      <input
        type="password"
        id={id}
        name="password"
        required
        autocomplete="current-password"
        maxlength={String(SETUP_PASSWORD_MAX_LENGTH)}
        placeholder="Current password"
        class={`${INPUT_CLASS} text-xs`}
      />
    </>
  );
}

/** One provider: its link with the unlink form, or the link form. */
function MethodRow({ row, canLink }: { row: SsoMethodRow; canLink: boolean }) {
  const { link } = row;
  return (
    <li class="py-4 border-b border-gray-200 dark:border-gray-800 last:border-b-0">
      <p class="text-sm font-medium text-gray-900 dark:text-gray-100 break-all" safe>
        {row.label}
      </p>
      {link === null ? (
        <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5 mb-3">Not linked.</p>
      ) : (
        <>
          {link.name !== null && (
            <p class="text-xs text-gray-700 dark:text-gray-300 mt-0.5 break-all" safe>
              {link.name}
            </p>
          )}
          <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5 mb-3">
            Linked <TimeDisplay value={link.createdAt} />. Last used{" "}
            <TimeDisplay value={link.lastUsedAt} fallback="never" />.
          </p>
        </>
      )}
      {link !== null && (
        <form
          method="POST"
          action={`/dashboard/account/sso/${encodeURIComponent(link.id)}/unlink`}
          class="flex gap-2 items-center"
          data-confirm="Unlink this account? It will no longer sign in, and the sessions opened with it are signed out."
        >
          <PasswordInput id={`unlink-password-${link.id}`} />
          <button type="submit" class={SMALL_DANGER_BUTTON}>
            Unlink
          </button>
        </form>
      )}
      {link === null && canLink && row.providerId !== null && (
        <form
          method="POST"
          action={`/dashboard/account/sso/${encodeURIComponent(row.providerId)}/link`}
          class="flex gap-2 items-center"
        >
          <PasswordInput id={`link-password-${row.providerId}`} />
          <button type="submit" class={SMALL_BUTTON}>
            Link
          </button>
        </form>
      )}
    </li>
  );
}

/**
 * Sign-in methods page (#224, every role): the account's single sign-on
 * links, one row per configured provider (linked: the provider email at
 * link time, when linked and last used, and an Unlink form; not linked: a
 * Link form), then any link whose provider is no longer configured (Unlink
 * only). Linking and unlinking need the current password; linking then
 * sends the browser to the provider. Every stored and configured value is
 * escaped.
 */
export function AccountSsoPage({ rows, notice, flash }: AccountSsoPageProps) {
  return (
    <BaseLayout title="Sign-in methods" activeNav="account-sso">
      <h1 class="text-xl font-semibold mb-6">Sign-in methods</h1>

      {flash != null && <FlashMessage message={flash.message} type={flash.type} />}

      {notice !== "none" && (
        <div class={NOTE_CLASS} safe>
          {NOTICE_TEXT[notice]}
        </div>
      )}

      <div class={CARD_CLASS}>
        <p class="text-sm text-gray-600 dark:text-gray-400">
          Link an account at your organization's identity provider to sign in with it.
          Your password keeps working, and your BunMail second factor, if you have one, is
          still asked after the provider. Linking and unlinking need your current
          password.
        </p>
        {rows.length === 0 ? (
          <p class="text-sm text-gray-500 dark:text-gray-400 mt-4">
            No single sign-on providers.
          </p>
        ) : (
          <ul class="mt-2">
            {rows.map((row) => (
              <MethodRow row={row} canLink={notice === "none"} />
            ))}
          </ul>
        )}
      </div>
    </BaseLayout>
  );
}
