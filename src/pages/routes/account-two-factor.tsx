import { BaseLayout } from "../layouts/base.tsx";
import { FlashMessage } from "../components/flash-message.tsx";
import { QrCode } from "../components/qr-code.tsx";
import { TimeDisplay } from "../components/time-display.tsx";
import { formatSecretForDisplay } from "../../modules/users/services/totp.service.ts";
import { SETUP_PASSWORD_MAX_LENGTH } from "../../modules/users/services/owner-setup-policy.service.ts";
import type {
  PendingEnrolment,
  TwoFactorStatus,
} from "../../modules/users/types/user.types.ts";
import { TWO_FACTOR_CODE_MAX_LENGTH } from "./login-two-factor.tsx";
import { INPUT_CLASS, LABEL_CLASS } from "./setup.tsx";

/** Props for the Two-factor page (#220). */
interface AccountTwoFactorPageProps {
  /** Whether 2FA is on, since when, and the recovery codes left. */
  status: TwoFactorStatus;
  /** The enrolment started in this session, if any (only while 2FA is off). */
  pending: PendingEnrolment | null;
  /** True when `REQUIRE_2FA` covers this account and it has no second factor yet. */
  required: boolean;
  /** Recovery codes to show once (just enabled or regenerated). */
  recoveryCodes?: string[];
  /** Optional banner after an action. */
  flash?: { message: string; type: "success" | "error" };
}

/** The primary button style. */
const PRIMARY_BUTTON =
  "px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium rounded-lg hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors";

/** The destructive button style. */
const DANGER_BUTTON =
  "px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 transition-colors";

/** A card around one section. */
const CARD_CLASS =
  "max-w-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-6 mb-6";

/** The code input every form shares (six digits, or a recovery code where allowed). */
function CodeInput({ id, hint }: { id: string; hint: string }) {
  return (
    <>
      <label for={id} class={LABEL_CLASS}>
        Authentication code
      </label>
      <input
        type="text"
        id={id}
        name="code"
        inputmode="text"
        autocomplete="one-time-code"
        autocapitalize="none"
        spellcheck="false"
        maxlength={String(TWO_FACTOR_CODE_MAX_LENGTH)}
        required
        class={INPUT_CLASS}
        placeholder="123456"
      />
      <p class="text-xs text-gray-500 dark:text-gray-400 mt-1.5 mb-4" safe>
        {hint}
      </p>
    </>
  );
}

/**
 * The current password, asked before an enrolment starts (#220): a stolen
 * session alone must not turn 2FA on. Never refilled.
 */
function PasswordInput({ id }: { id: string }) {
  return (
    <>
      <label for={id} class={LABEL_CLASS}>
        Current password
      </label>
      <input
        type="password"
        id={id}
        name="password"
        required
        autocomplete="current-password"
        maxlength={String(SETUP_PASSWORD_MAX_LENGTH)}
        class={`${INPUT_CLASS} mb-4`}
      />
    </>
  );
}

/**
 * Two-factor page (#220, every role): turn TOTP two-factor authentication
 * on (scan a QR code or type the secret, then confirm with a first code),
 * see how many recovery codes are left, get new ones, or turn it off
 * (password and a code). Recovery codes appear exactly once, after they
 * are created. The QR code is inline SVG built on the server; the secret
 * is shown for manual entry; the `otpauth://` URI itself is never written
 * into the page. Every dynamic value is escaped.
 */
export function AccountTwoFactorPage({
  status,
  pending,
  required,
  recoveryCodes,
  flash,
}: AccountTwoFactorPageProps) {
  return (
    <BaseLayout title="Two-factor authentication" activeNav="account-two-factor">
      <h1 class="text-xl font-semibold mb-6">Two-factor authentication</h1>

      {flash != null && <FlashMessage message={flash.message} type={flash.type} />}

      {required && (
        <div class="max-w-xl bg-amber-50 text-amber-900 border border-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-800 rounded-lg px-4 py-3 text-sm mb-6">
          Your role requires two-factor authentication. Set it up to continue using the
          dashboard.
        </div>
      )}

      {recoveryCodes !== undefined && recoveryCodes.length > 0 && (
        <div class="max-w-xl bg-amber-50 text-amber-900 border border-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-800 rounded-lg px-4 py-3 text-sm mb-6">
          <p class="font-medium mb-2">
            Save these recovery codes now, somewhere safe. They won't be shown again.
          </p>
          <p class="mb-3">
            Each code signs you in once if you lose your authenticator app.
          </p>
          <ul class="grid grid-cols-2 gap-x-6 gap-y-1 font-mono">
            {recoveryCodes.map((code) => (
              <li safe>{code}</li>
            ))}
          </ul>
        </div>
      )}

      {status.enabled ? (
        <>
          <div class={CARD_CLASS}>
            <p class="text-sm font-medium text-emerald-700 dark:text-emerald-400 mb-1">
              Two-factor authentication is on.
            </p>
            <p class="text-sm text-gray-600 dark:text-gray-400">
              Enabled <TimeDisplay value={status.enabledAt} fallback="earlier" />.
              Recovery codes left:{" "}
              <span class="font-medium text-gray-900 dark:text-gray-100" safe>
                {String(status.recoveryCodesLeft)}
              </span>
              .
            </p>
            {status.recoveryCodesLeft <= 3 && (
              <p class="text-sm text-amber-700 dark:text-amber-400 mt-2">
                You are running out of recovery codes: get new ones below.
              </p>
            )}
          </div>

          <div class={CARD_CLASS}>
            <h2 class="text-base font-semibold mb-2">New recovery codes</h2>
            <p class="text-sm text-gray-600 dark:text-gray-400 mb-4">
              Replaces every recovery code you have, used or not, with ten new ones.
            </p>
            <form method="POST" action="/dashboard/account/two-factor/recovery-codes">
              <CodeInput id="regenerate-code" hint="The 6-digit code from your app." />
              <button type="submit" class={PRIMARY_BUTTON}>
                Get new recovery codes
              </button>
            </form>
          </div>

          <div class={CARD_CLASS}>
            <h2 class="text-base font-semibold mb-2">
              Turn off two-factor authentication
            </h2>
            <p class="text-sm text-gray-600 dark:text-gray-400 mb-4">
              Your account will be protected by your password alone. Your recovery codes
              stop working.
            </p>
            <form method="POST" action="/dashboard/account/two-factor/disable">
              <PasswordInput id="disable-password" />
              <CodeInput
                id="disable-code"
                hint="The 6-digit code from your app, or a recovery code."
              />
              <button type="submit" class={DANGER_BUTTON}>
                Turn off
              </button>
            </form>
          </div>
        </>
      ) : pending !== null ? (
        <div class={CARD_CLASS}>
          <h2 class="text-base font-semibold mb-2">Set up your authenticator app</h2>
          <ol class="text-sm text-gray-600 dark:text-gray-400 list-decimal pl-5 mb-4 space-y-1">
            <li>
              Open an authenticator app (for example Aegis, 2FAS, Google Authenticator,
              1Password or Bitwarden) and scan this QR code.
            </li>
            <li>Then enter the 6-digit code it shows to finish.</li>
          </ol>
          <div class="mb-4">
            <QrCode value={pending.uri} label="QR code for your authenticator app" />
          </div>
          <p class="text-sm text-gray-600 dark:text-gray-400 mb-1">
            Can't scan it? Enter this key by hand (time-based, 6 digits, 30 seconds):
          </p>
          <p
            class="font-mono text-sm bg-gray-100 dark:bg-gray-800 rounded px-3 py-2 mb-4 break-all"
            safe
          >
            {formatSecretForDisplay(pending.secret)}
          </p>
          <form method="POST" action="/dashboard/account/two-factor/confirm">
            <CodeInput id="confirm-code" hint="The 6-digit code your app shows now." />
            <p class="text-xs text-gray-500 dark:text-gray-400 mb-4">
              Turning it on signs you out on every other device and browser.
            </p>
            <button type="submit" class={PRIMARY_BUTTON}>
              Turn on two-factor authentication
            </button>
          </form>
          <details class="mt-3">
            <summary class="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 cursor-pointer">
              Start over with a new key
            </summary>
            <form method="POST" action="/dashboard/account/two-factor/start" class="mt-3">
              <PasswordInput id="restart-password" />
              <button type="submit" class={PRIMARY_BUTTON}>
                Start over
              </button>
            </form>
          </details>
        </div>
      ) : (
        <div class={CARD_CLASS}>
          <p class="text-sm text-gray-600 dark:text-gray-400 mb-4">
            Two-factor authentication is off. With it on, signing in also asks for a code
            from an authenticator app on your phone, so a stolen password alone is not
            enough.
          </p>
          <form method="POST" action="/dashboard/account/two-factor/start">
            <PasswordInput id="start-password" />
            <button type="submit" class={PRIMARY_BUTTON}>
              Set up two-factor authentication
            </button>
          </form>
        </div>
      )}
    </BaseLayout>
  );
}
