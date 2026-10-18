# Dashboard

Server-rendered web UI for managing BunMail. Built with Elysia JSX (`@elysiajs/html` + `@kitajs/html`).

## Configuration

| Env Variable                       | Required | Default       | Description                                  |
|------------------------------------|----------|---------------|----------------------------------------------|
| BUNMAIL_OWNER_EMAIL                | **Prod** | _(empty)_     | Email of the dashboard owner account (#215), stored lowercased. **Required when `BUNMAIL_ENV=production`** (app refuses to start when it is unset); a malformed address or one over 254 characters is refused in every environment; unset in dev skips the owner bootstrap with a warning. See [Owner setup](#owner-setup-215). |
| DASHBOARD_PASSWORD                 | No       | _(empty)_     | Password to access dashboard. Empty = disabled. Still the login until account login ships (#216) |
| SESSION_SECRET                     | **Prod** | random UUID   | HMAC key for session cookies. **Required when `BUNMAIL_ENV=production`** (app refuses to start without it); random per-process in dev. Generate with `openssl rand -hex 32`. |
| DASHBOARD_TRUSTED_PROXY_HOPS       | No       | `0`           | Trusted reverse-proxy hops in front of BunMail, used to resolve the real client IP for login rate limiting. `0` = trust only the raw socket IP. Set to `1` behind a single nginx/Caddy/Cloudflare (`N` for `N` chained proxies). |
| DASHBOARD_LOGIN_RATE_LIMIT_ENABLED | No       | `true`        | Master switch for login brute-force protection |
| DASHBOARD_LOGIN_RATE_LIMIT_MAX     | No       | `5`           | Failed attempts per IP per window before lockout |
| DASHBOARD_LOGIN_RATE_LIMIT_WINDOW  | No       | `900`         | Lockout window in seconds (default 15 minutes) |

## Auth Flow

1. User visits `/dashboard` → redirected to `/dashboard/login`
2. Enters `DASHBOARD_PASSWORD` → validated with `crypto.timingSafeEqual`
3. On success: session cookie set (`bm_session=<timestamp>.<hmac>`)
4. Cookie: HttpOnly, SameSite=Lax, Path=/dashboard, Max-Age=24h
5. On subsequent requests: HMAC recomputed and verified, timestamp checked < 24h

If `DASHBOARD_PASSWORD` is not set, all dashboard routes show a "Dashboard disabled" page.

### Owner setup (#215)

On first boot BunMail creates the owner account for `BUNMAIL_OWNER_EMAIL` and logs a one-time link at `warn` (at `error` when `LOG_LEVEL=error`) (`Owner setup link`): `<APP_BASE_URL>/dashboard/setup?token=...`, or `http://localhost:PORT/...` (with a `hint` field) when `APP_BASE_URL` is unset or not an `http(s)://` URL. The link is single use and valid for 24 hours; until setup is done each restart replaces it, so only the most recent link works. `bun run src/db/reset-owner.ts` (in Docker: `docker compose exec app bun run src/db/reset-owner.ts`) prints a fresh one.

1. `GET /dashboard/setup?token=...` is public (registered before the session guard, and also in its skip list). It only reads the token: a missing, malformed, unknown, expired, used or replaced token gets the same `400` "invalid link" page, which never echoes the token (missing and malformed tokens are rejected before any database call). A `token` longer than 128 characters, or a repeated `token` parameter, fails the route's schema instead and gets the global `422` JSON error.
2. A live token renders the form (`200`): the owner email, a hidden token field, password and confirmation (15 to 256 characters, counted in code points).
3. `POST /dashboard/setup` (form fields `token`, `password`, `confirm`) checks same-origin itself first, since the guard's CSRF check does not run on public routes: a cross-origin `Origin`/`Referer`, or neither header, gets `403` `Forbidden: cross-origin request rejected` and a `warn` log (`Owner setup POST rejected: cross-origin (possible CSRF)`). Then the token (the same `400` invalid page), then the password policy (a policy error re-renders the form with `200`, no hashing and no write), then it spends the token and stores the argon2id password hash. A token spent by a concurrent submission in between also gets the `400` invalid page.
4. On success the server logs `Owner setup completed` at `warn` (`owner` through `redactEmail`, client `ip`). The owner is signed in with the same `bm_session` cookie `POST /dashboard/login` issues (both use `issueLegacySession`), and redirected (`302`) to `/dashboard`. When `DASHBOARD_PASSWORD` is empty the dashboard is disabled, so an "Owner password saved" page is shown instead (`200`) and no cookie is set.

Every response from the setup handlers, including the `403` and `302` (but not a `422` schema rejection, which never reaches the handler), sends `Cache-Control: no-store`, `Referrer-Policy: strict-origin` (the pages also carry a matching meta tag; a `Referer` carries the origin only, never the token URL, and `no-referrer` would make browsers send `Origin: null` on the form POST, which the same-origin check rejects), `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY`.

**Interim (until #216):** the stored owner password is not used by `/dashboard/login` yet; `DASHBOARD_PASSWORD` stays the login. Sessions from either path are the stateless HMAC cookie and end only on expiry (24 h) or a `SESSION_SECRET` rotation. Internals: [docs/users.md](users.md#owner-bootstrap-215).

### Brute-force protection (#109)

`POST /dashboard/login` throttles failed password attempts per client IP using
an in-memory sliding window (`src/middleware/login-rate-limit.ts`). After
`DASHBOARD_LOGIN_RATE_LIMIT_MAX` failures within
`DASHBOARD_LOGIN_RATE_LIMIT_WINDOW` seconds, further attempts from that IP get
HTTP `429` with a `Retry-After` header until the window expires; a successful
login clears the counter.

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
| GET /dashboard/login             | Login form (standalone, no nav)                                   |
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
├── pages.plugin.tsx          ← Plugin with all routes + session auth
├── session.ts                ← Session cookie sign/validate (pure, unit-tested)
├── landing.plugin.tsx        ← Public landing page at /
├── layouts/
│   └── base.tsx              ← HTML shell, Tailwind, sidebar nav
├── routes/
│   ├── login.tsx             ← Login + dashboard disabled pages
│   ├── setup.tsx             ← Owner setup form, invalid-link and done pages (#215)
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
