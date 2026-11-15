# Tracking Module

Open and click tracking (#187): the public `/t/` endpoints, their tokens, the link rewriter and pixel added at send time, and the recording of events. Off by default. The per-send decision lives in the emails module ([emails.md](emails.md#open-and-click-tracking-187)), the domain opt-in in [domains.md](domains.md#open-and-click-tracking-187), and the `email_events` table in [emails.md](emails.md#schema). Recorded events reach webhooks (`email.opened`, `email.clicked`), the events API (`GET /api/v1/emails/:id/events`) and the dashboard (a timeline on the email page, badges on the list).

## Module Layout

```
src/modules/tracking/
├── tracking.plugin.ts              ← GET /t/o/<token>.gif and GET /t/c/<token>, invalid-token limiter, background recording
├── services/
│   ├── tracking-token.ts           ← Open and click tokens: HKDF keys, mint, verify (constant time, no database)
│   ├── tracking-epoch.service.ts   ← Click link revocation (#424): the domain epoch check, the epoch cache
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

Three gates, all off by default: `TRACKING_ENABLED`, the sender domain's opt-in (admins), and the send not opting out; `transactional` mail only when the send asks; only single-recipient mail and an `https://` `APP_BASE_URL`. The decision is stored on the email at create. At send time the queue re-checks the kill switch, the recipient and the base URL (`trackingForEmail`), so turning `TRACKING_ENABLED` off stops new pixels and links at once; links already sent keep redirecting until an admin revokes them (see [Revoking click links](#revoking-click-links-424)).

## Tokens

Both are HMAC-SHA256 truncated to 128 bits, with keys derived by HKDF-SHA256 from `DKIM_ENCRYPTION_KEY` (no new secret), one per kind, and compared in constant time. Both verify **without the database**, so an invalid token is refused, and rate limited, before any query, and a response never tells whether an email exists. Deterministic, so a retry carries the same body (until the domain's click links are revoked, below).

| Kind | Layout | MAC over | HKDF label |
|---|---|---|---|
| Open | `<email id hex>.<MAC>` (57 characters) | `open:v1:<email id>` | `bunmail open token v1` |
| Click (v2, #424) | `<email id hex>.<position>.<base64url(url)>.<domain id hex>.<epoch>.<MAC>` | `click:v2:<email id>:<position>:<domain id>:<epoch>:<url>` | `bunmail click token v1` |
| Click (v1, before #424) | `<email id hex>.<position>.<base64url(url)>.<MAC>` | `click:v1:<email id>:<position>:<url>` | `bunmail click token v1` |

- Only canonical (`new URL(url).href`) `http:` and `https:` URLs of at most 2048 characters are ever signed or accepted; the base64url part must be the one canonical encoding. `javascript:`, `data:` and every other scheme can never be signed or redirected to.
- The click MAC also covers the link's position (0 to 99), so `email_events.link_position` and the dedupe per link come from the token itself.
- Who an event belongs to comes from the email row (tracked mail has exactly one recipient). A valid token whose email is gone still gets its GIF or redirect; the recorder finds no row and records nothing.
- Rotating `DKIM_ENCRYPTION_KEY` breaks every tracking link already sent (SECURITY.md, Rotation).
- The two click layouts differ in their number of parts, so a later field (an expiry, say) can come as a new version the same way. There is no expiry today.

## Revoking click links (#424)

A click link is a redirect through the operator's host, and any key allowed to send tracked mail from an opted-in domain can mint one for any `http(s)` URL by sending a tracked email to itself. An admin can revoke every click link already sent from one domain: **Revoke tracking links** on the domain page in the dashboard, or `POST /api/v1/domains/:id/tracking-revocation` (admin keys). It bumps `domains.tracking_epoch` (audited as `domain.tracking_links_revoked`), and the redirect then refuses every link of the old epoch. Links in mail sent afterwards carry the new epoch and work, retries of queued mail included. It cannot be undone. At the highest epoch (2^31 - 1, unreachable in practice) it is refused with `409 TRACKING_EPOCH_EXHAUSTED` and nothing changes.

**Stop the abuse first.** A revocation does not stop the key that minted the links from minting new ones: it only kills links already sent. Revoke the abusing API key (or turn click tracking off for the domain) first, then revoke the links.

- **v2 links** (sent since #424) name their domain and the epoch they were minted under, both covered by the MAC. A link redirects only while its domain exists and is still at that epoch, so deleting a domain also revokes its links. It needs no email row: a v2 link still works once its email is purged.
- **v1 links** (sent before #424, between 0.12.0 and this change) carry no domain. Their domain is the email row's `domain_id`, and they count as epoch 0: they redirect while that row exists, has a domain, and the domain was never revoked. **A v1 link whose email was deleted and purged from the trash stops redirecting** (its domain can no longer be known, so it can no longer be revoked: refused rather than kept as a permanent redirector).
- **Order of checks.** The MAC first, without the database (a forged token never costs a query), then the domain's epoch. A revoked link, a link of a deleted domain and a purged v1 link get exactly the `404` of an invalid token and count against the same per-client limit; each refusal is logged at `info` (`Tracking click link refused`, with `reason` `revoked`, `unknown_domain`, `email_gone` or `no_domain`, the email id, domain id, link position and token version, never the URL). A database failure on that check answers `503` (logged at `error` by error name and SQLSTATE), never a redirect.
- **Cache.** Each process caches, for 30 seconds (`TRACKING_EPOCH_TTL_MS`, at most 10,000 entries each), the domains' epochs (unknown domains included) and the email domain of each v1 link, so a click costs no query; concurrent misses of one key share one read, and a read that raced a bump is not stored. A bump or a domain delete clears the domain's entry in the process that made it, so its links stop there at once; **another replica keeps redirecting them for up to 30 seconds** (until its cached entry expires). A v1 link whose email is purged stops within 30 seconds on every replica (its cached email domain expires; an email's `domain_id` only ever becomes null, when its domain is deleted, and the epoch check then refuses the link anyway).
- **Open pixels are not covered.** A pixel token redirects nowhere (it only returns a GIF and records an open), so it keeps verifying without the database and is not affected by a revocation.

## What the body gets

In `composeMessageBody` (`src/modules/emails/services/message-body.ts`), in this order: the text alternative from the original HTML, the document wrapper, the rewritten links, then `<img src="<APP_BASE_URL>/t/o/<token>.gif" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px">` before the last `</body>` that is real markup (not one inside a comment, `<script>`, `<style>`, `<textarea>` or another raw-text element), or at the end. `emails.html` is never changed and the text part is never rewritten. What the rewriter changes and skips: see [emails.md](emails.md#open-and-click-tracking-187).

The scan (`scanMarkup`, `html-scan.ts`) is one left-to-right pass: every search starts where the last one stopped, raw-text elements (`script`, `style`, `title`, `textarea`, `xmp`, `noscript`, `noembed`, `noframes`, `iframe`) are skipped to their closing tag, `<plaintext>` ends it, and a tag, comment or raw-text element that never ends stops it, keeping the rest as it is. The rewriter's only look-ahead (a link's visible text, to skip anchors whose text is a URL) reads a fixed 4096-character window for at most 100 links, and no regular expression is built from the input, so its cost is linear.

An `href` is tracked only when the URL BunMail signs is exactly the one the recipient's client would open (`decodeHref`, `href-decode.ts`): `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;` and numeric references with their `;` are decoded; an `&` a browser keeps as written stays (raw query separators such as `&utm_source=`); any other reference, a legacy name a browser would decode without `;`, or a code point browsers remap or drop (NUL, C0 controls, U+0080 to U+009F, surrogates) leaves the link untracked. Then only the URL parser's own rule applies: tab and newlines removed, C0 controls and spaces stripped at the ends (NBSP and U+FEFF are kept).

## Endpoints

- `GET /t/o/<token>.gif`: the 43-byte transparent GIF for a valid token, whether or not its email still exists; otherwise `404`.
- `GET /t/c/<token>`: `302` to the signed URL, re-checked as `http(s)` before redirecting, while the link's domain is at the link's epoch (#424); otherwise a neutral `404` page that never shows the URL (`503` when the epoch cannot be read).
- `HEAD` is answered like `GET` and never recorded (link scanners).
- Headers: `Cache-Control: no-store, private`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex` (also set for `/t/` by `security-headers.ts`), no cookie.
- Rate limit: only invalid tokens count, 30 a minute per client IP (IPv6 per /64, `DASHBOARD_TRUSTED_PROXY_HOPS` honoured), then `429` with `Retry-After` and one `warn` per burst. Valid requests are never limited: mail proxies fetch for millions of people from a few addresses. A revoked click link counts as invalid. The open route never queries the database before answering; the click route reads only its domain's epoch (cached) and, for a v1 link, its email's domain, and only once the MAC verified.

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
- **Domain page:** the tracking opt-in and **Revoke tracking links** (#424, admins only, `POST /dashboard/domains/:id/tracking-revoke`, asks for confirmation), see [Revoking click links](#revoking-click-links-424).
- Every value from the database is rendered escaped (`safe`).

**Reliability.** Open and click numbers are both inflated and deflated: Apple Mail Privacy Protection fetches every image at delivery (nearly every Apple Mail recipient shows as opened), Gmail and Yahoo proxies cache images (repeat opens undercounted), Outlook and others block images (opens undercounted), link scanners click every link (fake clicks, partly caught by `machine`), and forwarded mail is attributed to the original recipient. The dashboard and API say so; treat the numbers as signals, not facts.

## Service Methods

#### `trackingForEmail(email, domain, settings?): BodyTracking | undefined`
The pixel URL and link options for one email, or `undefined` when nothing is tracked (row flags off, `TRACKING_ENABLED` off, several recipients, or a non-https `APP_BASE_URL`). `domain` is the sender domain (`id`, `trackingEpoch`, `unsubscribeUrl`): click tokens carry its id and current epoch, and without a domain no link is rewritten. Links to the `APP_BASE_URL` host and the domain's `unsubscribe_url` are never rewritten.

#### `rewriteLinks(html, options): { html, rewritten }` / `matchesUnsubscribeUrl(url, unsubscribeUrl)` / `applyBodyTracking(html, tracking)` / `insertOpenPixel(html, url)`
Pure; see above. The unsubscribe URL matches exactly, or a path under it on a `/` boundary when it has no query and is not a site root (a root URL matches only itself).

#### `scanMarkup(html, visit)` / `lastBodyClose(html)` / `decodeHref(raw)`
The scan and the href reading behind the rewriter and the pixel.

#### `mintOpenToken` / `verifyOpenToken` / `mintClickToken(subject, domain, keys?)` / `verifyClickToken` / `trackableUrl` / `deriveTrackingKeys`
Token helpers; see Tokens. `mintClickToken` only mints v2 tokens; `verifyClickToken` returns `version: 2` with `domainId` and `epoch`, or `version: 1` for a link from before #424.

#### `checkClickLink(token, deps?): ClickLinkCheck` / `forgetTrackingEpoch(domainId)` / `createTtlCache(load, options?)`
The epoch check of a verified click token (`{ ok: true, domainId }` or `{ ok: false, reason, domainId }`, throws when the database does), dropping a domain's cached epoch after a bump or a delete, and the cache behind the epochs and the v1 email domains (TTL, one load per key at a time, a load that raced a `forget` is not stored, a failed load is not cached).

#### `revokeTrackingLinks(id, audit): Domain | undefined` (domains module)
Bumps the domain's tracking epoch and records `domain.tracking_links_revoked` (`{ epoch }`) in one transaction, then clears the cached epoch; `undefined` for an unknown domain; throws `TrackingEpochExhaustedError` (`409`) at the highest epoch.

#### `createTrackingRecorder(options?): (hit) => Promise<result | null>`
A recorder with its own gate (`budgetPerSecond`, `maxInFlight`, `now` for tests); `null` means it failed and logged it.

#### `listEmailEvents(emailId, apiKeyId | null, { page, limit }): { data, total } | null` (emails module)
The events of one email, oldest first; `null` when the email is not visible to the key (`null` key: the dashboard, trashed emails included).

#### `trackingPlugin(options?)`
The Elysia plugin, mounted by `src/app.ts` next to the unsubscribe pages. Options (tests): `limit`, `recorder`, `onRecord`, `checkClick`.

## Tests

`test/unit/tracking-token.test.ts` (v1 links built by hand in `test/legacy-click-token.ts`), `test/unit/tracking-epoch.test.ts` (the epoch check, the cache), `test/unit/link-rewriter.test.ts` (adversarial HTML, ambiguous entities, raw-text elements, the unsubscribe and own-host rules, linear time), `test/unit/tracking-body.test.ts` (composition order, determinism, pixel placement, client helpers), `test/unit/tracking-guards.test.ts` (the in-process gate) and `test/integration/tracking.integration.test.ts` (routes, headers, no query before an invalid token is refused, rate limit, recording, lock timeout, sanitized failures, metrics, the full path from send to event, revocation: v1 at epoch 0, a bump refusing v1 and v2 at once, deleted domains, purged v1 emails, the `503`) and `test/integration/tracking-revocation.integration.test.ts` (the REST and dashboard routes, admins only, the audit event).
