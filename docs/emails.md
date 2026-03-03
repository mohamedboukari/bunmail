# Emails Module

Handles email queuing, delivery, and retrieval. Emails are queued via the REST API and delivered asynchronously using Nodemailer's direct SMTP mode.

## Schema

**Table:** `emails`

| Column          | Type           | Constraints             | Description                                 |
|-----------------|----------------|-------------------------|---------------------------------------------|
| `id`            | varchar(36)    | PK                      | Prefixed ID (`msg_<24 hex>`)                |
| `api_key_id`    | varchar(36)    | NOT NULL, FK → api_keys | Which API key queued this email              |
| `domain_id`     | varchar(36)    | nullable, FK → domains  | Sender domain (for DKIM, Phase 5)           |
| `from_address`  | varchar(255)   | NOT NULL                | Sender email address                        |
| `to_address`    | varchar(255)   | NOT NULL                | Recipient email address                     |
| `cc`            | text           | nullable                | Comma-separated CC recipients               |
| `bcc`           | text           | nullable                | Comma-separated BCC recipients              |
| `subject`       | varchar(500)   | NOT NULL                | Email subject line                          |
| `html`          | text           | nullable                | HTML body                                   |
| `text_content`  | text           | nullable                | Plain text body                             |
| `status`        | varchar(20)    | NOT NULL, default queued | `queued` → `sending` → `sent` / `failed`  |
| `attempts`      | integer        | NOT NULL, default 0     | Number of delivery attempts                 |
| `last_error`    | text           | nullable                | Error message from last failed attempt      |
| `message_id`    | varchar(255)   | nullable                | SMTP message ID (set after successful send) |
| `sent_at`       | timestamp      | nullable                | When the email was successfully delivered   |
| `created_at`    | timestamp      | NOT NULL, default now   | When the email was queued                   |
| `updated_at`    | timestamp      | NOT NULL, default now   | Last modification timestamp                 |

**Indexes:**

- `idx_emails_status_created` — `(status, created_at)` — queue processor uses this to find pending emails
- `idx_emails_api_key_id` — `(api_key_id)` — fast filtering by API key

## Module Layout

```
src/modules/emails/
├── emails.plugin.ts                ← Routes: POST /send, GET /, GET /:id
├── models/
│   └── email.schema.ts             ← Drizzle pgTable + indexes
├── dtos/
│   ├── send-email.dto.ts           ← Send email validation
│   └── list-emails.dto.ts          ← List query param validation
├── services/
│   ├── email.service.ts            ← CRUD operations (create, list, getById)
│   ├── mailer.service.ts           ← Nodemailer direct SMTP transport
│   └── queue.service.ts            ← Async queue processor with retries
├── serializations/
│   └── email.serialization.ts      ← Response mapper (hides apiKeyId, domainId)
└── types/
    └── email.types.ts               ← Email, SendEmailInput, ListEmailsFilters
```

## Service Methods

### email.service.ts

#### `createEmail(input: SendEmailInput, apiKeyId: string): Promise<Email>`

Inserts a new email into the database with status `queued`. The queue processor picks it up asynchronously.

#### `getEmailById(id: string, apiKeyId: string): Promise<Email | undefined>`

Retrieves a single email by ID, scoped to the requesting API key. Prevents cross-tenant data leakage.

#### `listEmails(apiKeyId: string, filters: ListEmailsFilters): Promise<{ data: Email[]; total: number }>`

Paginated listing with optional status filter. Returns data + total count for pagination.

### mailer.service.ts

#### `sendMail(options: SendMailOptions): Promise<{ messageId: string }>`

Sends an email via Nodemailer's direct SMTP mode. No relay server needed — connects directly to the recipient's MX server.

**Configuration:**
- `direct: true` — bypasses SMTP relay
- `name` — hostname used in SMTP HELO (from `MAIL_HOSTNAME` env var)

### queue.service.ts

#### `start(): void`

Starts the queue processor. On startup, recovers any emails stuck in `sending` status (crash recovery) by resetting them to `queued`. Then starts polling every 2 seconds.

#### `stop(): void`

Stops the queue processor gracefully. No new emails are picked up after this call.

#### `processQueue(): Promise<void>`

Fetches up to 5 `queued` emails and processes them in parallel.

#### `processEmail(email: Email): Promise<void>`

Handles a single email:
1. Set status → `sending`, increment `attempts`
2. Call `mailerService.sendMail()`
3. On success → set status `sent`, record `messageId` and `sentAt`
4. On failure:
   - If `attempts >= 3` → set status `failed`, record error
   - Otherwise → set status back to `queued` for retry

## Status Flow

```
queued ──→ sending ──→ sent ✓
  ↑           │
  └───────────┘ (retry, attempts < 3)
              │
              └──→ failed ✗ (attempts >= 3)
```

## Queue Architecture

- **Polling interval:** 2 seconds
- **Batch size:** 5 emails per cycle
- **Max attempts:** 3
- **Crash recovery:** On startup, `sending` → `queued` (for emails interrupted by server crash)
- **Storage:** Database-backed (survives restarts)
- **Processing:** In-memory poll loop (no Redis dependency for MVP)
