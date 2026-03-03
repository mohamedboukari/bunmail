# Dashboard

Server-rendered web UI for managing BunMail. Built with Elysia JSX (`@elysiajs/html` + `@kitajs/html`).

## Configuration

| Env Variable       | Required | Default       | Description                                  |
|--------------------|----------|---------------|----------------------------------------------|
| DASHBOARD_PASSWORD | No       | _(empty)_     | Password to access dashboard. Empty = disabled |
| SESSION_SECRET     | No       | random UUID   | Secret for HMAC session cookies              |

## Auth Flow

1. User visits `/dashboard` → redirected to `/dashboard/login`
2. Enters `DASHBOARD_PASSWORD` → validated with `crypto.timingSafeEqual`
3. On success: session cookie set (`bm_session=<timestamp>.<hmac>`)
4. Cookie: HttpOnly, SameSite=Lax, Path=/dashboard, Max-Age=24h
5. On subsequent requests: HMAC recomputed and verified, timestamp checked < 24h

If `DASHBOARD_PASSWORD` is not set, all dashboard routes show a "Dashboard disabled" page.

## Pages

| Route                            | Description                      |
|----------------------------------|----------------------------------|
| GET /dashboard/login             | Login form (standalone, no nav)  |
| GET /dashboard                   | Stats overview (cards grid)      |
| GET /dashboard/emails            | Email logs with status filters   |
| GET /dashboard/emails/:id        | Single email detail + preview    |
| GET /dashboard/api-keys          | API keys list + create form      |
| GET /dashboard/domains           | Domains list + add form          |
| GET /dashboard/domains/:id       | Domain detail + DNS status       |

## Design System

- **CSS:** Tailwind CSS via CDN
- **Dark mode:** Class-based (`darkMode: 'class'`), stored in `localStorage('bm-theme')`
- **Color palette:** Neutral grays — `gray-50` to `gray-950`
- **Cards:** `bg-white dark:bg-gray-900` with subtle borders
- **Status badges:** Muted colors (emerald for sent, amber for queued, blue for sending, red for failed)

## File Structure

```
src/pages/
├── pages.plugin.tsx          ← Plugin with all routes + session auth
├── layouts/
│   └── base.tsx              ← HTML shell, Tailwind, sidebar nav
├── routes/
│   ├── login.tsx             ← Login + dashboard disabled pages
│   ├── home.tsx              ← Stats cards grid
│   ├── emails.tsx            ← Email table with filters
│   ├── email-detail.tsx      ← Email detail view
│   ├── api-keys.tsx          ← API keys management
│   ├── domains.tsx           ← Domains management
│   └── domain-detail.tsx     ← Domain verification status
└── components/
    ├── stats-card.tsx        ← Metric display card
    ├── status-badge.tsx      ← Status + verification badges
    ├── pagination.tsx        ← Page navigation
    ├── flash-message.tsx     ← Success/error banners
    └── empty-state.tsx       ← Empty table placeholder
```

## Form Actions

Dashboard uses standard HTML forms with POST actions (no JavaScript required):
- Create API key → `POST /dashboard/api-keys`
- Revoke API key → `POST /dashboard/api-keys/:id/revoke`
- Add domain → `POST /dashboard/domains`
- Delete domain → `POST /dashboard/domains/:id/delete`

After each action, the user is redirected back with a flash message in query params.
