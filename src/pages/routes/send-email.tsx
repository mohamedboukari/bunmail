import { BaseLayout } from "../layouts/base.tsx";
import { FlashMessage } from "../components/flash-message.tsx";
import { EmailChipInput, EmailChipInputScript } from "../components/email-chip-input.tsx";
import type { ApiKey } from "../../modules/api-keys/types/api-key.types.ts";

/**
 * Props for the send email page.
 */
interface SendEmailPageProps {
  flash?: { message: string; type: "success" | "error" };
  /** Active API keys the operator can choose to send "as" (#89). */
  apiKeys: ApiKey[];
  /** Key id pre-selected in the dropdown — default-first-active matches
   *  the pre-#89 silent behaviour but now it's visible and overridable. */
  defaultApiKeyId?: string;
  /**
   * Pre-fill values for the compose form (#86). Set by callers like
   * the "Reply to inbound" route; the operator can still edit each
   * field before sending. All optional — when omitted the form
   * renders with placeholders only.
   */
  prefill?: {
    from?: string;
    to?: string;
    subject?: string;
    html?: string;
    text?: string;
  };
}

/**
 * Send Email page — compose and send emails via the dashboard.
 */
export function SendEmailPage({
  flash,
  apiKeys,
  defaultApiKeyId,
  prefill,
}: SendEmailPageProps) {
  return (
    <BaseLayout title="Send Email" activeNav="send">
      <h1 class="text-xl font-semibold mb-6">Send Email</h1>

      {/* Flash message */}
      {flash && <FlashMessage message={flash.message} type={flash.type} />}

      {/* Compose form */}
      <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4 mb-6">
        <form method="POST" action="/dashboard/send" class="space-y-4">
          {/* "Sending as" — explicit api-key picker (#89). Pre-#89 the
              dashboard picked the first active key silently, which made
              auto-suppressions get filed against an invisible key. The
              picker keeps the default but makes it overridable and
              shows the operator exactly which key is signing the row. */}
          <div>
            <label
              for="apiKeyId"
              class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              Sending as
            </label>
            {apiKeys.length === 0 ? (
              <p class="text-sm text-red-600 dark:text-red-400">
                No active API keys. Create one in the API Keys section before sending.
              </p>
            ) : (
              <select
                id="apiKeyId"
                name="apiKeyId"
                required
                class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500"
              >
                {apiKeys.map((k) => (
                  <option value={k.id} selected={k.id === defaultApiKeyId}>
                    {`${k.name} — ${k.id.slice(0, 12)}…`}
                  </option>
                ))}
              </select>
            )}
            <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Determines which key the send (and any auto-suppression) is filed under.
            </p>
          </div>

          {/* from / to */}
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label
                for="from"
                class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                From
              </label>
              <input
                type="email"
                id="from"
                name="from"
                required
                value={prefill?.from ?? ""}
                placeholder="hello@yourdomain.com"
                class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500 focus:border-transparent"
              />
            </div>
            <div>
              <label
                for="to"
                class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                To
              </label>
              <input
                type="email"
                id="to"
                name="to"
                required
                value={prefill?.to ?? ""}
                placeholder="recipient@example.com"
                class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500 focus:border-transparent"
              />
            </div>
          </div>

          {/* cc / bcc — chip input (#85): type and press comma/space/Enter to add */}
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label
                for="cc"
                class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                CC
              </label>
              <EmailChipInput name="cc" id="cc" placeholder="cc@example.com" />
              <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Press comma, space, or Enter after each address.
              </p>
            </div>
            <div>
              <label
                for="bcc"
                class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                BCC
              </label>
              <EmailChipInput name="bcc" id="bcc" placeholder="bcc@example.com" />
              <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Press comma, space, or Enter after each address.
              </p>
            </div>
          </div>

          {/* subject */}
          <div>
            <label
              for="subject"
              class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              Subject
            </label>
            <input
              type="text"
              id="subject"
              name="subject"
              required
              maxlength={500}
              value={prefill?.subject ?? ""}
              placeholder="Email subject"
              class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500 focus:border-transparent"
            />
          </div>

          {/* html */}
          <div>
            <label
              for="html"
              class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              HTML Body
            </label>
            <textarea
              id="html"
              name="html"
              rows="8"
              placeholder="<p>Hello, world!</p>"
              class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500 focus:border-transparent"
              safe
            >
              {prefill?.html ?? ""}
            </textarea>
          </div>

          {/* text */}
          <div>
            <label
              for="text"
              class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              Plain Text (optional)
            </label>
            <textarea
              id="text"
              name="text"
              rows="4"
              placeholder="Plain text fallback"
              class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500 focus:border-transparent"
              safe
            >
              {prefill?.text ?? ""}
            </textarea>
          </div>

          <button
            type="submit"
            class="px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium rounded-lg hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors"
          >
            Send Email
          </button>
        </form>
      </div>

      {/* Behaviour for the CC / BCC chip inputs — single block handles both. */}
      <EmailChipInputScript />
    </BaseLayout>
  );
}
