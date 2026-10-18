# BunMail Architecture

> Self-hosted email API for developers. No SendGrid. No limits. No cost.

---

## System Overview

```
                        ┌─────────────────────────────────┐
                        │         Your Application        │
                        └────────────────┬────────────────┘
                                         │ POST /api/v1/emails/send
                                         │ Authorization: Bearer <API_KEY>
                                         ▼
┌────────────────────────────────────────────────────────────────────┐
│                         BunMail Server                             │
│                                                                    │
│  ┌──────────────┐    ┌──────────────┐    ┌───────────────────┐     │
│  │  Elysia API  │───▶│   Services   │───▶│    PostgreSQL     │     │
│  │  (Routes)    │    │  (Business   │    │    (Drizzle ORM)  │     │
│  │              │    │   Logic)     │    │                   │     │
│  └──────────────┘    └──────┬───────┘    └───────────────────┘     │
│         │                   │                                      │
│         │                   ▼                                      │
│  ┌──────────────┐    ┌──────────────┐    ┌───────────────────┐     │
│  │  Middleware  │    │ Email Queue  │───▶│  Nodemailer SMTP  │     │
│  │  - Auth      │    │ (backoff)    │    │  (direct to MX)   │     │
│  │  - Rate Limit│    │              │    │  + DKIM Signing   │     │
│  └──────────────┘    └──────────────┘    └────────┬──────────┘     │
│                                                    │               │
│  ┌──────────────┐                                  │               │
│  │   Pages      │    JSX server-rendered           │               │
│  │  /dashboard  │    via @elysiajs/html            │               │
│  └──────────────┘                                  │               │
│                                                    │               │
└────────────────────────────────────────────────────┼───────────────┘
                                                     │
                                                     ▼
                                          ┌────────────────────┐
                                          │  Recipient's MX    │
                                          │  Server (Gmail,    │
                                          │  Outlook, etc.)    │
                                          └────────────────────┘
```

---

## Tech Stack

| Layer            | Technology                          |
|------------------|-------------------------------------|
| Runtime          | Bun                                 |
| Backend          | Elysia                              |
| SMTP Sending     | Nodemailer, one transport per recipient MX on port 25, no relay |
| Email Auth       | DKIM signing (AES-256-GCM at rest), SPF/DMARC DNS checks |
| Database         | PostgreSQL                          |
| ORM              | Drizzle ORM (`drizzle-orm/bun-sql`) |
| Dashboard        | Elysia JSX (`@elysiajs/html`)       |
| Deployment       | Docker + Docker Compose             |

---

## Project Structure

```
bunmail/
├── ARCHITECTURE.md
├── CLAUDE.md
├── BunMail-Plan.md
├── README.md
├── package.json
├── tsconfig.json
├── bunfig.toml
├── drizzle.config.ts
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── .gitignore
├── drizzle/                              ← Generated migrations
├── src/
│   ├── index.ts                          ← Elysia app entry point
│   ├── config.ts                         ← Env config with validation
│   ├── db/
│   │   ├── index.ts                      ← Drizzle DB connection
│   │   ├── schema.ts                     ← Re-exports all model schemas
│   │   ├── migrate.ts                    ← Bun-native migration runner (#56)
│   │   ├── encrypt-domain-keys.ts        ← Boot-time pass that encrypts legacy plaintext DKIM keys (#23)
│   │   └── reset-owner.ts                ← Shell-only recovery: prints a fresh owner setup link (#215)
│   ├── middleware/
│   │   ├── request-context.ts            ← Request ID, X-Request-Id and the per-request log line (#284)
│   │   ├── security-headers.ts           ← CSP (page policy on / and /dashboard, baseline elsewhere), nosniff, X-Frame-Options, Referrer-Policy, HSTS, dashboard no-store (#255)
│   │   ├── auth.ts                       ← API key bearer auth
│   │   ├── rate-limit.ts                 ← Per-API-key rate limiter: Elysia wiring + cleanup timer
│   │   ├── rate-limit-core.ts            ← Pure fixed-window algorithm (unit-tested, #174)
│   │   └── login-rate-limit.ts           ← Per-IP dashboard login brute-force limiter (#109)
│   ├── utils/
│   │   ├── id.ts                         ← Prefixed ID generator
│   │   ├── logger.ts                     ← Structured JSON logger: adds the log context, redacts secret-named fields (#284)
│   │   ├── log-context.ts                ← Request/job/SMTP-session correlation IDs on AsyncLocalStorage (#284)
│   │   ├── redact.ts                     ← PII-aware email redaction for logs (#33)
│   │   └── crypto.ts                     ← API key hashing + AES-256-GCM encryptSecret/decryptSecret (#23)
│   ├── modules/
│   │   ├── api-plugins.ts                ← Every REST API plugin, mounted by index.ts and the authz matrix test (#228)
│   │   ├── emails/
│   │   │   ├── emails.plugin.ts          ← POST /send, GET /emails
│   │   │   ├── errors.ts                 ← Typed send rejections with status + code (#245)
│   │   │   ├── services/
│   │   │   │   ├── email.service.ts      ← Email CRUD + trash/restore
│   │   │   │   ├── sender-domain.service.ts ← Sender-domain gate + warnings, REQUIRE_VERIFIED_DOMAIN (#245)
│   │   │   │   ├── mailer.service.ts     ← Nodemailer transport + DKIM
│   │   │   │   ├── queue.service.ts      ← Queue processor + retries
│   │   │   │   └── stats.service.ts      ← Dashboard stats aggregation
│   │   │   ├── dtos/
│   │   │   │   ├── send-email.dto.ts
│   │   │   │   └── list-emails.dto.ts
│   │   │   ├── models/
│   │   │   │   └── email.schema.ts       ← emails pgTable
│   │   │   ├── serializations/
│   │   │   │   └── email.serialization.ts
│   │   │   └── types/
│   │   │       └── email.types.ts
│   │   ├── api-keys/
│   │   │   ├── api-keys.plugin.ts        ← CRUD routes
│   │   │   ├── services/
│   │   │   │   └── api-key.service.ts
│   │   │   ├── dtos/
│   │   │   │   └── create-api-key.dto.ts
│   │   │   ├── models/
│   │   │   │   └── api-key.schema.ts     ← api_keys pgTable
│   │   │   ├── serializations/
│   │   │   │   └── api-key.serialization.ts
│   │   │   └── types/
│   │   │       └── api-key.types.ts
│   │   ├── domains/
│   │   │   ├── domains.plugin.ts         ← CRUD + verify routes
│   │   │   ├── services/
│   │   │   │   ├── domain.service.ts     ← CRUD + DKIM key generation
│   │   │   │   ├── domain-dkim.service.ts ← DKIM options for out-of-queue mail (inbound notify, invitations, #217)
│   │   │   │   └── dns-verification.service.ts ← SPF/DKIM/DMARC checks
│   │   │   ├── dtos/
│   │   │   │   └── create-domain.dto.ts
│   │   │   ├── models/
│   │   │   │   └── domain.schema.ts      ← domains pgTable
│   │   │   ├── serializations/
│   │   │   │   └── domain.serialization.ts
│   │   │   └── types/
│   │   │       └── domain.types.ts
│   │   ├── webhooks/
│   │   │   ├── webhooks.plugin.ts                 ← CRUD + deliveries inspection + replay
│   │   │   ├── services/
│   │   │   │   ├── webhook.service.ts             ← CRUD
│   │   │   │   ├── webhook-dispatch.service.ts    ← Enqueues into webhook_deliveries (#30)
│   │   │   │   ├── webhook-delivery.service.ts    ← Claim / send / reschedule / replay (#30)
│   │   │   │   └── webhook-delivery-worker.service.ts ← Poll loop + retention cleanup (#30)
│   │   │   ├── dtos/
│   │   │   │   ├── create-webhook.dto.ts
│   │   │   │   └── list-deliveries.dto.ts         (#30)
│   │   │   ├── models/
│   │   │   │   ├── webhook.schema.ts              ← webhooks pgTable
│   │   │   │   └── webhook-delivery.schema.ts     ← webhook_deliveries pgTable (#30)
│   │   │   ├── serializations/
│   │   │   │   ├── webhook.serialization.ts
│   │   │   │   └── webhook-delivery.serialization.ts (#30)
│   │   │   └── types/
│   │   │       └── webhook.types.ts
│   │   ├── templates/
│   │   │   ├── templates.plugin.ts       ← CRUD routes
│   │   │   ├── services/
│   │   │   │   └── template.service.ts   ← CRUD + renderTemplate()
│   │   │   ├── dtos/
│   │   │   │   └── create-template.dto.ts
│   │   │   ├── models/
│   │   │   │   └── template.schema.ts    ← templates pgTable
│   │   │   ├── serializations/
│   │   │   │   └── template.serialization.ts
│   │   │   └── types/
│   │   │       └── template.types.ts
│   │   ├── inbound/
│   │   │   ├── inbound.plugin.ts         ← Routes: list, get, trash/restore/permanent/empty
│   │   │   ├── services/
│   │   │   │   ├── smtp-receiver.service.ts ← SMTP server (smtp-server)
│   │   │   │   └── inbound.service.ts    ← Reads + trash/restore/permanent
│   │   │   ├── models/
│   │   │   │   └── inbound-email.schema.ts ← inbound_emails pgTable
│   │   │   ├── serializations/
│   │   │   │   └── inbound.serialization.ts
│   │   │   └── types/
│   │   │       └── inbound.types.ts
│   │   ├── smtp-submission/                ← AUTH-required SMTP relay for apps to send THROUGH BunMail (#120)
│   │   │   ├── smtp-submission.plugin.ts    ← Route: GET /stats (usage + quota, #123)
│   │   │   ├── services/
│   │   │   │   ├── smtp-submission.service.ts ← SMTP server (AUTH) → createEmail; start()/stop()
│   │   │   │   └── usage.service.ts         ← per-(key,day) usage counters + quota read (#123)
│   │   │   ├── message-mapper.ts           ← pure message → SendEmailInput mapping (BCC-aware)
│   │   │   ├── dtos/                        ← stats-query.dto
│   │   │   ├── models/
│   │   │   │   └── smtp-submission-usage.schema.ts ← smtp_submission_usage pgTable (#123)
│   │   │   └── serializations/
│   │   │       └── stats.serialization.ts
│   │   ├── trash/
│   │   │   └── services/
│   │   │       └── purge.service.ts      ← Periodic auto-purge of trashed rows (+ expired sessions, #216)
│   │   ├── suppressions/                 ← Per-API-key send-time suppression list (#25)
│   │   │   ├── suppressions.plugin.ts    ← POST/GET/GET-:id/DELETE-:id under /api/v1/suppressions
│   │   │   ├── services/
│   │   │   │   └── suppression.service.ts ← isSuppressed gate + create/list/delete + addFromBounce hook
│   │   │   ├── dtos/                     ← create-suppression.dto, list-suppressions.dto
│   │   │   ├── models/
│   │   │   │   └── suppression.schema.ts ← suppressions pgTable
│   │   │   ├── serializations/
│   │   │   │   └── suppression.serialization.ts
│   │   │   ├── errors.ts                 ← SuppressedRecipientError → mapped to 422 in onError
│   │   │   └── types/
│   │   │       └── suppression.types.ts
│   │   ├── bounces/                      ← DSN parsing + bounce → suppression chain (#24)
│   │   │   ├── services/
│   │   │   │   ├── bounce-parser.service.ts  ← Pure RFC 3464 + regex fallback parser
│   │   │   │   └── bounce-handler.service.ts ← Lookup, escalation, suppress, mark bounced, webhook
│   │   │   └── types/
│   │   │       └── bounce.types.ts
│   │   ├── users/                        ← Dashboard accounts schema (#214), owner bootstrap (#215), login + sessions (#216), invitations (#217), account management (#218), reset links (#277), password change (#279), active sessions (#281), new-device alerts (#282), record ownership (#219)
│   │   │   ├── models/                   ← users, user_credentials, sessions, user_tokens, user_devices (#282)
│   │   │   ├── services/                 ← password.service.ts (argon2id), token.service.ts (SHA-256 tokens),
│   │   │   │                               owner.service.ts (bootstrap / reset / setup, advisory lock),
│   │   │   │                               owner-setup-policy.service.ts (pure: TTL, token format, password policy, URL),
│   │   │   │                               login.service.ts (email + password, one argon2id verify per branch),
│   │   │   │                               session.service.ts (create / look up / rotate / revoke / sweep / list own sessions, #281),
│   │   │   │                               session-location.service.ts (background location lookup after sign-in, #281),
│   │   │   │                               geoip.service.ts (approximate location: offline .mmdb or opt-in ipinfo, #281),
│   │   │   │                               user-agent.service.ts (pure: "Chrome on macOS" device label, #281),
│   │   │   │                               session-policy.service.ts (pure: lifetimes, input bounds, IP / user agent),
│   │   │   │                               invite.service.ts (create / resend / revoke / list / accept, per-address advisory lock),
│   │   │   │                               invite-policy.service.ts (pure: who grants which role, name, expiry, URL),
│   │   │   │                               system-mail.service.ts (BunMail's own mail from SYSTEM_MAIL_FROM, DKIM-signed, #282),
│   │   │   │                               invite-email.service.ts (invitation email, via system-mail),
│   │   │   │                               device-policy.service.ts (pure: 30-day known window, 400-day retention, #282),
│   │   │   │                               user-device.service.ts (record a sign-in's browser in user_devices, sweep, #282),
│   │   │   │                               sign-in-device.service.ts (background new-device check after login, #282),
│   │   │   │                               new-device-alert.service.ts (new sign-in alert email, no links, #282),
│   │   │   │                               user-admin.service.ts (role change / deactivate / reactivate / remove / transfer / reset link, owner lock),
│   │   │   │                               user-admin-policy.service.ts (pure: who may act on whom, which buttons),
│   │   │   │                               password-reset.service.ts (mint / look up / complete reset links, owner lock, #277),
│   │   │   │                               password-reset-policy.service.ts (pure: one-hour TTL, URL, #277),
│   │   │   │                               password-change.service.ts (verify, then replace + sign out everywhere, owner lock, #279),
│   │   │   │                               password-change-policy.service.ts (pure: change form rules, #279),
│   │   │   │                               record-ownership.service.ts (owner backfill, transfer moves, disabling or downgrading a user's keys, #219)
│   │   │   └── types/                    ← role / credential / assurance / purpose / invite value sets
│   │   └── dmarc-reports/                ← DMARC `rua` aggregate report ingest (#41)
│   │       ├── dmarc-reports.plugin.ts   ← Routes: list + get
│   │       ├── services/
│   │       │   ├── dmarc-parser.service.ts   ← Pure XML/gzip/zip parser + heuristic
│   │       │   ├── dmarc-handler.service.ts  ← Persist with ON CONFLICT dedup
│   │       │   └── dmarc-reports.service.ts  ← Read queries (list / get / domains)
│   │       ├── dtos/
│   │       │   └── list-dmarc-reports.dto.ts
│   │       ├── models/
│   │       │   ├── dmarc-report.schema.ts    ← dmarc_reports pgTable
│   │       │   └── dmarc-record.schema.ts    ← dmarc_records pgTable (FK CASCADE)
│   │       ├── serializations/
│   │       │   └── dmarc-report.serialization.ts
│   │       └── types/
│   │           └── dmarc-report.types.ts
│   └── pages/                            ← Dashboard (presentation layer)
│       ├── pages.plugin.tsx              ← Parent plugin for /dashboard: public routes, session guard, then the area plugins (#291)
│       ├── plugins/                      ← One functional plugin per dashboard area (auth, home, account, emails, api-keys, invitations, users, domains, templates, webhooks, inbound, dmarc, suppressions)
│       ├── lib/                          ← Shared dashboard helpers: session guard, session cookie, same-origin check, redirect/flash, record ownership
│       ├── guards.tsx                    ← Per-route role and assurance checks (#222)
│       ├── reveal-store.ts               ← One-time secret reveal (keys, webhook secrets, invitation and reset links) bound to kind, user and session (#132, #280, #217, #277)
│       ├── session.ts                    ← Session cookie read/set/clear (pure, #174, #216)
│       ├── viewer.ts                     ← Request-scoped viewer role, so the nav hides admin-only links (#218)
│       ├── landing.plugin.tsx            ← Public landing page at /
│       ├── static-assets.tsx             ← Serves dashboard.css / dashboard.js with a content-hash ?v= and a 1-year cache (#255)
│       ├── assets/
│       │   ├── dashboard.input.css       ← Tailwind v4 source; `bun run build:css` writes dashboard.css (gitignored, built in Docker) (#255)
│       │   ├── dashboard.js              ← The only script: theme, confirms, bulk select, chip inputs, time display, previews (#255)
│       │   └── icons.tsx                 ← Inline SVG icons
│       ├── layouts/
│       │   └── base.tsx                  ← HTML shell + self-hosted CSS/JS + nav (admin-only links by viewer role, #218; Change password for every role, #279)
│       ├── routes/
│       │   ├── login.tsx                 ← Email + password login form (standalone, no nav, #216)
│       │   ├── setup.tsx                 ← Owner setup form + invalid-link page (standalone, #215)
│       │   ├── invite.tsx                ← Invitation accept form + invalid-link / account-exists pages (standalone, #217)
│       │   ├── invitations.tsx           ← Invitations: invite form, pending list, one-time link (#217)
│       │   ├── users.tsx                 ← Users: accounts, role change, deactivate, remove, transfer (#218), reset link (#277)
│       │   ├── reset.tsx                 ← Password reset form + invalid-link page (standalone, #277)
│       │   ├── account-password.tsx      ← Change password form for the signed-in user (#279)
│       │   ├── home.tsx                  ← Stats overview (cards grid)
│       │   ├── landing.tsx               ← Public marketing page
│       │   ├── not-found.tsx             ← Custom 404 page
│       │   ├── forbidden.tsx             ← 403 page for a role or session assurance too low (#222)
│       │   ├── send-email.tsx            ← Compose & send email form
│       │   ├── emails.tsx                ← Email logs table + filters
│       │   ├── email-detail.tsx          ← Single email view
│       │   ├── api-keys.tsx              ← API keys list + create + revoke
│       │   ├── domains.tsx               ← Domains list + add + delete
│       │   ├── domain-detail.tsx         ← Domain verification status
│       │   ├── templates.tsx             ← Templates list + create
│       │   ├── template-detail.tsx       ← Template edit form
│       │   ├── webhooks.tsx              ← Webhooks list + create
│       │   ├── inbound.tsx               ← Inbound emails list (bulk-select + trash)
│       │   ├── inbound-detail.tsx        ← Inbound email detail + preview
│       │   ├── inbound-trash.tsx         ← Trashed inbound view
│       │   ├── emails-trash.tsx          ← Trashed outbound view
│       │   ├── email-tombstones.tsx      ← Post-purge audit snapshots + Message-ID search (#34)
│       │   ├── webhook-deliveries.tsx    ← Delivery history of one webhook (#30)
│       │   ├── webhook-delivery-detail.tsx ← Delivery detail + replay (#30)
│       │   ├── suppressions.tsx          ← Suppressions across every API key (#89)
│       │   ├── dmarc-reports.tsx         ← DMARC reports list + domain filter (#41)
│       │   └── dmarc-report-detail.tsx   ← DMARC report detail (per-source-IP, #41)
│       └── components/
│           ├── stats-card.tsx            ← Stat card (label, value, accent)
│           ├── status-badge.tsx          ← Status + verification badges
│           ├── pagination.tsx            ← Prev/Next page links
│           ├── flash-message.tsx         ← Success/error banner
│           └── empty-state.tsx           ← "No data yet" placeholder
├── test/
│   ├── setup.ts                          ← Global preload (env vars, mocks)
│   ├── unit/                             ← Pure unit tests, no DB / network
│   ├── e2e/                              ← Plugin-level tests with mocked services
│   └── integration/                      ← Real Postgres tests (#70)
│       ├── _preload.ts                   ← Locks DATABASE_URL to bunmail_test
│       ├── _helpers.ts                   ← truncateAll, seed factories
│       ├── setup-db.ts                   ← One-shot: create bunmail_test + migrate
│       └── *.integration.test.ts         ← One file per service or feature
```

See [docs/testing.md](docs/testing.md) for the three-tier strategy + how to run each.

---

## Module Architecture

Each feature module follows this pattern:

```
src/modules/<feature>/
├── <feature>.plugin.ts     ← Elysia plugin (route group under /api/v1/<feature>)
├── services/               ← Business logic (only layer that touches DB)
├── dtos/                   ← Request/response validation schemas (Elysia t.Object)
├── models/                 ← Drizzle pgTable schemas
├── serializations/         ← Response mappers (hide internals, format output)
└── types/                  ← TypeScript types local to this module
```

The `src/pages/` folder is separate from modules: it's a presentation layer that consumes module services to render server-side JSX pages. It has no DTOs, models, or business logic of its own.

**Rules:**
- Route handlers are thin: they call services and return serialized responses
- Only services access the database
- DTOs and serializers are feature-local (no cross-module imports)
- Types stay local unless used in 3+ modules
- Pages import services but never the other way around

---

## Request Flow

```
Client Request
     │
     ▼
┌─────────────┐
│  Rate Limit │  ← In-memory fixed window (100 req/min per API key)
│  Middleware │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│    Auth     │  ← Bearer token → SHA-256 hash → DB lookup
│  Middleware │  ← Derives `apiKey` into request context
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   Route     │  ← Validates request body/params via DTOs
│   Handler   │  ← Calls service method
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   Service   │  ← Business logic + DB operations
│             │  ← Returns domain objects
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ Serializer  │  ← Maps domain objects → API response shape
└──────┬──────┘
       │
       ▼
  JSON Response
```

---

## Email Queue Architecture

The queue is DB-driven for crash recovery with an in-memory poll loop.

```
┌─────────────────────────────────────────────────────────────────┐
│  Queue Processor (self-scheduling poll, every 2 s +/-10%, #176) │
│  0. FREE SLOTS: QUEUE_MAX_CONCURRENT_SENDS (10) - in flight;    │
│     none free → claim nothing. Polls never overlap.             │
│                                                                 │
│  1. ATOMIC CLAIM (#20, leases #180):                            │
│     UPDATE emails SET status = 'sending',                       │
│                       attempts = attempts + 1,                  │
│                       locked_by = <worker>,                     │
│                       lease_until = now() + 15 min              │
│     WHERE id IN (                                               │
│       SELECT id FROM emails WHERE deleted_at IS NULL AND (      │
│         (status = 'queued' AND next_attempt_at <= now())        │
│         OR (status = 'sending' AND lease_until < now()))        │
│       ORDER BY next_attempt_at LIMIT min(batch 5, free slots)   │
│       FOR UPDATE SKIP LOCKED   ← concurrent-safe                │
│     ) RETURNING *;                                              │
│                                                                 │
│  2. For each claimed row, in the background (not awaited):      │
│     ┌───────────────────────────────────────┐                   │
│     │ a. Call mailerService.sendMail()      │                   │
│     │    (Nodemailer per-MX + DKIM)         │                   │
│     │                                       │                   │
│     │ b. On SUCCESS:                        │                   │
│     │    status = 'sent', sentAt = now()    │                   │
│     │                                       │                   │
│     │ c. On TEMPORARY FAILURE:              │                   │
│     │    status = 'queued',                 │                   │
│     │    next_attempt_at = now() + backoff  │                   │
│     │    (5m,15m,30m,1h,2h, then every 4h)  │                   │
│     │    until the email is 48 h old, then  │                   │
│     │    status = 'failed'                  │                   │
│     │                                       │                   │
│     │ d. Every outcome clears the lease,    │                   │
│     │    only if this worker still holds it │                   │
│     └───────────────────────────────────────┘                   │
│                                                                 │
│  While sending: the lease is renewed every minute. A dead       │
│  worker's rows are reclaimed once their lease expires.          │
└─────────────────────────────────────────────────────────────────┘
```

`FOR UPDATE SKIP LOCKED` makes the claim safe under concurrency: two workers running the same statement at the same time get **disjoint** result sets: never the same row twice. Single-instance today, but the queue is no longer the blocker for horizontal scaling. (#20)

**Email Status Flow:**

```
queued → sending → sent → bounced  ← async DSN arrives later (#24)
                 → bounced          ← inline 5xx during SMTP transaction (#68)
                                     auto-suppress + stop retrying on attempt 1
                 → failed (soft 4xx or infra error until the email is MAIL_RETRY_MAX_AGE_HOURS old)
         ↘ queued (retry after a backoff on soft 4xx or infrastructure error)
```

`sent` = recipient's MX accepted the SMTP transaction. `bounced` = recipient confirmed permanently unreachable, either inline (`550 5.1.1 ...` during the send, #68) or via a DSN that came back later (#24). Both paths auto-suppress and fire `email.bounced` with `source: "inline"` vs `"rfc3464"` / `"fallback"`. `failed` = soft 4xx or infrastructure error exhausted retries: we never confirmed reachability either way.

The queue selector also filters `deleted_at IS NULL` so rows trashed while still queued are skipped instead of being sent.

---

## Trash & Auto-Purge

Both `emails` and `inbound_emails` use a `deleted_at` soft-delete marker. Setting `deleted_at = NOW()` moves a row to trash; clearing it restores. All read paths filter `deleted_at IS NULL` so trashed rows are invisible to the normal API and dashboard until they're explicitly accessed via `/trash` endpoints.

```
┌─────────────────────────────────────────────────────────┐
│ Trash Purge (setInterval, every 6 hours, also on boot)  │
│                                                         │
│   cutoff = NOW() - TRASH_RETENTION_DAYS                 │
│                                                         │
│   DELETE FROM emails                                    │
│     WHERE deleted_at IS NOT NULL                        │
│       AND deleted_at < cutoff                           │
│                                                         │
│   DELETE FROM inbound_emails                            │
│     WHERE deleted_at IS NOT NULL                        │
│       AND deleted_at < cutoff                           │
└─────────────────────────────────────────────────────────┘
```

`TRASH_RETENTION_DAYS` is configurable via env (default `7`). The purge runs once on boot to catch anything that aged out while the server was offline.

The same loop also deletes expired dashboard sessions (`runSessionSweep` → `purgeExpiredSessions`, #216: `DELETE FROM sessions WHERE expires_at < now()`, logged as `Expired session sweep completed`). Housekeeping only: the session guard enforces expiry itself. It also deletes sign-in devices not seen for 400 days (`runDeviceSweep` → `purgeStaleUserDevices`, #282, logged as `Stale sign-in device sweep completed`).

---

## Database Schema

### `emails`

| Column        | Type           | Constraints                     |
|---------------|----------------|---------------------------------|
| id            | varchar(36)    | PK, prefixed `msg_`             |
| api_key_id    | varchar(36)    | FK → api_keys.id, NOT NULL      |
| domain_id     | varchar(36)    | FK → domains.id, nullable       |
| from_address  | varchar(255)   | NOT NULL                        |
| to_address    | varchar(255)   | NOT NULL                        |
| cc            | text           | nullable                        |
| bcc           | text           | nullable                        |
| reply_to      | text           | nullable                        |
| headers       | jsonb          | nullable: custom headers, name to value (#177) |
| subject       | varchar(500)   | NOT NULL                        |
| html          | text           | nullable                        |
| text_content  | text           | nullable                        |
| status        | varchar(20)    | NOT NULL, default `'queued'`    |
| source        | varchar(10)    | NOT NULL, default `'api'` (`api`\|`smtp`, #137) |
| attempts      | integer        | NOT NULL, default `0`           |
| next_attempt_at | timestamptz  | NOT NULL, default `now()`: retry backoff (#180) |
| locked_by     | varchar(64)    | nullable: worker holding a `sending` row (#180) |
| lease_until   | timestamptz    | nullable: claim expiry while `sending` (#180) |
| last_error    | text           | nullable                        |
| message_id    | varchar(255)   | nullable (SMTP Message-ID)      |
| sent_at       | timestamp      | nullable                        |
| created_at    | timestamp      | NOT NULL, default `now()`       |
| updated_at    | timestamp      | NOT NULL, default `now()`       |
| deleted_at    | timestamp      | nullable (soft-delete marker)   |

`domain_id` uses `ON DELETE SET NULL` so deleting a domain detaches its emails rather than blocking. `deleted_at` is set when an email is moved to trash; rows with `deleted_at` older than `TRASH_RETENTION_DAYS` are auto-purged by `trash/services/purge.service.ts`.

### `api_keys`

| Column       | Type           | Constraints                     |
|--------------|----------------|---------------------------------|
| id           | varchar(36)    | PK, prefixed `key_`             |
| name         | varchar(100)   | NOT NULL                        |
| key_hash     | varchar(255)   | NOT NULL, UNIQUE                |
| key_prefix   | varchar(12)    | NOT NULL                        |
| is_active    | boolean        | NOT NULL, default `true`        |
| is_admin     | boolean        | NOT NULL, default `false`: admin (management plane) vs restricted / send-only (#130); operator-set only |
| allowed_senders | jsonb       | NOT NULL, default `[]`: `From` allowlist (#126); empty = unrestricted |
| last_used_at | timestamp      | nullable                        |
| created_at   | timestamp      | NOT NULL, default `now()`       |
| created_by_user_id | varchar(36) | nullable, FK → users.id `ON DELETE SET NULL`, indexed: the user it belongs to (#219); NULL = the owner |
| disabled_reason | varchar(20) | nullable, CHECK `revoked` / `creator_deactivated` / `creator_removed`: why an inactive key is inactive (#219) |

### `domains`

| Column            | Type           | Constraints                  |
|-------------------|----------------|------------------------------|
| id                | varchar(36)    | PK, prefixed `dom_`          |
| name              | varchar(255)   | NOT NULL, UNIQUE             |
| dkim_private_key  | text           | nullable; AES-256-GCM encrypted at rest (#23) |
| dkim_public_key   | text           | nullable                     |
| dkim_selector     | varchar(63)    | NOT NULL, default `'bunmail'`|
| unsubscribe_email | varchar(255)   | nullable; per-domain mailto override for `List-Unsubscribe` (#40) |
| unsubscribe_url   | text           | nullable; per-domain URL form for `List-Unsubscribe` + One-Click POST (#40) |
| notify_email      | varchar(255)   | nullable; address notified on inbound mail for this domain (#106) |
| spf_verified      | boolean        | NOT NULL, default `false`    |
| dkim_verified     | boolean        | NOT NULL, default `false`    |
| dmarc_verified    | boolean        | NOT NULL, default `false`    |
| verified_at       | timestamp      | nullable                     |
| created_at        | timestamp      | NOT NULL, default `now()`    |
| updated_at        | timestamp      | NOT NULL, default `now()`    |
| created_by_user_id | varchar(36) | nullable, FK → users.id `ON DELETE SET NULL`, indexed: the user it belongs to (#219); NULL = the owner |

### `webhooks`

| Column       | Type           | Constraints                     |
|--------------|----------------|---------------------------------|
| id           | varchar(36)    | PK, prefixed `whk_`            |
| api_key_id   | varchar(36)    | FK → api_keys.id, NOT NULL, indexed (#173) |
| url          | text           | NOT NULL                        |
| events       | jsonb          | NOT NULL, default `[]`          |
| secret       | varchar(255)   | NOT NULL, encrypted at rest (#259) |
| is_active    | boolean        | NOT NULL, default `true`        |
| created_at   | timestamp      | NOT NULL, default `now()`       |
| updated_at   | timestamp      | NOT NULL, default `now()`       |
| created_by_user_id | varchar(36) | nullable, FK → users.id `ON DELETE SET NULL`, indexed: the user it belongs to (#219); NULL = the owner |

### `email_tombstones` (#34)

Post-purge audit trail. Every hard-delete of an `emails` row first writes a snapshot here so operators can trace late complaints / bounces back to a sent message after the body has been purged. Body / html / text are deliberately NOT preserved. **No foreign keys**: snapshots survive their parent api_key / domain being deleted. See [docs/emails.md](docs/emails.md#tombstones).

| Column         | Type           | Constraints                                   |
|----------------|----------------|-----------------------------------------------|
| id             | varchar(36)    | PK: matches the original email's id (`msg_…`)|
| api_key_id     | varchar(36)    | NOT NULL: snapshot, NOT a FK                 |
| message_id     | varchar(255)   | nullable: SMTP `Message-ID`, indexed         |
| from_address   | varchar(255)   | NOT NULL                                      |
| to_address     | varchar(255)   | NOT NULL                                      |
| subject        | varchar(500)   | nullable                                      |
| status         | varchar(20)    | NOT NULL: sent / bounced / failed at delete time |
| sent_at        | timestamptz    | nullable                                      |
| deleted_at     | timestamptz    | nullable, when the original was soft-deleted to trash |
| purged_at      | timestamptz    | NOT NULL, default `now()`: retention starts here |

Indexes: `(message_id)` (bounce/complaint trace hot path), `(api_key_id, purged_at)` (dashboard list).

Retention: `TOMBSTONE_RETENTION_DAYS` (default 90): the existing 6h trash purge loop also runs `runTombstoneRetention` on the same cadence.

### `webhook_deliveries` (#30)

Persisted retry queue. Every dispatch enqueues one row per subscribed webhook; the worker drains it on a 5s poll. See [docs/webhooks.md](docs/webhooks.md) for the full lifecycle.

| Column                | Type           | Constraints                                   |
|-----------------------|----------------|-----------------------------------------------|
| id                    | varchar(36)    | PK, prefixed `wdl_`                           |
| webhook_id            | varchar(36)    | FK → webhooks.id, NOT NULL, `ON DELETE CASCADE` |
| event                 | varchar(50)    | NOT NULL                                      |
| payload               | text           | NOT NULL: JSON body bytes (re-signed per attempt) |
| status                | varchar(20)    | NOT NULL, default `pending` (pending\|delivered\|failed) |
| attempts              | integer        | NOT NULL, default 0                           |
| last_error            | text           | nullable                                      |
| last_response_status  | integer        | nullable                                      |
| next_attempt_at       | timestamptz    | NOT NULL, default `now()`                     |
| delivered_at          | timestamptz    | nullable                                      |
| last_response_body    | jsonb          | nullable                                      |
| created_at            | timestamptz    | NOT NULL, default `now()`                     |
| updated_at            | timestamptz    | NOT NULL, default `now()`                     |

Indexes: `(next_attempt_at)` partial WHERE `status='pending'` (worker hot path), `(webhook_id, created_at)` (dashboard inspection).

### `templates`

| Column       | Type           | Constraints                     |
|--------------|----------------|---------------------------------|
| id           | varchar(36)    | PK, prefixed `tpl_`            |
| api_key_id   | varchar(36)    | FK → api_keys.id, NOT NULL, indexed (#173) |
| name         | varchar(255)   | NOT NULL                        |
| subject      | varchar(500)   | NOT NULL                        |
| html         | text           | nullable                        |
| text_content | text           | nullable                        |
| variables    | jsonb          | NOT NULL, default `[]`          |
| created_at   | timestamp      | NOT NULL, default `now()`       |
| updated_at   | timestamp      | NOT NULL, default `now()`       |
| created_by_user_id | varchar(36) | nullable, FK → users.id `ON DELETE SET NULL`, indexed: the user it belongs to (#219); NULL = the owner |

`created_by_user_id` on `api_keys`, `domains`, `webhooks` and `templates` (#219, migration `0020`): set from the signed-in user on dashboard creates and from the calling key's creator on REST creates. Legacy rows (NULL) are assigned to the owner by the owner bootstrap at boot, not by the migration (the owner row does not exist yet when migrations run on an upgrade). Members manage only their own keys and templates; domains and webhooks carry it for attribution. See [docs/users.md](docs/users.md#record-ownership-219).

### `inbound_emails`

| Column       | Type           | Constraints                     |
|--------------|----------------|---------------------------------|
| id           | varchar(36)    | PK, prefixed `inb_`            |
| from_address | varchar(255)   | NOT NULL                        |
| to_address   | varchar(255)   | NOT NULL                        |
| subject      | varchar(500)   | nullable                        |
| html         | text           | nullable                        |
| text_content | text           | nullable                        |
| raw_message  | text           | nullable                        |
| received_at  | timestamp      | NOT NULL, default `now()`       |
| deleted_at   | timestamp      | nullable (soft-delete marker)   |

### `suppressions`

Per-API-key list of addresses we refuse to send to (#25). Send-time gate at `createEmail` rejects with HTTP 422 before any insert / queue / SMTP work. Auto-populated by the bounce handler (#24) when DSNs come back.

| Column            | Type           | Constraints                  |
|-------------------|----------------|------------------------------|
| id                | varchar(36)    | PK, prefixed `sup_`          |
| api_key_id        | varchar(36)    | FK → api_keys.id, NOT NULL, `ON DELETE CASCADE` |
| email             | varchar(255)   | NOT NULL; stored lower-cased + trimmed |
| reason            | text           | NOT NULL; one of `bounce | complaint | manual | unsubscribe` (validated at API boundary; column stays text for forward compat) |
| bounce_type       | varchar(20)    | nullable; `hard | soft | null` |
| diagnostic_code   | text           | nullable; SMTP enhanced status (e.g. `5.1.1`) |
| source_email_id   | varchar(36)    | FK → emails.id, `ON DELETE SET NULL` |
| expires_at        | timestamptz    | nullable; null = permanent   |
| created_at        | timestamptz    | NOT NULL, default `now()`    |

Indexes: `UNIQUE (api_key_id, email)` (gate hot-path + `ON CONFLICT DO UPDATE` upsert).

### `smtp_submission_usage`

Per-`(api_key, UTC day)` counters for the SMTP submission server (#123): backs the per-key daily quota and the `/api/v1/smtp-submission/stats` endpoint. One row per key per day (not a per-message log). Auth *failures* are not recorded here (no key to attribute to).

| Column       | Type        | Constraints                                     |
|--------------|-------------|-------------------------------------------------|
| id           | varchar(36) | PK, prefixed `smu_`                             |
| api_key_id   | varchar(36) | FK → api_keys.id, NOT NULL, `ON DELETE CASCADE` |
| day          | date        | NOT NULL; UTC calendar day                      |
| accepted     | integer     | NOT NULL, default 0                             |
| rejected     | integer     | NOT NULL, default 0 (post-auth rejections)      |
| created_at   | timestamptz | NOT NULL, default `now()`                       |
| updated_at   | timestamptz | NOT NULL, default `now()`                       |

Indexes: `UNIQUE (api_key_id, day)` (quota read + `ON CONFLICT DO UPDATE` upsert + stats range scan).

### `dmarc_reports` / `dmarc_records`

DMARC aggregate (`rua`) reports parsed from inbound XML attachments (#41). Operator-level data, not tenant-scoped, no FK to `domains` or `api_keys`. See [docs/dmarc-reports.md](docs/dmarc-reports.md).

`dmarc_reports` (one row per received report):

| Column        | Type            | Constraints                                       |
|---------------|-----------------|---------------------------------------------------|
| id            | varchar(36)     | PK, prefixed `dmr_`                               |
| org_name      | varchar(255)    | NOT NULL                                          |
| org_email     | varchar(255)    | NOT NULL                                          |
| report_id     | varchar(255)    | NOT NULL                                          |
| domain        | varchar(255)    | NOT NULL                                          |
| date_begin    | timestamptz     | NOT NULL                                          |
| date_end      | timestamptz     | NOT NULL                                          |
| policy_p      | varchar(20)     | NOT NULL                                          |
| policy_pct    | integer         | NOT NULL                                          |
| raw_xml       | text            | NOT NULL (kept verbatim for forensics)            |
| received_at   | timestamptz     | NOT NULL, default `now()`                         |

Indexes: `UNIQUE (org_email, report_id)` (dedup hot-path), `(domain, date_end DESC)` (dashboard list hot-path).

`dmarc_records` (one row per source IP, child of the report):

| Column            | Type            | Constraints                                    |
|-------------------|-----------------|------------------------------------------------|
| id                | varchar(36)     | PK, prefixed `dmrec_`                          |
| report_id         | varchar(36)     | FK → dmarc_reports.id, NOT NULL, `ON DELETE CASCADE` |
| source_ip         | varchar(45)     | NOT NULL                                       |
| count             | integer         | NOT NULL                                       |
| disposition       | varchar(20)     | NOT NULL                                       |
| dkim_aligned      | boolean         | NOT NULL                                       |
| spf_aligned       | boolean         | NOT NULL                                       |
| header_from       | varchar(255)    | nullable                                       |
| dkim_auth_domain  | varchar(255)    | nullable                                       |
| dkim_selector     | varchar(255)    | nullable                                       |
| dkim_result       | varchar(20)     | nullable                                       |
| spf_auth_domain   | varchar(255)    | nullable                                       |
| spf_result        | varchar(20)     | nullable                                       |

### `users` (#214)

Dashboard accounts: identity only; login methods live in `user_credentials`. Exactly one `owner`, enforced by `users_single_owner` (unique on `role WHERE role = 'owner'`). See [docs/users.md](docs/users.md) for every column, index and check.

| Column            | Type         | Constraints                                                   |
|-------------------|--------------|---------------------------------------------------------------|
| id                | varchar(36)  | PK, prefixed `usr_`                                           |
| email             | varchar(255) | NOT NULL, UNIQUE, CHECK lower-cased                           |
| email_verified_at | timestamptz  | nullable                                                      |
| name              | varchar(100) | nullable                                                      |
| role              | varchar(10)  | NOT NULL, default `member`, CHECK IN (`owner`,`admin`,`member`) |
| disabled_at       | timestamptz  | nullable                                                      |
| created_at        | timestamptz  | NOT NULL, default `now()`                                     |
| updated_at        | timestamptz  | NOT NULL, default `now()`                                     |

### `user_credentials` (#214)

One row per login method: `password` now; `totp`, `passkey`, `oauth` reserved (CHECK). FK `users` ON DELETE CASCADE. Unique: one `password` row per user; `(provider, provider_account_id)` where provider is set. Columns: `secret_hash` (argon2id hash or encrypted TOTP secret), `provider`, `provider_account_id` (text), `name`, `public_key`, `counter` (bigint), `last_used_at`, timestamps.

### `sessions` (#214, #216)

Opaque session tokens stored as SHA-256 (`token_hash`, UNIQUE), FK `users` ON DELETE CASCADE, `assurance` CHECK IN (`pending`,`password`,`mfa`), `auth_method`, `expires_at` (24 h idle, capped at `created_at` + 7 days), `last_seen_at`, `ip`, `user_agent`. Token rotation (#216, migration `0017`) adds `previous_token_hash` (nullable, the token the last rotation replaced) and `rotated_at` (nullable). `credential_id` (#277, migration `0019`, nullable, FK `user_credentials` ON DELETE CASCADE) binds a session to the credential it was opened with: replacing a password deletes those sessions, and a login racing a reset cannot open one on the old password. `location` (#281, migration `0025`, nullable `varchar(128)`): the approximate location of `ip` ("City, Country" or "Country"), looked up once in the background after the session is created when GeoIP is configured. Indexes on `user_id`, `expires_at`, `previous_token_hash` and `credential_id`. Every superseded hash is also kept in `session_token_history` (`token_hash` PK, `session_id` FK ON DELETE CASCADE, `superseded_at`) until the session ends, so reuse of a token of any age is detected. Lifecycle (create, rotate, reuse detection, revoke, sweep): [docs/users.md](docs/users.md#sessions-216).

### `user_tokens` (#214)

One-time tokens (`purpose` CHECK IN `owner_setup`,`invite`,`password_reset`), stored as SHA-256 (`token_hash`, UNIQUE). `user_id` (FK CASCADE) or `email` (lower-cased) must be set; `role` for invites; `invited_by` FK ON DELETE SET NULL so invite history survives (for a `password_reset` row it records who issued the link, #277); `expires_at`, `used_at`, `revoked_at`. Index on `(email, purpose)`. `user_tokens_invite_check` (#217, migration `0018`): an `invite` row must have an `email` and a `role` of `admin` or `member`, never `owner`. Invitation lifecycle: [docs/users.md](docs/users.md#invitations-217).

### `user_devices` (#282)

The browsers each account signed in from with a password, for the new-device sign-in alert (migration `0026`). `id` (`udv_`), `user_id` (FK `users` ON DELETE CASCADE), `device_hash` (SHA-256 of the `bm_device` cookie value; the value is never stored), `user_agent` (the device label, "Chrome on macOS"), `ip`, `location` (nullable, #281), `first_seen_at`, `last_seen_at`. UNIQUE `(user_id, device_hash)` (the sign-in upsert's conflict target); indexes on `user_id` and `last_seen_at` (the 400-day sweep). Rules: [docs/users.md](docs/users.md#new-device-alerts-282).

### `__bunmail_migrations`

System table managed by the Bun-native migration runner ([src/db/migrate.ts](src/db/migrate.ts), #56). Each row is one applied migration tag (`0000_wonderful_psylocke`, etc.). The runner reads the committed `drizzle/<n>_*.sql` files at boot, applies anything not yet recorded, and auto-baselines legacy `db:push`-provisioned databases by detecting the schema's first table. The whole run holds a session-level advisory lock (`pg_advisory_lock(hashtext('bunmail:migrations'))`) on a single pinned connection (#175), so concurrent runs from several replicas serialize instead of racing.

### Relationships

```
api_keys  ──1:N──▶ emails
api_keys  ──1:N──▶ webhooks
webhooks  ──1:N──▶ webhook_deliveries  (CASCADE on parent delete)
api_keys  ──1:N──▶ templates
api_keys  ──1:N──▶ suppressions
domains   ──1:N──▶ emails
users     ──1:N──▶ api_keys, templates, domains, webhooks  (created_by_user_id, SET NULL on delete, #219)
users     ──1:N──▶ user_credentials, sessions, user_tokens, user_devices  (CASCADE on user delete; user_tokens.invited_by SET NULL)
user_credentials ──1:N──▶ sessions  (credential_id, CASCADE, #277)
sessions  ──1:N──▶ session_token_history  (CASCADE, #216)
emails    ──1:N──▶ suppressions    (source_email_id, when auto-suppressed from a bounce)
dmarc_reports ──1:N──▶ dmarc_records  (CASCADE on parent delete)
```

---

## API Endpoints

### Emails

| Method | Path                                | Description                                | Auth |
|--------|-------------------------------------|--------------------------------------------|------|
| POST   | /api/v1/emails/send                 | Send an email                              | Yes  |
| GET    | /api/v1/emails                      | List sent emails (excludes trash)          | Yes  |
| GET    | /api/v1/emails/trash                | List trashed emails                        | Yes  |
| GET    | /api/v1/emails/:id                  | Get email by ID                            | Yes  |
| DELETE | /api/v1/emails/:id                  | Move email to trash                        | Yes  |
| POST   | /api/v1/emails/bulk-delete          | Bulk move to trash (`{ ids: [] }`)         | Yes  |
| POST   | /api/v1/emails/:id/restore          | Restore from trash                         | Yes  |
| DELETE | /api/v1/emails/:id/permanent        | Permanently delete a trashed email (writes a tombstone) | Yes  |
| POST   | /api/v1/emails/trash/empty          | Permanently delete all trashed emails (writes tombstones) | Yes  |
| GET    | /api/v1/emails/tombstones           | List post-purge audit snapshots (`?messageId=` filter) | Yes  |
| GET    | /api/v1/emails/tombstones/:id       | Single tombstone by original email id       | Yes  |

### API Keys

| Method | Path                     | Description           | Auth |
|--------|--------------------------|-----------------------|------|
| POST   | /api/v1/api-keys         | Create API key (+ `allowedSenders`) | Yes  |
| GET    | /api/v1/api-keys         | List API keys         | Yes  |
| PATCH  | /api/v1/api-keys/:id     | Update name / allowed-senders (#126) | Yes  |
| DELETE | /api/v1/api-keys/:id     | Revoke API key        | Yes  |

### Domains

| Method | Path                          | Description           | Auth |
|--------|-------------------------------|-----------------------|------|
| POST   | /api/v1/domains               | Add domain (auto-DKIM)| Yes  |
| GET    | /api/v1/domains               | List domains          | Yes  |
| GET    | /api/v1/domains/:id           | Get domain details    | Yes  |
| POST   | /api/v1/domains/:id/verify    | Verify DNS records    | Yes  |
| PATCH  | /api/v1/domains/:id           | Edit unsubscribe settings | Yes |
| DELETE | /api/v1/domains/:id           | Remove domain         | Yes  |

### Webhooks

| Method | Path                          | Description           | Auth |
|--------|-------------------------------|-----------------------|------|
| POST   | /api/v1/webhooks              | Register webhook      | Yes  |
| GET    | /api/v1/webhooks              | List webhooks         | Yes  |
| DELETE | /api/v1/webhooks/:id          | Delete webhook (cascades to deliveries) | Yes  |
| GET    | /api/v1/webhooks/:id/deliveries | List delivery attempts (filter by `?status=`) | Yes |
| GET    | /api/v1/webhooks/deliveries/:deliveryId | Single delivery + payload + last response | Yes |
| POST   | /api/v1/webhooks/deliveries/:deliveryId/replay | Replay a delivery, flips to `pending` | Yes |

### Templates

| Method | Path                          | Description           | Auth |
|--------|-------------------------------|-----------------------|------|
| POST   | /api/v1/templates             | Create template       | Yes  |
| GET    | /api/v1/templates             | List templates        | Yes  |
| GET    | /api/v1/templates/:id         | Get template          | Yes  |
| PUT    | /api/v1/templates/:id         | Update template       | Yes  |
| DELETE | /api/v1/templates/:id         | Delete template       | Yes  |

### Suppressions

| Method | Path                                | Description                                | Auth |
|--------|-------------------------------------|--------------------------------------------|------|
| POST   | /api/v1/suppressions                | Add an address (idempotent upsert)         | Yes  |
| GET    | /api/v1/suppressions                | List, paginated, optional `?email=` filter | Yes  |
| GET    | /api/v1/suppressions/:id            | Get a suppression by ID                    | Yes  |
| DELETE | /api/v1/suppressions/:id            | Remove (recipient eligible immediately)    | Yes  |
| GET    | /api/v1/smtp-submission/stats       | SMTP submission usage + quota (calling key) | Yes  |

`POST /api/v1/emails/send` returns HTTP 422 with `{ code: "RECIPIENT_SUPPRESSED", suppressionId }` when the recipient is on the calling key's list. No row inserted, no queue entry, no SMTP attempt. See [docs/suppressions.md](docs/suppressions.md) and [docs/bounces.md](docs/bounces.md).

A successful send also returns `warnings` (#245): the sender domain's records that are not verified (`dkim_unverified`, `spf_unverified`, `dmarc_unverified`, or `domain_unregistered` in development). An unregistered sender domain in production is `422 SENDER_DOMAIN_NOT_REGISTERED`; with `REQUIRE_VERIFIED_DOMAIN=true` a domain whose DKIM record is still unverified after one inline DNS re-check is `422 SENDER_DOMAIN_UNVERIFIED`. See [docs/emails.md](docs/emails.md#domain-linking).

### Inbound

| Method | Path                                | Description                                | Auth |
|--------|-------------------------------------|--------------------------------------------|------|
| GET    | /api/v1/inbound                     | List received emails (excludes trash)      | Yes  |
| GET    | /api/v1/inbound/trash               | List trashed inbound                       | Yes  |
| GET    | /api/v1/inbound/:id                 | Get received email                         | Yes  |
| DELETE | /api/v1/inbound/:id                 | Move to trash                              | Yes  |
| POST   | /api/v1/inbound/bulk-delete         | Bulk move to trash (`{ ids: [] }`)         | Yes  |
| POST   | /api/v1/inbound/:id/restore         | Restore from trash                         | Yes  |
| DELETE | /api/v1/inbound/:id/permanent       | Permanently delete a trashed inbound       | Yes  |
| POST   | /api/v1/inbound/trash/empty         | Permanently delete all trashed inbound     | Yes  |
| GET    | /api/v1/dmarc-reports               | List DMARC aggregate reports (filter by `?domain=`) | Yes |
| GET    | /api/v1/dmarc-reports/:id           | Single report + per-source-IP records      | Yes  |

### Dashboard (HTML)

| Method | Path                               | Description             | Auth     |
|--------|------------------------------------|-------------------------|----------|
| GET    | /dashboard/login                   | Email + password login form | No   |
| POST   | /dashboard/login                   | Check email + password, open a session | No |
| POST   | /dashboard/logout                  | Revoke the session, clear the cookie | No |
| GET    | /dashboard/setup?token=            | Owner setup form (read-only, never spends the token) | Setup token |
| POST   | /dashboard/setup                   | Set owner password, spend the token, sign in | Setup token |
| GET    | /dashboard/invite?token=           | Invitation accept form (read-only, never spends the token, #217) | Invite token |
| POST   | /dashboard/invite                  | Create the invited account, spend the token, sign in (#217) | Invite token |
| GET    | /dashboard/reset?token=            | Password reset form (read-only, never spends the token, #277) | Reset token |
| POST   | /dashboard/reset                   | Set the new password, spend the token, sign out everywhere, sign in (#277) | Reset token |
| GET    | /dashboard/assets/dashboard.css    | Self-hosted stylesheet, cached 1 year (#255) | No |
| GET    | /dashboard/assets/dashboard.js     | Dashboard script, cached 1 year (#255) | No |
| GET    | /dashboard                         | Stats overview          | Member |
| GET    | /dashboard/account/password        | Change password form (any role, #279) | Member |
| POST   | /dashboard/account/password        | Change own password: throttled current-password check, sign out every other session, new session here (#279) | Member |
| GET    | /dashboard/account/sessions        | Own live sessions: device, IP, approximate location, signed in, last active, this device marked (#281) | Member |
| POST   | /dashboard/account/sessions/:id/revoke | Sign out one own session (another user's id: 404, nothing changes); the current one signs this browser out (#281) | Member |
| POST   | /dashboard/account/sessions/revoke-others | Sign out every own session except the current one (#281) | Member |
| GET    | /dashboard/send                    | Compose & send email    | Member |
| POST   | /dashboard/send                    | Queue email for send    | Member |
| GET    | /dashboard/emails                  | Email logs + filters + bulk-select | Member |
| GET    | /dashboard/emails/trash            | Trashed emails view     | Member |
| POST   | /dashboard/emails/bulk-trash       | Bulk move to trash      | Admin |
| POST   | /dashboard/emails/trash/bulk-restore   | Bulk restore        | Admin |
| POST   | /dashboard/emails/trash/bulk-permanent | Bulk hard-delete    | Admin |
| POST   | /dashboard/emails/trash/empty      | Empty email trash       | Admin |
| POST   | /dashboard/emails/:id/trash        | Move single to trash    | Admin  |
| POST   | /dashboard/emails/:id/restore      | Restore single          | Member |
| POST   | /dashboard/emails/:id/permanent    | Hard-delete single (writes tombstone) | Admin |
| GET    | /dashboard/emails/tombstones       | Tombstone list + Message-ID search | Member |
| GET    | /dashboard/emails/:id              | Email detail            | Member |
| GET    | /dashboard/api-keys                | API keys management (a member: own keys, #219) | Member |
| POST   | /dashboard/api-keys                | Create API key (a member: restricted only, #219) | Member |
| POST   | /dashboard/api-keys/:id/revoke     | Revoke API key (a member: own keys, #219) | Member |
| POST   | /dashboard/api-keys/:id/admin      | Promote/demote a key to admin (#130) | Admin |
| POST   | /dashboard/api-keys/:id/senders    | Set a key's allowed senders (#126; a member: own keys, #219) | Member |
| GET    | /dashboard/invitations             | Pending invitations + invite form, one-time link (#217) | Admin |
| POST   | /dashboard/invitations             | Invite an address (owner: admin or member; admin: member) | Admin |
| POST   | /dashboard/invitations/:id/revoke  | Revoke an invitation (roles the actor may grant) | Admin |
| POST   | /dashboard/invitations/:id/resend  | New link for the same address and role, sent again | Admin |
| GET    | /dashboard/users                   | Every account with role, status and allowed actions (#218) | Admin |
| POST   | /dashboard/users/:id/role          | Member to admin or back (owner only, in the service) | Admin |
| POST   | /dashboard/users/:id/deactivate    | Disable, revoke sessions and open invitations (owner: any non-owner; admin: members) | Admin |
| POST   | /dashboard/users/:id/reactivate    | Enable again (same rules) | Admin |
| POST   | /dashboard/users/:id/remove        | Delete, confirmed by the account's email (same rules) | Admin |
| POST   | /dashboard/users/:id/transfer      | Hand ownership to an active admin, confirmed by password (owner only, in the service) | Admin |
| POST   | /dashboard/users/:id/reset-password | One-time reset link, shown once to the issuer (same rules as deactivate, active accounts only, #277) | Admin |
| GET    | /dashboard/domains                 | Domains management      | Member |
| POST   | /dashboard/domains                 | Add domain              | Admin |
| POST   | /dashboard/domains/:id/delete      | Delete domain           | Admin |
| POST   | /dashboard/domains/:id/verify      | Verify domain DNS       | Admin |
| POST   | /dashboard/domains/:id/notify-email | Set/clear inbound notification address (#106) | Admin |
| POST   | /dashboard/domains/:id/unsubscribe | Set/clear List-Unsubscribe overrides (#243) | Admin |
| GET    | /dashboard/domains/:id             | Domain detail           | Member |
| GET    | /dashboard/templates               | Templates management    | Member |
| POST   | /dashboard/templates               | Create template         | Member |
| GET    | /dashboard/templates/:id           | Template detail + edit  | Member |
| POST   | /dashboard/templates/:id/edit      | Update template (a member: own templates, #219) | Member |
| POST   | /dashboard/templates/:id/delete    | Delete template (a member: own templates, #219) | Member |
| GET    | /dashboard/webhooks                | Webhooks management     | Member |
| POST   | /dashboard/webhooks                | Create webhook          | Admin |
| POST   | /dashboard/webhooks/:id/delete     | Delete webhook          | Admin |
| GET    | /dashboard/webhooks/:id/deliveries | Delivery history of one webhook (#30) | Member |
| GET    | /dashboard/webhooks/deliveries/:deliveryId | Delivery detail | Member |
| POST   | /dashboard/webhooks/deliveries/:deliveryId/replay | Re-queue a delivery | Admin |
| GET    | /dashboard/inbound                 | Inbound emails list + bulk-select | Member |
| GET    | /dashboard/inbound/trash           | Trashed inbound view    | Member |
| POST   | /dashboard/inbound/bulk-trash      | Bulk move to trash      | Admin |
| POST   | /dashboard/inbound/trash/bulk-restore   | Bulk restore       | Admin |
| POST   | /dashboard/inbound/trash/bulk-permanent | Bulk hard-delete   | Admin |
| POST   | /dashboard/inbound/trash/empty     | Empty inbound trash     | Admin |
| POST   | /dashboard/inbound/:id/trash       | Move single to trash    | Admin  |
| POST   | /dashboard/inbound/:id/restore     | Restore single          | Member |
| POST   | /dashboard/inbound/:id/permanent   | Hard-delete single      | Admin |
| GET    | /dashboard/inbound/:id             | Inbound email detail    | Member |
| GET    | /dashboard/inbound/:id/reply       | Compose form pre-filled as a reply (#86) | Member |
| GET    | /dashboard/dmarc-reports           | DMARC reports list + domain filter | Member |
| GET    | /dashboard/dmarc-reports/:id       | DMARC report detail (per-source-IP) | Member |
| GET    | /dashboard/suppressions            | Suppressions across every API key (#89) | Member |
| POST   | /dashboard/suppressions/:id/delete | Remove a suppression (#89) | Admin |

Dashboard auth is account login (#216): email and password against `user_credentials`, then a server-side session in `sessions` whose opaque token rides in the `bm_session` cookie (only its SHA-256 is stored). Sessions expire after 24 h idle and 7 days at most; the token rotates after 60 s of use, and a replaced token presented after its 30 s grace revokes every session of the user. Logout deletes the row. `POST /dashboard/login` and `/dashboard/logout` require same-origin, and login is brute-force-throttled per client IP (5 failures / 15 min → `429`, #109), see [Rate Limiting](#rate-limiting). The owner account (#215) is claimed through the one-time `/dashboard/setup` link logged on first boot; completing it stores the owner password, deletes the owner's sessions and opens a new one. Every other account arrives by invitation (#217): an admin or the owner invites an address from `/dashboard/invitations`, the accept link is emailed from `SYSTEM_MAIL_FROM` (or shown to the inviter once), and `/dashboard/invite` creates the account and signs it in. A password login also sets the long-lived `bm_device` cookie (#282, 400 days, not a credential, only its SHA-256 stored in `user_devices`); a sign-in from a browser the account has not used in 30 days emails it a "New sign-in to your BunMail account" alert from `SYSTEM_MAIL_FROM` (no links), checked in the background so it never delays the login. See [docs/dashboard.md](docs/dashboard.md#auth-flow) and [docs/users.md](docs/users.md#sessions-216).

Roles (#222): the session guard (an Elysia `resolve`) exposes the signed-in account to every protected handler as `auth` (`user: { id, email, role }`, `session: { id, assurance }`) from its single session lookup, and every protected route carries a role check as its own `beforeHandle` (`memberGuard`, `adminGuard` or `ownerGuard`, `src/pages/guards.tsx`; owner > admin > member). The Auth column above is the minimum role. A role too low gets `403` with a small Forbidden page and a `warn` log line. Account management (#218) adds owner-only and members-only rules inside `user-admin.service.ts`, checked against the live roles under the `bunmail:owner` lock; the sidebar hides admin-only links from members. `test/integration/dashboard-route-access.integration.test.ts` fails on any route missing from its table or carrying the wrong guard. See [docs/dashboard.md](docs/dashboard.md#roles-222).

### Health

| Method | Path     | Description    | Auth |
|--------|----------|----------------|------|
| GET    | /health  | Health check   | No   |

---

## Authentication

- **Method:** Bearer token in `Authorization` header
- **Key format:** `bm_live_<random>` (e.g., `bm_live_a1b2c3d4e5f6g7h8`)
- **Storage:** Only SHA-256 hash stored in DB; raw key shown once at creation
- **Lookup:** Hash incoming token → match against `key_hash` column
- **Roles (#130):** keys are **admin** or **restricted** (`is_admin`). `adminMiddleware` (`src/middleware/auth.ts`, used after `authMiddleware`) gates the management plane (`/api/v1/api-keys`, `/api/v1/domains`, `/api/v1/inbound`) returning `403 ADMIN_REQUIRED` for restricted keys. `is_admin` is operator-set only (dashboard + seed), never via a REST DTO. Existing keys migrated to admin; new API-created keys default restricted.
- **Bootstrap:** Run `bun run src/db/seed.ts` to create the first API key (admin). The dashboard owner is created on boot from `BUNMAIL_OWNER_EMAIL` (#215); recover a lost setup link with `bun run src/db/reset-owner.ts`
- **Dashboard (separate from API keys, #216):** account login (email + password, argon2id) and server-side sessions in Postgres. The cookie token is looked up by its SHA-256 through an indexed column, so no secret is compared in JavaScript; sessions rotate their token every minute with reuse detection, and `reset-owner` signs the owner out everywhere. Every protected route requires a minimum account role (owner > admin > member, #222). Details: [docs/dashboard.md](docs/dashboard.md#auth-flow)

---

## Rate Limiting

Two independent in-memory fixed-window limiters:

**API requests** (`src/middleware/rate-limit.ts`, algorithm in `rate-limit-core.ts`)
- **Default limit:** 100 requests per minute per API key
- **Scope:** Per API key ID
- **Response on limit:** `429 Too Many Requests` with `Retry-After` header
- **Tunable:** `API_RATE_LIMIT_MAX` / `API_RATE_LIMIT_WINDOW` (seconds)

**Dashboard login** (`src/middleware/login-rate-limit.ts`, #109)
- **Default limit:** 5 failed logins (any reason) per 15 minutes, per client IP; no per-account lockout
- **Scope:** Per client IP: resolved by counting `DASHBOARD_TRUSTED_PROXY_HOPS` entries from the right of `X-Forwarded-For` (default `0` = raw socket IP; the leftmost header entry is never trusted)
- **Response on limit:** `429 Too Many Requests` with `Retry-After`; a successful login gives back only its own attempt, earlier failures stay until the window ends (#256); IPv6 clients counted per `/64`
- **Tunable:** `DASHBOARD_LOGIN_RATE_LIMIT_{ENABLED,MAX,WINDOW}`

Both maps reset on server restart and are per-replica (single-instance only; optional Redis backing is tracked in #185).

---

## Email Delivery

BunMail sends emails directly to recipient MX servers: no SMTP relay or third-party provider. For each recipient domain the mailer resolves the MX host itself, refuses private or loopback addresses (unless `MAIL_ALLOW_PRIVATE_MX=true`), and builds a Nodemailer transport to the checked address on port 25 with the MX name as TLS SNI (opportunistic STARTTLS).

**What this means:**
- The server's IP reputation directly affects deliverability
- DKIM, SPF, and DMARC records are critical to avoid spam folders
- A PTR (reverse DNS) record should match the sending hostname

**DKIM Signing:**
- RSA 2048-bit key pair generated per domain
- Private key encrypted at rest with AES-256-GCM via `DKIM_ENCRYPTION_KEY` (#23); public key provided as DNS TXT record value
- Decrypted in memory on each send and handed to nodemailer's signer. A key that does not decrypt fails closed in production (#244): the boot refuses to start, naming the domains, and the queue holds the email on the retry backoff instead of sending it unsigned (development warns and sends unsigned)

**Bounce → Suppression chain:** two paths converge on the same suppression list and webhook event.
- **Inline 5xx** during the SMTP transaction → caught in `processEmail`'s catch block via [`handleSendFailure`](src/modules/emails/services/queue.service.ts) + [`parseSmtpError`](src/utils/smtp-error.ts). Auto-suppress on attempt 1; **don't retry** (#68).
- **Async DSN** received at the inbound SMTP → routed to the bounce module ([src/modules/bounces/](src/modules/bounces/)) before generic inbound storage (#24).
- Hard bounces (5.x.x) → permanent per-API-key suppression in either path.
- Soft bounces (4.x.x): async DSN path applies a 24h windowed suppression with escalation to permanent on a second soft bounce. Inline 4xx path retries with backoff until the email is `MAIL_RETRY_MAX_AGE_HOURS` old (#180) (the catch-block doesn't have enough signal to make a per-recipient soft → hard call safely).
- Subsequent sends to suppressed recipients return HTTP 422 with `code: "RECIPIENT_SUPPRESSED"` from the gate at `createEmail`.

---

## Deployment

```yaml
# docker-compose.yml (abridged: the SMTP port lines are commented out until enabled)
x-logging: &default-logging          # log rotation (#284): 5 files of 10 MB per container
  driver: json-file
  options:
    max-size: "10m"
    max-file: "5"

services:
  app:
    logging: *default-logging
    build: .
    ports:
      - "${PORT:-3000}:${PORT:-3000}"   # HTTP API + Dashboard
    env_file: .env                     # DKIM_ENCRYPTION_KEY, MAIL_HOSTNAME, BUNMAIL_OWNER_EMAIL, ...
    environment:
      DATABASE_URL: postgres://${POSTGRES_USER:-bunmail}:${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env}@db:5432/${POSTGRES_DB:-bunmail}
      BUNMAIL_ENV: production          # always: the production config guards apply
    depends_on:
      db:
        condition: service_healthy
    sysctls:
      net.ipv4.ip_unprivileged_port_start: 0   # non-root user may bind 25/587 (#167)
    restart: unless-stopped

  db:
    logging: *default-logging
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-bunmail}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env}
      POSTGRES_DB: ${POSTGRES_DB:-bunmail}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-bunmail}"]
      interval: 5s
      timeout: 5s
      retries: 5
    restart: unless-stopped

volumes:
  pgdata:
```

Because compose always sets `BUNMAIL_ENV=production`, the app refuses to start until `.env` has `POSTGRES_PASSWORD`, `DKIM_ENCRYPTION_KEY` (#23, `openssl rand -base64 32`), a real `MAIL_HOSTNAME` (#242) and `BUNMAIL_OWNER_EMAIL` (#215, the dashboard login account since #216). `DASHBOARD_PASSWORD` and `SESSION_SECRET` are no longer read (#216). Optional for invitations (#217): `SYSTEM_MAIL_FROM` (sender of invitation emails and new-device sign-in alerts (#282), on a DKIM-verified domain registered in BunMail; malformed refuses to boot) and `INVITE_EXPIRY_DAYS` (1 to 90, default 7); set `APP_BASE_URL` too, or invitation and password reset links point at `localhost`. Optional for the Active sessions page (#281): `GEOIP_DB_PATH` (an offline DB-IP Lite or GeoLite2 `.mmdb` file) or `GEOIP_PROVIDER=ipinfo` with `GEOIP_API_TOKEN` (online, sends every sign-in IP to ipinfo.io) for an approximate location per session; unset, no location is shown, and a bad combination refuses to boot. Optional: `REQUIRE_VERIFIED_DOMAIN=true` (#245) refuses sends from a domain whose DKIM record is not verified (default `false`: queued, with `warnings` in the send response). Optional tuning: `API_RATE_LIMIT_MAX` / `API_RATE_LIMIT_WINDOW`, `MAIL_RETRY_MAX_AGE_HOURS`, `MAIL_ALLOW_PRIVATE_MX` and the rest of [.env.example](.env.example). Upgrading from 0.9.x: see the upgrade guide in the 0.10.0 entry of [CHANGELOG.md](CHANGELOG.md). For local development, `docker-compose.override.example.yml` (copy it to the untracked `docker-compose.override.yml`, #205) publishes Postgres on `127.0.0.1:5432` (#209).

**Local development:** Use [Neon](https://neon.tech) (free PostgreSQL cloud) to avoid installing PostgreSQL locally. Set `DATABASE_URL` in `.env`.

**Production:** `docker compose up -d --build` starts the app (published on `127.0.0.1:$PORT`, behind a reverse proxy) and PostgreSQL (compose network only). Host-specific ports and mounts live in an untracked `docker-compose.override.yml` copied from `docker-compose.override.example.yml` (#205). The container runs `bun run db:migrate && bun run start`, so pending migrations apply on every start.

### Optional SMTP listeners

Beyond the HTTP server, the app can start two independent, opt-in SMTP listeners as background services (both off by default; each has a port line in `docker-compose.yml` that's commented out until enabled):

| Listener | Toggle / port env | Purpose |
|---|---|---|
| **Inbound receiver** | `SMTP_ENABLED` / `SMTP_PORT` (25) | Receives MX mail for your domains → `inbound_emails` (AUTH disabled; validates recipient domains). See [docs/inbound.md](docs/inbound.md). |
| **Submission server** (#120) | `SMTP_SUBMISSION_ENABLED` / `SMTP_SUBMISSION_PORT` (587) | Lets apps send *through* BunMail over SMTP (AUTH required = API key; relays to any recipient via `createEmail`). TLS via `SMTP_SUBMISSION_TLS_CERT`/`_KEY`; per-IP connection + failed-AUTH throttles via `SMTP_SUBMISSION_RATE_LIMIT_*` / `SMTP_SUBMISSION_AUTH_RATE_LIMIT_*`. See [docs/smtp-submission.md](docs/smtp-submission.md). |

Both are started from [src/index.ts](src/index.ts) after the queue processor and stopped in the graceful shutdown handler.

---

## Error Handling

- Services throw; routes don't catch
- Elysia's global `onError` handler in [src/index.ts](src/index.ts) maps known error classes to structured JSON responses:
  - Request validation failure → 422 with `{ code: "VALIDATION_ERROR", details: [{ path, message }] }` (submitted values never echoed); malformed JSON → 400 `INVALID_BODY`
  - `NOT_FOUND` → 404 (HTML for `Accept: text/html`, JSON otherwise)
  - `SuppressedRecipientError` → 422 with `{ code: "RECIPIENT_SUPPRESSED", suppressionId }` (#25)
  - `TemplateTooLargeError` → 422 `TEMPLATE_OUTPUT_TOO_LARGE`
  - `InactiveApiKeyError` → 401 `API_KEY_REVOKED`
  - `ApiKeyCreatorInactiveError` → 403 `API_KEY_CREATOR_INACTIVE` (#219)
  - `UnauthorizedSenderError` → 403 with `{ code: "UNAUTHORIZED_SENDER", sender }`: `From` not in the key's allowed-senders list (#126)
  - `InboundEventsRequireAdminError` → 403 `INBOUND_EVENTS_REQUIRE_ADMIN`
  - `BlockedUrlError` → 422 `WEBHOOK_URL_BLOCKED` (#128)
  - Unhandled errors → 500; the client gets `"Internal server error"` in production (#133), the message in development; the detail is logged server-side
- Email queue failures are logged and stored in the `last_error` column

---

## Future (v2+)

- Open/click tracking
- Analytics dashboard with charts
- SDK packages (`npm i bunmail`)
- CLI tool (`bunx bunmail init`)
- Scheduled emails
- One-click unsubscribe endpoint (Gmail Feb-2024 List-Unsubscribe-Post)
- Bun-native SMTP client (subsumes #37, #42, see #60)
- Optional Redis backing for the per-replica in-memory state (rate limits, one-time reveal store) (#185)
- Dashboard account follow-ups: TOTP two-factor (#220), passkeys (#223), SSO (#224)
