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
│  │  - Auth      │    │ (3 retries)  │    │  (Direct Mode)    │     │
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
| SMTP Sending     | Nodemailer (direct mode, no relay)  |
| Email Auth       | DKIM signing, SPF/DMARC DNS checks  |
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
│   │   └── schema.ts                     ← Re-exports all model schemas
│   ├── middleware/
│   │   ├── auth.ts                       ← API key bearer auth
│   │   └── rate-limit.ts                 ← Sliding window rate limiter
│   ├── utils/
│   │   ├── id.ts                         ← Prefixed ID generator
│   │   ├── logger.ts                     ← Structured JSON logger
│   │   └── crypto.ts                     ← API key hashing
│   ├── modules/
│   │   ├── emails/
│   │   │   ├── emails.plugin.ts          ← POST /send, GET /emails
│   │   │   ├── services/
│   │   │   │   ├── email.service.ts      ← Email CRUD + stats
│   │   │   │   ├── mailer.service.ts     ← Nodemailer transport + DKIM
│   │   │   │   └── queue.service.ts      ← Queue processor + retries
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
│   │   │   ├── webhooks.plugin.ts        ← CRUD routes
│   │   │   ├── services/
│   │   │   │   ├── webhook.service.ts    ← CRUD operations
│   │   │   │   └── webhook-dispatch.service.ts ← Event delivery + retries
│   │   │   ├── dtos/
│   │   │   │   └── create-webhook.dto.ts
│   │   │   ├── models/
│   │   │   │   └── webhook.schema.ts     ← webhooks pgTable
│   │   │   ├── serializations/
│   │   │   │   └── webhook.serialization.ts
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
│   │   └── inbound/
│   │       ├── inbound.plugin.ts         ← GET / (list), GET /:id
│   │       ├── services/
│   │       │   └── smtp-receiver.service.ts ← SMTP server (smtp-server)
│   │       ├── models/
│   │       │   └── inbound-email.schema.ts ← inbound_emails pgTable
│   │       ├── serializations/
│   │       │   └── inbound.serialization.ts
│   │       └── types/
│   │           └── inbound.types.ts
│   └── pages/                            ← Dashboard (presentation layer)
│       ├── pages.plugin.tsx              ← Elysia plugin serving /dashboard + auth
│       ├── landing.plugin.tsx            ← Public landing page at /
│       ├── layouts/
│       │   └── base.tsx                  ← HTML shell + Tailwind CDN + nav
│       ├── routes/
│       │   ├── login.tsx                 ← Login form (standalone, no nav)
│       │   ├── home.tsx                  ← Stats overview (cards grid)
│       │   ├── landing.tsx               ← Public marketing page
│       │   ├── not-found.tsx             ← Custom 404 page
│       │   ├── send-email.tsx            ← Compose & send email form
│       │   ├── emails.tsx                ← Email logs table + filters
│       │   ├── email-detail.tsx          ← Single email view
│       │   ├── api-keys.tsx              ← API keys list + create + revoke
│       │   ├── domains.tsx               ← Domains list + add + delete
│       │   ├── domain-detail.tsx         ← Domain verification status
│       │   ├── templates.tsx             ← Templates list + create
│       │   ├── template-detail.tsx       ← Template edit form
│       │   ├── webhooks.tsx              ← Webhooks list + create
│       │   ├── inbound.tsx               ← Inbound emails list
│       │   └── inbound-detail.tsx        ← Inbound email detail + preview
│       └── components/
│           ├── stats-card.tsx            ← Stat card (label, value, accent)
│           ├── status-badge.tsx          ← Status + verification badges
│           ├── pagination.tsx            ← Prev/Next page links
│           ├── flash-message.tsx         ← Success/error banner
│           └── empty-state.tsx           ← "No data yet" placeholder
├── test/
│   ├── unit/                             ← Pure unit tests
│   │   ├── crypto.test.ts
│   │   ├── id.test.ts
│   │   ├── session.test.ts
│   │   ├── domain.serialization.test.ts
│   │   ├── email.serialization.test.ts
│   │   └── api-key.serialization.test.ts
│   └── e2e/                              ← E2E integration tests
│       ├── dashboard.test.ts
│       └── domains-api.test.ts
```

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

The `src/pages/` folder is separate from modules — it's a presentation layer that consumes module services to render server-side JSX pages. It has no DTOs, models, or business logic of its own.

**Rules:**
- Route handlers are thin — they call services and return serialized responses
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
│  Rate Limit │  ← In-memory sliding window (100 req/min per API key)
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
│  Queue Processor (setInterval, every 2 seconds)                 │
│                                                                 │
│  1. SELECT FROM emails WHERE status = 'queued'                  │
│     ORDER BY created_at ASC LIMIT 5                             │
│                                                                 │
│  2. For each email (up to 5 concurrent):                        │
│     ┌───────────────────────────────────────┐                   │
│     │ a. UPDATE status = 'sending'          │                   │
│     │    INCREMENT attempts                 │                   │
│     │                                       │                   │
│     │ b. Call mailerService.sendMail()      │                   │
│     │    (Nodemailer direct + DKIM)         │                   │
│     │                                       │                   │
│     │ c. On SUCCESS:                        │                   │
│     │    status = 'sent', sentAt = now()    │                   │
│     │                                       │                   │
│     │ d. On FAILURE:                        │                   │
│     │    if attempts >= 3:                  │                   │
│     │      status = 'failed'                │                   │
│     │      lastError = error.message        │                   │
│     │    else:                              │                   │
│     │      status = 'queued' (retry later)  │                   │
│     └───────────────────────────────────────┘                   │
│                                                                 │
│  On Boot: Reset any 'sending' → 'queued' (interrupted emails)   │
└─────────────────────────────────────────────────────────────────┘
```

**Email Status Flow:**

```
queued → sending → sent
                 → failed (after 3 attempts)
         ↘ queued (retry on transient failure)
```

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
| subject       | varchar(500)   | NOT NULL                        |
| html          | text           | nullable                        |
| text_content  | text           | nullable                        |
| status        | varchar(20)    | NOT NULL, default `'queued'`    |
| attempts      | integer        | NOT NULL, default `0`           |
| last_error    | text           | nullable                        |
| message_id    | varchar(255)   | nullable (SMTP Message-ID)      |
| sent_at       | timestamp      | nullable                        |
| created_at    | timestamp      | NOT NULL, default `now()`       |
| updated_at    | timestamp      | NOT NULL, default `now()`       |

### `api_keys`

| Column       | Type           | Constraints                     |
|--------------|----------------|---------------------------------|
| id           | varchar(36)    | PK, prefixed `key_`             |
| name         | varchar(100)   | NOT NULL                        |
| key_hash     | varchar(255)   | NOT NULL, UNIQUE                |
| key_prefix   | varchar(12)    | NOT NULL                        |
| is_active    | boolean        | NOT NULL, default `true`        |
| last_used_at | timestamp      | nullable                        |
| created_at   | timestamp      | NOT NULL, default `now()`       |

### `domains`

| Column           | Type           | Constraints                  |
|------------------|----------------|------------------------------|
| id               | varchar(36)    | PK, prefixed `dom_`          |
| name             | varchar(255)   | NOT NULL, UNIQUE             |
| dkim_private_key | text           | nullable                     |
| dkim_public_key  | text           | nullable                     |
| dkim_selector    | varchar(63)    | NOT NULL, default `'bunmail'`|
| spf_verified     | boolean        | NOT NULL, default `false`    |
| dkim_verified    | boolean        | NOT NULL, default `false`    |
| dmarc_verified   | boolean        | NOT NULL, default `false`    |
| verified_at      | timestamp      | nullable                     |
| created_at       | timestamp      | NOT NULL, default `now()`    |
| updated_at       | timestamp      | NOT NULL, default `now()`    |

### `webhooks`

| Column       | Type           | Constraints                     |
|--------------|----------------|---------------------------------|
| id           | varchar(36)    | PK, prefixed `whk_`            |
| api_key_id   | varchar(36)    | FK → api_keys.id, NOT NULL      |
| url          | text           | NOT NULL                        |
| events       | jsonb          | NOT NULL, default `[]`          |
| secret       | varchar(64)    | NOT NULL                        |
| is_active    | boolean        | NOT NULL, default `true`        |
| created_at   | timestamp      | NOT NULL, default `now()`       |
| updated_at   | timestamp      | NOT NULL, default `now()`       |

### `templates`

| Column       | Type           | Constraints                     |
|--------------|----------------|---------------------------------|
| id           | varchar(36)    | PK, prefixed `tpl_`            |
| api_key_id   | varchar(36)    | FK → api_keys.id, NOT NULL      |
| name         | varchar(255)   | NOT NULL                        |
| subject      | varchar(500)   | NOT NULL                        |
| html         | text           | nullable                        |
| text_content | text           | nullable                        |
| variables    | jsonb          | NOT NULL, default `[]`          |
| created_at   | timestamp      | NOT NULL, default `now()`       |
| updated_at   | timestamp      | NOT NULL, default `now()`       |

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

### Relationships

```
api_keys  ──1:N──▶ emails
api_keys  ──1:N──▶ webhooks
api_keys  ──1:N──▶ templates
domains   ──1:N──▶ emails
```

---

## API Endpoints

### Emails

| Method | Path                     | Description           | Auth |
|--------|--------------------------|-----------------------|------|
| POST   | /api/v1/emails/send      | Send an email         | Yes  |
| GET    | /api/v1/emails           | List sent emails      | Yes  |
| GET    | /api/v1/emails/:id       | Get email by ID       | Yes  |

### API Keys

| Method | Path                     | Description           | Auth |
|--------|--------------------------|-----------------------|------|
| POST   | /api/v1/api-keys         | Create API key        | Yes  |
| GET    | /api/v1/api-keys         | List API keys         | Yes  |
| DELETE | /api/v1/api-keys/:id     | Revoke API key        | Yes  |

### Domains

| Method | Path                          | Description           | Auth |
|--------|-------------------------------|-----------------------|------|
| POST   | /api/v1/domains               | Add domain (auto-DKIM)| Yes  |
| GET    | /api/v1/domains               | List domains          | Yes  |
| GET    | /api/v1/domains/:id           | Get domain details    | Yes  |
| POST   | /api/v1/domains/:id/verify    | Verify DNS records    | Yes  |
| DELETE | /api/v1/domains/:id           | Remove domain         | Yes  |

### Webhooks

| Method | Path                          | Description           | Auth |
|--------|-------------------------------|-----------------------|------|
| POST   | /api/v1/webhooks              | Register webhook      | Yes  |
| GET    | /api/v1/webhooks              | List webhooks         | Yes  |
| DELETE | /api/v1/webhooks/:id          | Delete webhook        | Yes  |

### Templates

| Method | Path                          | Description           | Auth |
|--------|-------------------------------|-----------------------|------|
| POST   | /api/v1/templates             | Create template       | Yes  |
| GET    | /api/v1/templates             | List templates        | Yes  |
| GET    | /api/v1/templates/:id         | Get template          | Yes  |
| PUT    | /api/v1/templates/:id         | Update template       | Yes  |
| DELETE | /api/v1/templates/:id         | Delete template       | Yes  |

### Inbound

| Method | Path                          | Description           | Auth |
|--------|-------------------------------|-----------------------|------|
| GET    | /api/v1/inbound               | List received emails  | Yes  |
| GET    | /api/v1/inbound/:id           | Get received email    | Yes  |

### Dashboard (HTML)

| Method | Path                               | Description             | Auth     |
|--------|------------------------------------|-------------------------|----------|
| GET    | /dashboard/login                   | Login form              | No       |
| POST   | /dashboard/login                   | Validate password       | No       |
| POST   | /dashboard/logout                  | Clear session           | No       |
| GET    | /dashboard                         | Stats overview          | Session  |
| GET    | /dashboard/send                    | Compose & send email    | Session  |
| POST   | /dashboard/send                    | Queue email for send    | Session  |
| GET    | /dashboard/emails                  | Email logs + filters    | Session  |
| GET    | /dashboard/emails/:id              | Email detail            | Session  |
| GET    | /dashboard/api-keys                | API keys management     | Session  |
| POST   | /dashboard/api-keys                | Create API key          | Session  |
| POST   | /dashboard/api-keys/:id/revoke     | Revoke API key          | Session  |
| GET    | /dashboard/domains                 | Domains management      | Session  |
| POST   | /dashboard/domains                 | Add domain              | Session  |
| POST   | /dashboard/domains/:id/delete      | Delete domain           | Session  |
| POST   | /dashboard/domains/:id/verify      | Verify domain DNS       | Session  |
| GET    | /dashboard/domains/:id             | Domain detail           | Session  |
| GET    | /dashboard/templates               | Templates management    | Session  |
| POST   | /dashboard/templates               | Create template         | Session  |
| GET    | /dashboard/templates/:id           | Template detail + edit  | Session  |
| POST   | /dashboard/templates/:id/edit      | Update template         | Session  |
| POST   | /dashboard/templates/:id/delete    | Delete template         | Session  |
| GET    | /dashboard/webhooks                | Webhooks management     | Session  |
| POST   | /dashboard/webhooks                | Create webhook          | Session  |
| POST   | /dashboard/webhooks/:id/delete     | Delete webhook          | Session  |
| GET    | /dashboard/inbound                 | Inbound emails list     | Session  |
| GET    | /dashboard/inbound/:id             | Inbound email detail    | Session  |

Dashboard auth uses `DASHBOARD_PASSWORD` env var + HMAC-signed session cookie (24h expiry).

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
- **Bootstrap:** Run `bun run seed` to create the first API key

---

## Rate Limiting

- **Algorithm:** Sliding window counter (in-memory Map)
- **Default limit:** 100 requests per minute per API key
- **Response on limit:** `429 Too Many Requests` with `Retry-After` header
- **Scope:** Per API key ID
- **Note:** Resets on server restart (single-instance only; Redis-backed in v2)

---

## Email Delivery

BunMail sends emails directly to recipient MX servers using Nodemailer's `direct: true` mode — no SMTP relay or third-party provider.

**What this means:**
- The server's IP reputation directly affects deliverability
- DKIM, SPF, and DMARC records are critical to avoid spam folders
- A PTR (reverse DNS) record should match the sending hostname

**DKIM Signing:**
- RSA 2048-bit key pair generated per domain
- Private key stored in DB, public key provided as DNS TXT record value
- Nodemailer signs outgoing emails automatically when DKIM keys exist

---

## Deployment

```yaml
# docker-compose.yml
services:
  app:
    build: .
    ports: ["3000:3000"]
    environment:
      DATABASE_URL: postgres://bunmail:bunmail@db:5432/bunmail
    depends_on:
      db: { condition: service_healthy }

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: bunmail
      POSTGRES_PASSWORD: bunmail
      POSTGRES_DB: bunmail
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U bunmail"]

volumes:
  pgdata:
```

**Local development:** Use [Neon](https://neon.tech) (free PostgreSQL cloud) to avoid installing PostgreSQL locally. Set `DATABASE_URL` in `.env`.

**Production:** `docker compose up -d` starts both the app and PostgreSQL.

---

## Error Handling

- Services throw typed errors (`NotFoundError`, `UnauthorizedError`, `RateLimitError`, `ValidationError`)
- Elysia's global error handler catches and formats them into consistent JSON responses
- No raw errors or stack traces in API responses
- Email queue failures are logged and stored in `last_error` column

---

## Future (v2+)

- Open/click tracking
- Multiple API keys with permissions
- Team access / multi-user
- Analytics dashboard with charts
- SDK packages (`npm i bunmail`)
- CLI tool (`bunx bunmail init`)
- Scheduled emails
- Suppression list (unsubscribes, bounces)
- Redis-backed rate limiting for multi-instance deploys
