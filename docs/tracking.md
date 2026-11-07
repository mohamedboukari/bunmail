# Tracking Module

Open and click tracking (#187): the public `/t/` endpoints, their tokens, the link rewriter and pixel added at send time, and the recording of events. Off by default. The per-send decision lives in the emails module ([emails.md](emails.md#open-and-click-tracking-187)), the domain opt-in in [domains.md](domains.md#open-and-click-tracking-187), and the `email_events` table in [emails.md](emails.md#schema). Recorded events reach webhooks (`email.opened`, `email.clicked`), the events API (`GET /api/v1/emails/:id/events`) and the dashboard (a timeline on the email page, badges on the list).

## Module Layout

```
src/modules/tracking/
├── tracking.plugin.ts              ← GET /t/o/<token>.gif and GET /t/c/<token>, invalid-token limiter, background recording
├── services/
│   ├── tracking-token.ts           ← Open and click tokens: HKDF keys, mint, verify (constant time, no database)
│   ├── html-scan.ts                ← Bounded scan of the real markup (tags, raw-text elements, the last real </body>)
│   ├── href-decode.ts              ← An href read as a browser would, or refused when ambiguous
│   ├── link-rewriter.ts            ← Rewrites <a href> values; skip rules
│   ├── body-tracking.ts            ← Links then pixel on an HTML body (`applyBodyTracking`, `insertOpenPixel`)
│   ├── tracking-injection.ts       ← The tracking of one email at send time (`trackingForEmail`)
│   ├── tracking-guards.ts          ← In-process gate: dedupe, per-email caps, budget, concurrency
│   ├── tracking-record.service.ts  ← Recording: the gate, then the transaction (dedupe, caps, event, first_*_at)
│   └── tracking-client.ts          ← client_kind from the user agent, the stored click URL
└── types/
    └── tracking.types.ts           ← TrackingKind, TrackingResult, TrackingHit
```

## Gates

Three gates, all off by default: `TRACKING_ENABLED`, the sender domain's opt-in (admins), and the send not opting out; `transactional` mail only when the send asks; only single-recipient mail and an `https://` `APP_BASE_URL`. The decision is stored on the email at create. At send time the queue re-checks the kill switch, the recipient and the base URL (`trackingForEmail`), so turning `TRACKING_ENABLED` off stops new pixels and links at once; links already sent keep redirecting.

## Tokens

Both are HMAC-SHA256 truncated to 128 bits, with keys derived by HKDF-SHA256 from `DKIM_ENCRYPTION_KEY` (no new secret), one per kind, and compared in constant time. Both verify **without the database**, so an invalid token is refused, and rate limited, before any query, and a response never tells whether an email exists. Deterministic, so a retry carries the same body.

| Kind | Layout | MAC over | HKDF label |
|---|---|---|---|
| Open | `<email id hex>.<MAC>` (57 characters) | `open:v1:<email id>` | `bunmail open token v1` |
| Click | `<email id hex>.<position>.<base64url(url)>.<MAC>` | `click:v1:<email id>:<position>:<url>` | `bunmail click token v1` |

- Only canonical (`new URL(url).href`) `http:` and `https:` URLs of at most 2048 characters are ever signed or accepted; the base64url part must be the one canonical encoding. `javascript:`, `data:` and every other scheme can never be signed or redirected to.
- The click MAC also covers the link's position (0 to 99), so `email_events.link_position` and the dedupe per link come from the token itself.
- Who an event belongs to comes from the email row (tracked mail has exactly one recipient). A valid token whose email is gone still gets its GIF or redirect; the recorder finds no row and records nothing.
- Rotating `DKIM_ENCRYPTION_KEY` breaks every tracking link already sent (SECURITY.md, Rotation).

**Click links are permanent (residual risk).** A click link is a permanent redirect to the URL signed for it. Any API key allowed to send tracked mail from an opted-in domain can mint one for any `http(s)` URL by sending a tracked email to itself, and the link keeps working after the email is deleted, the domain opts out, the key is revoked or `TRACKING_ENABLED` is turned off. The only revocation today is rotating `DKIM_ENCRYPTION_KEY`, which also breaks every unsubscribe link and signed return path already sent. A per-domain revocation is tracked in a follow-up issue.

## What the body gets

In `composeMessageBody` (`src/modules/emails/services/message-body.ts`), in this order: the text alternative from the original HTML, the document wrapper, the rewritten links, then `<img src="<APP_BASE_URL>/t/o/<token>.gif" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px">` before the last `</body>` that is real markup (not one inside a comment, `<script>`, `<style>`, `<textarea>` or another raw-text element), or at the end. `emails.html` is never changed and the text part is never rewritten. What the rewriter changes and skips: see [emails.md](emails.md#open-and-click-tracking-187).

The scan (`scanMarkup`, `html-scan.ts`) is one left-to-right pass: every search starts where the last one stopped, raw-text elements (`script`, `style`, `title`, `textarea`, `xmp`, `noscript`, `noembed`, `noframes`, `iframe`) are skipped to their closing tag, `<plaintext>` ends it, and a tag, comment or raw-text element that never ends stops it, keeping the rest as it is. The rewriter's only look-ahead (a link's visible text, to skip anchors whose text is a URL) reads a fixed 4096-character window for at most 100 links, and no regular expression is built from the input, so its cost is linear.

An `href` is tracked only when the URL BunMail signs is exactly the one the recipient's client would open (`decodeHref`, `href-decode.ts`): `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;` and numeric references with their `;` are decoded; an `&` a browser keeps as written stays (raw query separators such as `&utm_source=`); any other reference, a legacy name a browser would decode without `;`, or a code point browsers remap or drop (NUL, C0 controls, U+0080 to U+009F, surrogates) leaves the link untracked. Then only the URL parser's own rule applies: tab and newlines removed, C0 controls and spaces stripped at the ends (NBSP and U+FEFF are kept).

## Endpoints

- `GET /t/o/<token>.gif`: the 43-byte transparent GIF for a valid token, whether or not its email still exists; otherwise `404`.
- `GET /t/c/<token>`: `302` to the signed URL, re-checked as `http(s)` before redirecting; otherwise a neutral `404` page that never shows the URL.
- `HEAD` is answered like `GET` and never recorded (link scanners).
- Headers: `Cache-Control: no-store, private`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex` (also set for `/t/` by `security-headers.ts`), no cookie.
- Rate limit: only invalid tokens count, 30 a minute per client IP (IPv6 per /64, `DASHBOARD_TRUSTED_PROXY_HOPS` honoured), then `429` with `Retry-After` and one `warn` per burst. Valid requests are never limited: mail proxies fetch for millions of people from a few addresses. Neither route queries the database before answering.

**Logs.** BunMail's request line masks every path segment after `/t/o/`, `/t/c/` and `/u/` (`:token`), whatever its encoding. A reverse proxy's access log does not: it records the full token, and a click token carries the target URL with its query (which may hold the recipient's own tokens). Mask those paths in the proxy log too (or turn the access log off for them). For example, with Caddy's log filter (check the syntax for your Caddy version):

```
log {
    format filter {
        wrap console
        fields {
            request>uri regexp ^/(t/[oc]|u)/.* /$1/:token
        }
    }
}
```

or with nginx:

```
map $request_uri $loggable_uri {
    ~^/(t/[oc]|u)/  /$1/:token;
    default         $request_uri;
}
log_format masked '$remote_addr [$time_local] "$request_method $loggable_uri" $status $body_bytes_sent';
access_log /var/log/nginx/access.log masked;
```

## Recording

After the response is built (`recordLater` in the plugin), never delaying it, and never throwing:

1. `TRACKING_ENABLED` off: nothing recorded (`untracked`).
2. The in-process gate (`tracking-guards.ts`): the same email, type and link within 60 s is `deduped`, an email at its cap in this process is `capped` (bounded LRU maps of 10,000 entries). Only what passes is charged to the per-second budget (100 a second, else `capped`), so one replayed token cannot use it up for every other email. At most 4 recordings run at once per process; more are dropped as `capped` without touching the database.
3. One transaction, with `SET LOCAL lock_timeout = '2s'`: the email row locked `FOR UPDATE` (gone, or not tracked for that kind: `untracked`); at most 20 opens and 50 clicks per email (`capped`); the same type and link within 60 s: `deduped`; then the event is inserted and `first_opened_at` / `first_clicked_at` set with a conditional `UPDATE ... WHERE ... IS NULL`. These database checks are the truth across replicas. A lock not granted within 2 s counts as `capped` (logged at `debug`). The `email.opened` / `email.clicked` webhook events are enqueued through the outbox in this same transaction (`storeEvent`), for recorded events only: a failed enqueue rolls the event back too.

Stored per event: type, link position, the URL without query string, fragment or credentials, `client_kind` (`image_proxy` when the user agent carries `GoogleImageProxy`, `ggpht.com` or `YahooMailProxy`, else `unknown`) and `machine` (a known proxy, a click within 10 s of `sent_at`, or a click on another link of the email within 2 s). Never the IP address or the user agent. A failure is logged at `error` with the email id, the error name and the SQLSTATE only (never a driver message, the URL or the recipient); the steps are logged at `debug`.

Metrics: `bunmail_tracking_requests_total{kind, result}` and the `tracking` HTTP `area`, see [metrics.md](metrics.md).

## Webhooks

`email.opened` and `email.clicked` fire for **every recorded event** (after the dedupe and caps), never for a deduplicated, capped or untracked request, scoped to the sending key's webhooks like every `email.*` event (the per-key webhook cap, `WEBHOOKS_MAX_PER_API_KEY`, bounds the fan-out). They go through the transactional outbox (#184) in the transaction that inserts the event row, so both commit or neither does. Payload (`data`): `emailId`, `recipient`, `occurredAt`, for a click `url` (without query string and fragment) and `linkPosition`, then `first` (the email's first open or click), `machine`, `clientKind` and `tags`. Firing only the first event would often fire on an Apple Mail prefetch and never on the real open: `first` and `machine` let the consumer decide. See [webhooks.md](webhooks.md#webhook-payload).

## Events API

`GET /api/v1/emails/:id/events`: the email's events, **oldest first** (a timeline), paginated like the emails list (`page`, `limit` up to 100). Scoped like `GET /api/v1/emails/:id` (another key's, missing or trashed email: `404`). Each event: `type`, `occurredAt`, `url`, `linkPosition`, `clientKind`, `machine`; no internal id. See [api.md](api.md#get-apiv1emailsidevents).

## Dashboard

- **Email page:** an "Opens and clicks" timeline (time in UTC, type, link URL, client kind, a "Likely automated" badge for `machine`), with the reliability caveat next to it. Shown when the email is tracked or has events, trashed emails included.
- **Emails list:** "Opened" and "Clicked" badges next to the status, from `first_opened_at` / `first_clicked_at`.
- Every value from the database is rendered escaped (`safe`). No new dashboard route.

**Reliability.** Open and click numbers are both inflated and deflated: Apple Mail Privacy Protection fetches every image at delivery (nearly every Apple Mail recipient shows as opened), Gmail and Yahoo proxies cache images (repeat opens undercounted), Outlook and others block images (opens undercounted), link scanners click every link (fake clicks, partly caught by `machine`), and forwarded mail is attributed to the original recipient. The dashboard and API say so; treat the numbers as signals, not facts.

## Service Methods

#### `trackingForEmail(email, unsubscribeUrl, settings?): BodyTracking | undefined`
The pixel URL and link options for one email, or `undefined` when nothing is tracked (row flags off, `TRACKING_ENABLED` off, several recipients, or a non-https `APP_BASE_URL`). Links to the `APP_BASE_URL` host and the domain's `unsubscribe_url` are never rewritten.

#### `rewriteLinks(html, options): { html, rewritten }` / `matchesUnsubscribeUrl(url, unsubscribeUrl)` / `applyBodyTracking(html, tracking)` / `insertOpenPixel(html, url)`
Pure; see above. The unsubscribe URL matches exactly, or a path under it on a `/` boundary when it has no query and is not a site root (a root URL matches only itself).

#### `scanMarkup(html, visit)` / `lastBodyClose(html)` / `decodeHref(raw)`
The scan and the href reading behind the rewriter and the pixel.

#### `mintOpenToken` / `verifyOpenToken` / `mintClickToken` / `verifyClickToken` / `trackableUrl` / `deriveTrackingKeys`
Token helpers; see Tokens.

#### `createTrackingRecorder(options?): (hit) => Promise<result | null>`
A recorder with its own gate (`budgetPerSecond`, `maxInFlight`, `now` for tests); `null` means it failed and logged it.

#### `listEmailEvents(emailId, apiKeyId | null, { page, limit }): { data, total } | null` (emails module)
The events of one email, oldest first; `null` when the email is not visible to the key (`null` key: the dashboard, trashed emails included).

#### `trackingPlugin(options?)`
The Elysia plugin, mounted by `src/app.ts` next to the unsubscribe pages. Options (tests): `limit`, `recorder`, `onRecord`.

## Tests

`test/unit/tracking-token.test.ts`, `test/unit/link-rewriter.test.ts` (adversarial HTML, ambiguous entities, raw-text elements, the unsubscribe and own-host rules, linear time), `test/unit/tracking-body.test.ts` (composition order, determinism, pixel placement, client helpers), `test/unit/tracking-guards.test.ts` (the in-process gate) and `test/integration/tracking.integration.test.ts` (routes, headers, no query before an invalid token is refused, rate limit, recording, lock timeout, sanitized failures, metrics, the full path from send to event).
