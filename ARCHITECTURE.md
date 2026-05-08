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
│   │   └── encrypt-domain-keys.ts        ← Boot-time pass that encrypts legacy plaintext DKIM keys (#23)
│   ├── middleware/
│   │   ├── auth.ts                       ← API key bearer auth
│   │   └── rate-limit.ts                 ← Sliding window rate limiter
│   ├── utils/
│   │   ├── id.ts                         ← Prefixed ID generator
│   │   ├── logger.ts                     ← Structured JSON logger
│   │   ├── redact.ts                     ← PII-aware email redaction for logs (#33)
│   │   └── crypto.ts                     ← API key hashing + AES-256-GCM encryptSecret/decryptSecret (#23)
│   ├── modules/
│   │   ├── emails/
│   │   │   ├── emails.plugin.ts          ← POST /send, GET /emails
│   │   │   ├── services/
│   │   │   │   ├── email.service.ts      ← Email CRUD + trash/restore
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
│   │   ├── trash/
│   │   │   └── services/
│   │   │       └── purge.service.ts      ← Periodic auto-purge of trashed rows
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
│   │   └── bounces/                      ← DSN parsing + bounce → suppression chain (#24)
│   │       ├── services/
│   │       │   ├── bounce-parser.service.ts  ← Pure RFC 3464 + regex fallback parser
│   │       │   └── bounce-handler.service.ts ← Lookup, escalation, suppress, mark bounced, webhook
│   │       └── types/
│   │           └── bounce.types.ts
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
│       │   ├── inbound.tsx               ← Inbound emails list (bulk-select + trash)
│       │   ├── inbound-detail.tsx        ← Inbound email detail + preview
│       │   ├── inbound-trash.tsx         ← Trashed inbound view
│       │   └── emails-trash.tsx          ← Trashed outbound view
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
queued → sending → sent → bounced  ← async DSN arrives later (#24)
                 → bounced          ← inline 5xx during SMTP transaction (#68)
                                     auto-suppress + stop retrying on attempt 1
                 → failed (after 3 attempts on soft 4xx or infra error)
         ↘ queued (retry on soft 4xx or infrastructure error, attempts < 3)
```

`sent` = recipient's MX accepted the SMTP transaction. `bounced` = recipient confirmed permanently unreachable, either inline (`550 5.1.1 ...` during the send, #68) or via a DSN that came back later (#24). Both paths auto-suppress and fire `email.bounced` with `source: "inline"` vs `"rfc3464"` / `"fallback"`. `failed` = soft 4xx or infrastructure error exhausted retries — we never confirmed reachability either way.

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
| last_used_at | timestamp      | nullable                        |
| created_at   | timestamp      | NOT NULL, default `now()`       |

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
| spf_verified      | boolean        | NOT NULL, default `false`    |
| dkim_verified     | boolean        | NOT NULL, default `false`    |
| dmarc_verified    | boolean        | NOT NULL, default `false`    |
| verified_at       | timestamp      | nullable                     |
| created_at        | timestamp      | NOT NULL, default `now()`    |
| updated_at        | timestamp      | NOT NULL, default `now()`    |

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

### `__bunmail_migrations`

System table managed by the Bun-native migration runner ([src/db/migrate.ts](src/db/migrate.ts), #56). Each row is one applied migration tag (`0000_wonderful_psylocke`, etc.). The runner reads the committed `drizzle/<n>_*.sql` files at boot, applies anything not yet recorded, and auto-baselines legacy `db:push`-provisioned databases by detecting the schema's first table.

### Relationships

```
api_keys  ──1:N──▶ emails
api_keys  ──1:N──▶ webhooks
api_keys  ──1:N──▶ templates
api_keys  ──1:N──▶ suppressions
domains   ──1:N──▶ emails
emails    ──1:N──▶ suppressions    (source_email_id, when auto-suppressed from a bounce)
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
| DELETE | /api/v1/emails/:id/permanent        | Permanently delete a trashed email         | Yes  |
| POST   | /api/v1/emails/trash/empty          | Permanently delete all trashed emails      | Yes  |

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

### Suppressions

| Method | Path                                | Description                                | Auth |
|--------|-------------------------------------|--------------------------------------------|------|
| POST   | /api/v1/suppressions                | Add an address (idempotent upsert)         | Yes  |
| GET    | /api/v1/suppressions                | List, paginated, optional `?email=` filter | Yes  |
| GET    | /api/v1/suppressions/:id            | Get a suppression by ID                    | Yes  |
| DELETE | /api/v1/suppressions/:id            | Remove (recipient eligible immediately)    | Yes  |

`POST /api/v1/emails/send` returns HTTP 422 with `{ code: "RECIPIENT_SUPPRESSED", suppressionId }` when the recipient is on the calling key's list. No row inserted, no queue entry, no SMTP attempt. See [docs/suppressions.md](docs/suppressions.md) and [docs/bounces.md](docs/bounces.md).

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

### Dashboard (HTML)

| Method | Path                               | Description             | Auth     |
|--------|------------------------------------|-------------------------|----------|
| GET    | /dashboard/login                   | Login form              | No       |
| POST   | /dashboard/login                   | Validate password       | No       |
| POST   | /dashboard/logout                  | Clear session           | No       |
| GET    | /dashboard                         | Stats overview          | Session  |
| GET    | /dashboard/send                    | Compose & send email    | Session  |
| POST   | /dashboard/send                    | Queue email for send    | Session  |
| GET    | /dashboard/emails                  | Email logs + filters + bulk-select | Session |
| GET    | /dashboard/emails/trash            | Trashed emails view     | Session  |
| POST   | /dashboard/emails/bulk-trash       | Bulk move to trash      | Session  |
| POST   | /dashboard/emails/trash/bulk-restore   | Bulk restore        | Session  |
| POST   | /dashboard/emails/trash/bulk-permanent | Bulk hard-delete    | Session  |
| POST   | /dashboard/emails/trash/empty      | Empty email trash       | Session  |
| POST   | /dashboard/emails/:id/trash        | Move single to trash    | Session  |
| POST   | /dashboard/emails/:id/restore      | Restore single          | Session  |
| POST   | /dashboard/emails/:id/permanent    | Hard-delete single      | Session  |
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
| GET    | /dashboard/inbound                 | Inbound emails list + bulk-select | Session |
| GET    | /dashboard/inbound/trash           | Trashed inbound view    | Session  |
| POST   | /dashboard/inbound/bulk-trash      | Bulk move to trash      | Session  |
| POST   | /dashboard/inbound/trash/bulk-restore   | Bulk restore       | Session  |
| POST   | /dashboard/inbound/trash/bulk-permanent | Bulk hard-delete   | Session  |
| POST   | /dashboard/inbound/trash/empty     | Empty inbound trash     | Session  |
| POST   | /dashboard/inbound/:id/trash       | Move single to trash    | Session  |
| POST   | /dashboard/inbound/:id/restore     | Restore single          | Session  |
| POST   | /dashboard/inbound/:id/permanent   | Hard-delete single      | Session  |
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
- Private key encrypted at rest with AES-256-GCM via `DKIM_ENCRYPTION_KEY` (#23); public key provided as DNS TXT record value
- Decrypted in memory on each send and handed to nodemailer's signer; decrypt failure logs and falls through to unsigned mail (fail-open)

**Bounce → Suppression chain:** two paths converge on the same suppression list and webhook event.
- **Inline 5xx** during the SMTP transaction → caught in `processEmail`'s catch block via [`handleSendFailure`](src/modules/emails/services/queue.service.ts) + [`parseSmtpError`](src/utils/smtp-error.ts). Auto-suppress on attempt 1; **don't retry** (#68).
- **Async DSN** received at the inbound SMTP → routed to the bounce module ([src/modules/bounces/](src/modules/bounces/)) before generic inbound storage (#24).
- Hard bounces (5.x.x) → permanent per-API-key suppression in either path.
- Soft bounces (4.x.x) — async DSN path applies a 24h windowed suppression with escalation to permanent on a second soft bounce. Inline 4xx path preserves the existing retry-up-to-MAX_ATTEMPTS behaviour (the catch-block doesn't have enough signal to make a per-recipient soft → hard call safely).
- Subsequent sends to suppressed recipients return HTTP 422 with `code: "RECIPIENT_SUPPRESSED"` from the gate at `createEmail`.

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
      DKIM_ENCRYPTION_KEY: ${DKIM_ENCRYPTION_KEY}    # Required (#23) — `openssl rand -base64 32`
      DASHBOARD_PASSWORD: ${DASHBOARD_PASSWORD}      # Required in production (#19)
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

- Services throw; routes don't catch
- Elysia's global `onError` handler in [src/index.ts](src/index.ts) maps known error classes to structured JSON responses:
  - `NOT_FOUND` → 404 (HTML for `Accept: text/html`, JSON otherwise)
  - `SuppressedRecipientError` → 422 with `{ code: "RECIPIENT_SUPPRESSED", suppressionId }` (#25)
  - Unhandled errors → 500 with the error message (stack traces hidden in production)
- Email queue failures are logged and stored in the `last_error` column

---

## Future (v2+)

- Open/click tracking
- Multiple API keys with permissions
- Team access / multi-user
- Analytics dashboard with charts
- SDK packages (`npm i bunmail`)
- CLI tool (`bunx bunmail init`)
- Scheduled emails
- One-click unsubscribe endpoint (Gmail Feb-2024 List-Unsubscribe-Post)
- DMARC `rua` aggregate report ingest (#41)
- Webhook delivery persistence + replay (#30)
- Bun-native SMTP client (subsumes #37, #42 — see #60)
- Redis-backed rate limiting + queue for multi-instance deploys (#20)
