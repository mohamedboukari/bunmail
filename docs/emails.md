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
| `deleted_at`    | timestamp      | nullable                | Soft-delete marker — when set, the email is in trash and excluded from normal lists. Auto-purged after `TRASH_RETENTION_DAYS`. |

**Foreign keys:**

- `domain_id → domains.id` — `ON DELETE SET NULL`. Deleting a domain detaches its emails instead of blocking, preserving the email history while removing the domain.

**Indexes:**

- `idx_emails_status_created` — `(status, created_at)` — queue processor uses this
- `idx_emails_api_key_id` — `(api_key_id)` — fast filtering by API key
- `idx_emails_api_key_deleted` — `(api_key_id, deleted_at)` — trash list / purge queries

## Module Layout

```
src/modules/emails/
├── emails.plugin.ts                ← Routes: send, list, get, trash/restore/permanent/empty
├── models/
│   └── email.schema.ts             ← Drizzle pgTable + indexes
├── dtos/
│   ├── send-email.dto.ts           ← Send email validation (direct + template)
│   └── list-emails.dto.ts          ← List query param validation
├── services/
│   ├── email.service.ts            ← CRUD + trash/restore + template resolution + domain linking
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

## List-Unsubscribe

Every outbound message carries an RFC 2369 `List-Unsubscribe` header. Resolution rules:

| Domain config (in `domains` table) | Header(s) emitted |
|---|---|
| `unsubscribe_email = NULL`, `unsubscribe_url = NULL` | `List-Unsubscribe: <mailto:unsubscribe@{from-domain}>` |
| `unsubscribe_email = "optout@x.com"` | `List-Unsubscribe: <mailto:optout@x.com>` |
| `unsubscribe_url = "https://x.com/u/abc"` | `List-Unsubscribe: <mailto:unsubscribe@{from-domain}>, <https://x.com/u/abc>`<br>`List-Unsubscribe-Post: List-Unsubscribe=One-Click` |
| Both set | Both forms in the same `List-Unsubscribe`, plus the `One-Click` POST header |

**Why always-on?** Gmail and Yahoo's Feb-2024 sender requirements treat the presence of `List-Unsubscribe` as a positive ranking signal, including on transactional mail. The mailto-only form is sufficient for transactional senders. Bulk / promotional senders need the URL form too — Gmail's "high volume" thresholds (>5k/day to gmail) require RFC 8058 one-click via the URL + POST headers.

**Why per-domain config?** The default `unsubscribe@<domain>` mailbox often doesn't exist; emitting unroutable addresses is worse than a working override. Set `unsubscribeEmail` to a real mailbox you read, and `unsubscribeUrl` to a handler that processes the POST body (Gmail sends `List-Unsubscribe=One-Click` form-encoded).

## Service Methods

### email.service.ts

All read methods exclude trashed rows (`deleted_at IS NULL`) by default. Trash-specific methods explicitly target trashed rows.

**Reads (live)**

#### `createEmail(input, apiKeyId): Promise<Email>`
Creates an email record with status `queued`. Resolves templates if `templateId` is provided. Links the sender's domain for DKIM signing.

#### `getEmailById(id, apiKeyId): Promise<Email | undefined>`
Retrieves a non-trashed email scoped to the requesting API key.

#### `getEmailByIdUnscoped(id): Promise<Email | undefined>`
Dashboard variant — no API-key scope. Excludes trashed.

#### `listEmails(apiKeyId, filters): Promise<{ data, total }>` / `listAllEmails(filters)`
Paginated listing with optional status filter. Trashed rows excluded.

**Trash (scoped)**

#### `trashEmail(id, apiKeyId)` / `trashEmails(ids[], apiKeyId)`
Soft-delete (sets `deleted_at = NOW()`). Single or bulk. Idempotent. Returns the row or count.

#### `listTrashedEmails(apiKeyId, filters)`
Lists trashed rows for the API key, newest-trashed first.

#### `restoreEmail(id, apiKeyId)`
Clears `deleted_at`. Returns 404 if the row isn't currently trashed.

#### `permanentDeleteEmail(id, apiKeyId)`
Hard delete. Only operates on already-trashed rows.

#### `emptyEmailsTrash(apiKeyId)`
Permanently deletes every trashed email for the key. Returns count.

**Trash (unscoped — dashboard only)**

`trashEmailUnscoped`, `trashEmailsUnscoped`, `listTrashedEmailsUnscoped`, `getTrashedEmailByIdUnscoped`, `restoreEmailUnscoped`, `permanentDeleteEmailUnscoped`, `emptyEmailsTrashUnscoped` — same semantics, no API-key filter.

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
