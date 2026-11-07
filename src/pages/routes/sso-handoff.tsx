import { PageAssets } from "../static-assets.tsx";

/**
 * The URL as an HTML attribute value. `@kitajs/html` escapes only `"` in
 * attributes; `&` is escaped here so no `&name;` sequence in the URL can
 * be read as a character reference. `URL.href` already percent-encodes
 * `"`, `<`, `>`, `'` and spaces, so nothing else needs escaping.
 */
function attributeUrl(url: string): string {
  return url.replaceAll("&", "&amp;");
}

/**
 * The hand-off to an SSO provider (#409): what the two SSO start routes
 * (`POST /dashboard/login/sso/:provider`, `POST /dashboard/account/sso/:id/link`)
 * answer instead of a `302` to the provider.
 *
 * The dashboard's CSP has `form-action 'self'`, and browsers apply it to
 * every redirect that follows a form submission: a `302` from the start
 * route to the provider is dropped without a word. This page ends the
 * form submission on BunMail's own origin, then a meta refresh opens the
 * provider in a new navigation, which `form-action` does not cover. The
 * link is the fallback for a browser that has refreshes turned off.
 *
 * `authorizationUrl` is built by `startSsoFlow` from the provider's
 * discovery document, whose endpoints are checked to be `https:` (or
 * loopback `http:` in development); `label` is operator-set and rendered
 * escaped.
 */
export function SsoHandoffPage({
  label,
  authorizationUrl,
}: {
  label: string;
  authorizationUrl: string;
}) {
  const target = attributeUrl(authorizationUrl);
  return (
    <html lang="en" class="h-full">
      <head>
        <meta charset="UTF-8" />
        <meta http-equiv="refresh" content={`0;url=${target}`} />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <title safe>{`Continue to ${label} | BunMail`}</title>
        <PageAssets />
      </head>
      <body class="h-full bg-gray-50 dark:bg-gray-950 flex items-center justify-center">
        <div class="w-full max-w-sm mx-auto px-4 text-center">
          <p class="text-sm text-gray-600 dark:text-gray-400 mb-4" safe>
            {`Taking you to ${label}...`}
          </p>
          <a
            href={target}
            class="inline-block text-sm font-medium px-4 py-2 rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors"
            safe
          >
            {`Continue to ${label}`}
          </a>
        </div>
      </body>
    </html>
  );
}
