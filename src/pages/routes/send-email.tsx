import { BaseLayout } from "../layouts/base.tsx";
import { FlashMessage } from "../components/flash-message.tsx";

/**
 * Props for the send email page.
 */
interface SendEmailPageProps {
  flash?: { message: string; type: "success" | "error" };
  domains?: string[];
}

/**
 * Send Email page — compose and send emails via the dashboard.
 */
export function SendEmailPage({ flash, domains }: SendEmailPageProps) {
  return (
    <BaseLayout title="Send Email" activeNav="send">
      <h1 class="text-xl font-semibold mb-6">Send Email</h1>

      {/* Flash message */}
      {flash && <FlashMessage message={flash.message} type={flash.type} />}

      {/* Compose form */}
      <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4 mb-6">
        <form method="POST" action="/dashboard/send" class="space-y-4">
          {/* from / to */}
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label for="from" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                From
              </label>
              <input
                type="email"
                id="from"
                name="from"
                required
                placeholder="hello@yourdomain.com"
                class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500 focus:border-transparent"
              />
            </div>
            <div>
              <label for="to" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                To
              </label>
              <input
                type="email"
                id="to"
                name="to"
                required
                placeholder="recipient@example.com"
                class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500 focus:border-transparent"
              />
            </div>
          </div>

          {/* cc / bcc */}
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label for="cc" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                CC
              </label>
              <input
                type="email"
                id="cc"
                name="cc"
                placeholder="cc@example.com"
                class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500 focus:border-transparent"
              />
            </div>
            <div>
              <label for="bcc" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                BCC
              </label>
              <input
                type="email"
                id="bcc"
                name="bcc"
                placeholder="bcc@example.com"
                class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500 focus:border-transparent"
              />
            </div>
          </div>

          {/* subject */}
          <div>
            <label for="subject" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Subject
            </label>
            <input
              type="text"
              id="subject"
              name="subject"
              required
              maxlength={500}
              placeholder="Email subject"
              class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500 focus:border-transparent"
            />
          </div>

          {/* html */}
          <div>
            <label for="html" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              HTML Body
            </label>
            <textarea
              id="html"
              name="html"
              rows="8"
              placeholder="<p>Hello, world!</p>"
              class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500 focus:border-transparent"
            />
          </div>

          {/* text */}
          <div>
            <label for="text" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Plain Text (optional)
            </label>
            <textarea
              id="text"
              name="text"
              rows="4"
              placeholder="Plain text fallback"
              class="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500 focus:border-transparent"
            />
          </div>

          <button
            type="submit"
            class="px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium rounded-lg hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors"
          >
            Send Email
          </button>
        </form>
      </div>
    </BaseLayout>
  );
}
