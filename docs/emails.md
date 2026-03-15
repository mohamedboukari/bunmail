# Emails Module

Handles email queuing, delivery, and retrieval. Emails are queued via the REST API and delivered asynchronously using Nodemailer's direct SMTP mode with DKIM signing.

## Schema

**Table:** `emails`

| Column          | Type           | Constraints             | Description                                 |
|-----------------|----------------|-------------------------|---------------------------------------------|
| `id`            | varchar(36)    | PK                      | Prefixed ID (`msg_<24 hex>`)                |
| `api_key_id`    | varchar(36)    | NOT NULL, FK → api_keys | Which API key queued this email              |
| `domain_id`     | varchar(36)    | nullable, FK → domains  | Sender domain (auto-linked for DKIM signing) |
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

- `idx_emails_status_created` — `(status, created_at)` — queue processor uses this
- `idx_emails_api_key_id` — `(api_key_id)` — fast filtering by API key

## Module Layout

```
src/modules/emails/
├── emails.plugin.ts                ← Routes: POST /send, GET /, GET /:id
├── models/
│   └── email.schema.ts             ← Drizzle pgTable + indexes
├── dtos/
│   ├── send-email.dto.ts           ← Send email validation (direct + template)
│   └── list-emails.dto.ts          ← List query param validation
├── services/
│   ├── email.service.ts            ← CRUD + template resolution + domain linking
│   ├── mailer.service.ts           ← Nodemailer direct SMTP + DKIM signing
│   ├── queue.service.ts            ← Async queue processor with retries + webhook dispatch
│   └── stats.service.ts            ← Dashboard stats aggregation
├── serializations/
│   └── email.serialization.ts      ← Response mapper (hides apiKeyId, domainId)
└── types/
    └── email.types.ts               ← Email, SendEmailInput, ListEmailsFilters
```

## Sending Modes

### Direct content

Provide `subject`, `html`, and/or `text` inline:

```json
{
  "from": "hello@example.com",
  "to": "user@example.com",
  "subject": "Hello!",
  "html": "<h1>Hello</h1>"
}
```

### Template-based

Provide `templateId` and `variables` — subject/body are rendered from the template:

```json
{
  "from": "hello@example.com",
  "to": "user@example.com",
  "templateId": "tpl_abc123...",
  "variables": { "name": "Alice" }
}
```

## Domain Linking

When an email is created, the sender's domain (from `from` address) is looked up in the `domains` table:

- If found, `domain_id` is set and DKIM signing uses the domain's private key
- In **production** mode (`BUNMAIL_ENV=production`), the domain must be registered or the request is rejected
- In **development** mode, unregistered domains are allowed (`domain_id` stays null)

## Service Methods

### email.service.ts

#### `createEmail(input, apiKeyId): Promise<Email>`
Creates an email record with status `queued`. Resolves templates if `templateId` is provided. Links the sender's domain for DKIM signing.

#### `getEmailById(id, apiKeyId): Promise<Email | undefined>`
Retrieves an email scoped to the requesting API key.

#### `listEmails(apiKeyId, filters): Promise<{ data, total }>`
Paginated listing with optional status filter.

### mailer.service.ts

#### `sendMail(options): Promise<{ messageId }>`
Sends an email via direct SMTP. When `dkim` options are provided, signs the message with the domain's RSA private key.

### queue.service.ts

#### `start(): void`
Starts the queue processor. Recovers interrupted emails, then polls every 2 seconds.

#### `stop(): void`
Stops the queue processor gracefully.

#### `processEmail(email): Promise<void>`
1. Marks as `sending`, increments attempts
2. Looks up DKIM keys for the sender's domain
3. Sends via SMTP with DKIM signing (if keys available)
4. On success: marks `sent`, fires `email.sent` webhook
5. On failure after 3 attempts: marks `failed`, fires `email.failed` webhook

## Status Flow

```
queued ──→ sending ──→ sent ✓  → webhook: email.sent
  ↑           │
  └───────────┘ (retry, attempts < 3)
              │
              └──→ failed ✗ (attempts >= 3) → webhook: email.failed
```

## Queue Architecture

- **Polling interval:** 2 seconds
- **Batch size:** 5 emails per cycle
- **Max attempts:** 3
- **Crash recovery:** On startup, `sending` → `queued`
- **DKIM:** Automatically signs with domain's RSA key when available
- **Webhooks:** Dispatches `email.sent` and `email.failed` events
