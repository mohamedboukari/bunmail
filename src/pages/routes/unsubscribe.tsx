import type { PropsWithChildren } from "@kitajs/html";
import { PageStylesheet } from "../static-assets.tsx";

/**
 * Public unsubscribe pages (#249), reached from the per-recipient
 * `List-Unsubscribe` link. Standalone: no navigation, no session, no
 * script (stylesheet only). They never show the token or the full
 * address: the address is masked by the caller, and every interpolation
 * is escaped with `safe`.
 */

/** Page frame shared by the unsubscribe pages. */
function UnsubscribeShell({ title, children }: PropsWithChildren<{ title: string }>) {
  return (
    <html lang="en" class="h-full">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="referrer" content="no-referrer" />
        <meta name="robots" content="noindex, nofollow" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <title safe>{title}</title>
        <PageStylesheet />
      </head>
      <body class="h-full bg-gray-50 dark:bg-gray-950 flex items-center justify-center">
        <main class="w-full max-w-sm mx-auto px-4">
          <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-6">
            {children}
          </div>
        </main>
      </body>
    </html>
  );
}

/** Who the page is about: a masked address and the sender's domain. */
interface UnsubscribeSubjectProps {
  maskedAddress: string;
  senderDomain: string;
}

/**
 * Confirmation page for `GET /u/:token`. Opening the link changes nothing
 * (link scanners and prefetchers fetch it); the button POSTs to the same
 * URL (no `action`, so the form goes to the page's own address).
 */
export function UnsubscribeConfirmPage({
  maskedAddress,
  senderDomain,
}: UnsubscribeSubjectProps) {
  return (
    <UnsubscribeShell title="Unsubscribe">
      <h1 class="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
        Unsubscribe?
      </h1>
      <p class="text-sm text-gray-600 dark:text-gray-400 mb-4">
        Stop sending mail to{" "}
        <span class="font-medium text-gray-900 dark:text-gray-100" safe>
          {maskedAddress}
        </span>{" "}
        from{" "}
        <span class="font-medium text-gray-900 dark:text-gray-100" safe>
          {senderDomain}
        </span>
        ?
      </p>
      <form method="POST">
        <input type="hidden" name="confirm" value="unsubscribe" />
        <button
          type="submit"
          class="w-full px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium rounded-lg hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors"
        >
          Unsubscribe
        </button>
      </form>
    </UnsubscribeShell>
  );
}

/** Shown after a successful (or repeated) unsubscribe. */
export function UnsubscribeDonePage({
  maskedAddress,
  senderDomain,
}: UnsubscribeSubjectProps) {
  return (
    <UnsubscribeShell title="Unsubscribed">
      <h1 class="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
        You are unsubscribed
      </h1>
      <p class="text-sm text-gray-600 dark:text-gray-400">
        <span class="font-medium text-gray-900 dark:text-gray-100" safe>
          {maskedAddress}
        </span>{" "}
        will no longer receive this mail from{" "}
        <span class="font-medium text-gray-900 dark:text-gray-100" safe>
          {senderDomain}
        </span>
        .
      </p>
    </UnsubscribeShell>
  );
}

/**
 * One page for every unusable link (malformed, unknown, purged, forged),
 * so the response is no oracle; it never echoes the token.
 */
export function UnsubscribeInvalidPage() {
  return (
    <UnsubscribeShell title="Link not valid">
      <h1 class="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
        This link is not valid
      </h1>
      <p class="text-sm text-gray-600 dark:text-gray-400">
        This link is not valid or has expired.
      </p>
    </UnsubscribeShell>
  );
}

/** Shown when one address sends too many requests. */
export function UnsubscribeRateLimitedPage() {
  return (
    <UnsubscribeShell title="Too many requests">
      <h1 class="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
        Too many requests
      </h1>
      <p class="text-sm text-gray-600 dark:text-gray-400">
        Please wait a minute and try again.
      </p>
    </UnsubscribeShell>
  );
}
