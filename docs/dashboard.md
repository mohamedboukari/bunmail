# Dashboard

Server-rendered web UI for managing BunMail. Built with Elysia JSX (`@elysiajs/html` + `@kitajs/html`).

## Configuration

| Env Variable                       | Required | Default       | Description                                  |
|------------------------------------|----------|---------------|----------------------------------------------|
| BUNMAIL_OWNER_EMAIL                | **Prod** | _(empty)_     | Email of the dashboard owner account (#215), stored lowercased. **Required when `BUNMAIL_ENV=production`** (app refuses to start when it is unset); a malformed address or one over 254 characters is refused in every environment; unset in dev skips the owner bootstrap with a warning, which leaves the dashboard without an account to sign in with (#216). See [Owner setup](#owner-setup-215). |
| DASHBOARD_TRUSTED_PROXY_HOPS       | No       | `0`           | Trusted reverse-proxy hops in front of BunMail, used to resolve the real client IP for login rate limiting. `0` = trust only the raw socket IP. Set to `1` behind a single nginx/Caddy/Cloudflare (`N` for `N` chained proxies). |
| DASHBOARD_LOGIN_RATE_LIMIT_ENABLED | No       | `true`        | Master switch for login brute-force protection |
| DASHBOARD_LOGIN_RATE_LIMIT_MAX     | No       | `5`           | Failed attempts per IP per window before lockout |
| DASHBOARD_LOGIN_RATE_LIMIT_WINDOW  | No       | `900`         | Lockout window in seconds (default 15 minutes) |

`DASHBOARD_PASSWORD` and `SESSION_SECRET` were removed by account login (#216). A value left in `.env` does nothing except one boot warning: `Dashboard auth env vars are no longer used since #216, remove from .env`.

## Auth Flow

Account login (#216): email and password against the `users` and `user_credentials` tables, then a server-side session in `sessions`. Internals: [docs/users.md](users.md#sessions-216).

**Login** (`POST /dashboard/login`, form fields `email`, `password`), in order:

1. Auth-page headers (`Cache-Control: no-store`, `Referrer-Policy: strict-origin`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`), also on `GET /dashboard/login`.
2. Same-origin check: a cross-origin `Origin`/`Referer`, or neither header, gets `403` `Forbidden: cross-origin request rejected` and a `warn` log (`Dashboard login POST rejected: cross-origin (possible CSRF)`). This blocks login CSRF (signing a victim into someone else's account).
3. The per-IP limiter (#109), before any database or argon2id work: `429` with `Retry-After`.
4. Input bounds: an email over 254 or a password over 256 characters fails without any lookup. (Over 320 or 1024 characters the route's schema rejects the body with the global `422` JSON error.)
5. `verifyPasswordLogin` runs exactly one argon2id verify on every branch (a missing account or credential is verified against a dummy hash), so the response time does not reveal whether an account exists.
6. Failure, whatever the reason: counted against the IP, `warn` log `Dashboard login failed` with `ip`, `reason` (`unknown`, `no_password`, `disabled`, `bad_password`, `too_long`) and the email through `redactEmail` (none for `too_long`), and a `302` to `/dashboard/login?error=invalid`, which shows `Invalid email or password.`. The email never goes in the URL.
7. Success: the IP's failure count is cleared; a well-formed session cookie the browser already sent is revoked first (no session stacking, no planted cookie survives login); a new session is created (`info` log `Dashboard login successful` with `userId`, `sessionId`, `ip`) and the browser is sent to the fixed `/dashboard` (no `next` parameter, no open redirect). A database error answers `503` `Dashboard temporarily unavailable`.

**Cookie:** `bm_session=<token>`, where the token is 32 random bytes as base64url (43 characters); only its SHA-256 is stored. `HttpOnly; SameSite=Lax; Path=/dashboard`, plus `Secure` in production (#133), so over plain HTTP the browser drops it (most browsers make an exception for `localhost`). `Max-Age` is 7 days at login; after a rotation it is what is left of the 7 days.

**Lifetimes:** a session expires after 24 hours without use (idle timeout) and 7 days after login at the latest (absolute cap). Both are code constants in `session-policy.service.ts`, not env vars. All expiry math runs on the Postgres clock, so replicas agree.

**Guard** (every route registered after the public login, logout and setup routes), in order:

1. No cookie: `302` to `/dashboard/login`.
2. A value that is not a 43-character token, including a pre-#216 `<timestamp>.<hmac>` cookie: cleared and `302`, with no database query.
3. One query (`findActiveSession`) matches the token's hash against the current and the previous token hash of an unexpired session whose user is not disabled and whose assurance is `password` or `mfa`. No row: cookie cleared, `302`. A database error: `503` `Dashboard temporarily unavailable` (fail closed, and no false logout).
4. Reuse detection (see below): every session of the user is revoked, cookie cleared, `302`.
5. A cross-origin `POST`: `403` (CSRF second layer, #133). It runs before rotation, so a rejected request never carries a new token.
6. Rotation, when due (see below).

**Token rotation and reuse detection.** When a request presents the current token and that token is older than 60 seconds, the session gets a fresh token: one conditional `UPDATE` moves the old hash to `previous_token_hash`, stores the new one, and slides `last_seen_at` and `expires_at` forward (this write is also the idle-timeout refresh, so an active session costs at most one write a minute). The response carries the new cookie. Then:

- A request that still carries the replaced token (parallel tabs, a page and its form post) is served normally for 30 more seconds, without a new cookie.
- Two requests that race to rotate: exactly one wins and sets the new cookie; the other is served without one.
- The replaced token presented **after** those 30 seconds means two parties hold the session: every session of the user is revoked, the `warn` log `Session token reuse detected: all sessions of the user revoked` (with `userId`, `sessionId`, `ip`) is written, the cookie is cleared and the browser is sent to the login page. If revoking fails, the request gets `503`.
- A token two or more rotations old is reuse too: every replaced hash is kept in `session_token_history` until the session ends, so any superseded token, however old, revokes every session of the user, on protected pages and also when presented to the login or logout page. A token that was never issued, or belongs to an expired or revoked session, is simply rejected (cookie cleared, `302`).
- A rotation error is logged (`Dashboard session rotation failed`) and the request is served; the old token stays current.

So a copied cookie is detected as soon as both copies are used: whichever side falls behind a rotation presents a superseded token, and the account is signed out everywhere. A thief who keeps the session active while the real user is idle is caught the moment the real browser returns, however many rotations have passed. The limit: if the real browser never comes back, the thief's session lives until the 7-day cap, a `reset-owner`, or (later) a sign-out from the sessions page (#281). The cost is a rare false logout: if the response carrying a new cookie never reaches the browser (a dropped connection), its next request after the grace period looks like reuse.

**Logout** (`POST /dashboard/logout`, public): same-origin only (`403` and a `warn` log otherwise). It deletes the session row (matched by the current or the previous token hash, so a just-rotated cookie still logs out), logs `Dashboard logout` with `sessionId` and `ip`, and always clears the cookie and redirects to `/dashboard/login`, also for a missing, malformed, already revoked or legacy cookie, and after a database error (logged as `Dashboard logout: session revoke failed`). Replaying the old cookie afterwards gets a `302` to the login page.

The login page also shows a static first sign-in hint (open the owner setup link from the server logs, or run `reset-owner`); there is no database lookup behind it, so the public page says nothing about the setup state. Expired rows are deleted by the purge worker on boot and every 6 hours (`Expired session sweep completed`); the guard enforces expiry itself, so security never depends on that sweep.

### Owner setup (#215)

On first boot BunMail creates the owner account for `BUNMAIL_OWNER_EMAIL` and logs a one-time link at `warn` (at `error` when `LOG_LEVEL=error`) (`Owner setup link`): `<APP_BASE_URL>/dashboard/setup?token=...`, or `http://localhost:PORT/...` (with a `hint` field) when `APP_BASE_URL` is unset or not an `http(s)://` URL. The link is single use and valid for 24 hours; until setup is done each restart replaces it, so only the most recent link works. `bun run src/db/reset-owner.ts` (in Docker: `docker compose exec app bun run src/db/reset-owner.ts`) prints a fresh one.

1. `GET /dashboard/setup?token=...` is public (registered before the session guard, and also in its skip list). It only reads the token: a missing, malformed, unknown, expired, used or replaced token gets the same `400` "invalid link" page, which never echoes the token (missing and malformed tokens are rejected before any database call). A `token` longer than 128 characters, or a repeated `token` parameter, fails the route's schema instead and gets the global `422` JSON error.
2. A live token renders the form (`200`): the owner email, a hidden token field, password and confirmation (15 to 256 characters, counted in code points).
3. `POST /dashboard/setup` (form fields `token`, `password`, `confirm`) checks same-origin itself first, since the guard's CSRF check does not run on public routes: a cross-origin `Origin`/`Referer`, or neither header, gets `403` `Forbidden: cross-origin request rejected` and a `warn` log (`Owner setup POST rejected: cross-origin (possible CSRF)`). Then the token (the same `400` invalid page), then the password policy (a policy error re-renders the form with `200`, no hashing and no write), then it spends the token and stores the argon2id password hash. A token spent by a concurrent submission in between also gets the `400` invalid page.
4. On success the server logs `Owner setup completed` at `warn` (`owner` through `redactEmail`, client `ip`). In the same transaction that stores the password, every session of the owner is deleted and a new one is opened (#216); its token is set as the `bm_session` cookie (the same attributes and 7-day `Max-Age` as a login) and the browser is redirected (`302`) to `/dashboard`.

Every response from the setup handlers, including the `403` and `302` (but not a `422` schema rejection, which never reaches the handler), sends `Cache-Control: no-store`, `Referrer-Policy: strict-origin` (the pages also carry a matching meta tag; a `Referer` carries the origin only, never the token URL, and `no-referrer` would make browsers send `Origin: null` on the form POST, which the same-origin check rejects), `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY`.

After setup the owner signs in at `/dashboard/login` with `BUNMAIL_OWNER_EMAIL` and that password. `reset-owner` signs the owner out of every session as soon as it runs, and completing its link does so again. Internals: [docs/users.md](users.md#owner-bootstrap-215).

### Brute-force protection (#109)

`POST /dashboard/login` throttles failed logins per client IP using
an in-memory sliding window (`src/middleware/login-rate-limit.ts`). Every kind
of failure counts (unknown email, no password, disabled account, wrong
password, over-long input), and the check runs before any database or argon2id
work. After `DASHBOARD_LOGIN_RATE_LIMIT_MAX` failures within
`DASHBOARD_LOGIN_RATE_LIMIT_WINDOW` seconds, further attempts from that IP get
HTTP `429` with a `Retry-After` header until the window expires; a successful
login clears the counter. There is no per-account lockout (it would let anyone
lock the owner out); guessing across many IPs is slowed only by argon2id and
the 15-character password minimum.

The client IP is resolved by counting `DASHBOARD_TRUSTED_PROXY_HOPS` entries from
the **right** of `X-Forwarded-For` (the leftmost entry is attacker-controlled and
never trusted). With the default `0`, the header is ignored and the raw socket IP
is used. Behind a reverse proxy set it to the number of trusted hops (`1` for a
single proxy) so lockouts are per-attacker rather than shared across the proxy's
IP, and make sure the origin can only be reached **through** the proxy, or
`X-Forwarded-For` can't be trusted. State is in-memory and per-replica.

## Pages

| Route                            | Description                                                       |
|----------------------------------|-------------------------------------------------------------------|
| GET /dashboard/login             | Email + password login form (standalone, no nav, #216)            |
| GET /dashboard/setup             | Owner setup form from the one-time link (standalone, public, #215) |
| GET /dashboard                   | Stats overview: outbound, inbound, configuration sections        |
| GET /dashboard/send              | Compose & send emails from dashboard                              |
| GET /dashboard/emails            | Email logs with status tabs (All / Queued / Sending / Sent / Failed / Bounced) + **Source** (API / SMTP) and **API-key** dropdown filters (#137), a per-row source badge, bulk-select, per-row trash. Filters compose and are preserved across pagination. |
| GET /dashboard/emails/trash      | Trashed emails: bulk Restore / Delete-forever / Empty trash      |
| GET /dashboard/emails/:id        | Single email detail + preview (Restore/Delete-forever if trashed) |
| GET /dashboard/api-keys          | API keys list + create form                                       |
| GET /dashboard/domains           | Domains list + add form                                           |
| GET /dashboard/domains/:id       | Domain detail + DNS status                                        |
| GET /dashboard/templates         | Templates list + create form (live HTML preview)                  |
| GET /dashboard/templates/:id     | Template detail + edit form (live HTML preview)                   |
| GET /dashboard/webhooks          | Webhooks list + create form                                       |
| GET /dashboard/inbound           | Inbound emails list: bulk-select, per-row trash                  |
| GET /dashboard/inbound/trash     | Trashed inbound: bulk Restore / Delete-forever / Empty trash     |
| GET /dashboard/inbound/:id       | Inbound email detail + HTML preview                               |

## Design System

- **CSS:** Tailwind CSS via CDN
- **Dark mode:** Class-based (`darkMode: 'class'`), stored in `localStorage('bm-theme')`
- **Color palette:** Neutral grays: `gray-50` to `gray-950`
- **Cards:** `bg-white dark:bg-gray-900` with subtle borders
- **Status badges:** Muted colors (emerald for sent, amber for queued, blue for sending, red for failed)

## File Structure

```
src/pages/
├── pages.plugin.tsx          ← Plugin with all routes + session guard
├── session.ts                ← Session cookie read/set/clear (pure, unit-tested; sessions live in the users module)
├── landing.plugin.tsx        ← Public landing page at /
├── layouts/
│   └── base.tsx              ← HTML shell, Tailwind, sidebar nav
├── routes/
│   ├── login.tsx             ← Email + password login page (#216)
│   ├── setup.tsx             ← Owner setup form and invalid-link page (#215)
│   ├── home.tsx              ← Stats cards grid
│   ├── landing.tsx           ← Public marketing landing page
│   ├── not-found.tsx         ← Custom 404 page
│   ├── send-email.tsx        ← Compose & send email form
│   ├── emails.tsx            ← Email table with filters
│   ├── email-detail.tsx      ← Email detail view
│   ├── api-keys.tsx          ← API keys management
│   ├── domains.tsx           ← Domains management
│   ├── domain-detail.tsx     ← Domain verification status
│   ├── templates.tsx         ← Templates list + create
│   ├── template-detail.tsx   ← Template edit form
│   ├── webhooks.tsx          ← Webhooks list + create
│   ├── inbound.tsx           ← Inbound emails list (bulk-select + trash)
│   ├── inbound-detail.tsx    ← Inbound email detail + preview
│   ├── inbound-trash.tsx     ← Trashed inbound (Restore / Delete-forever / Empty)
│   └── emails-trash.tsx      ← Trashed outbound (Restore / Delete-forever / Empty)
└── components/
    ├── stats-card.tsx        ← Metric display card
    ├── status-badge.tsx      ← Status + verification badges
    ├── pagination.tsx        ← Page navigation
    ├── flash-message.tsx     ← Success/error banners
    ├── empty-state.tsx       ← Empty table placeholder
    └── time-display.tsx      ← <TimeDisplay> + hydration script (#104)
```

## Timestamps

Every timestamp on the dashboard goes through `<TimeDisplay value={date} />`
([src/pages/components/time-display.tsx](../src/pages/components/time-display.tsx)).
The server renders a `<time datetime>` element with a static UTC fallback;
a single hydration script in `BaseLayout` rewrites every such element on
load with relative-time text (`5m ago`, `Yesterday 14:32`, `Jan 5, 14:32`,
`Jan 5, 2024, 14:32`) in the **viewer's browser locale + timezone**.

The full absolute timestamp is always available via the `title` tooltip.
The component intentionally exposes no date-only format: the dashboard
never shows a bare date; every rendered value carries date and time.

When adding a new dashboard route that displays a timestamp:

```tsx
import { TimeDisplay } from "../components/time-display.tsx";

<TimeDisplay value={row.createdAt} />               // most cases
<TimeDisplay value={key.lastUsedAt} fallback="Never" />  // null-safe
```

Do not call `toLocaleString()` / `toLocaleDateString()` / `toISOString()`
directly in JSX: those run on the server and bake in the server's tz/locale.

## Form Actions

Dashboard uses standard HTML forms with POST actions. After each action the user is redirected back with a flash message in query params. A small client-side script (in the list pages) tracks checkbox state and toggles the bulk action bar visibility.

**General**
- Send email → `POST /dashboard/send`
- Create API key → `POST /dashboard/api-keys`
- Revoke API key → `POST /dashboard/api-keys/:id/revoke`
- Add domain → `POST /dashboard/domains`
- Delete domain → `POST /dashboard/domains/:id/delete` (hard delete; emails detach via `ON DELETE SET NULL`)
- Verify domain DNS → `POST /dashboard/domains/:id/verify`
- Create template → `POST /dashboard/templates`
- Edit template → `POST /dashboard/templates/:id/edit`
- Delete template → `POST /dashboard/templates/:id/delete`
- Create webhook → `POST /dashboard/webhooks`
- Delete webhook → `POST /dashboard/webhooks/:id/delete`

**Email trash**
- Move email to trash → `POST /dashboard/emails/:id/trash`
- Bulk move to trash → `POST /dashboard/emails/bulk-trash` (form fields: `ids`)
- Restore → `POST /dashboard/emails/:id/restore`
- Permanently delete → `POST /dashboard/emails/:id/permanent`
- Bulk restore → `POST /dashboard/emails/trash/bulk-restore` (uses `formaction` from the trash bar)
- Bulk permanent delete → `POST /dashboard/emails/trash/bulk-permanent`
- Empty trash → `POST /dashboard/emails/trash/empty`

**Inbound trash**: same shape under `/dashboard/inbound/...`.
