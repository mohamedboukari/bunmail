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
| `status`        | varchar(20)    | NOT NULL, default queued | `queued` → `sending` → `sent` / `failed`. `sent` rows can later transition to `bounced` when a DSN comes back (#24). |
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
queued ──→ sending ──→ sent ✓        → webhook: email.sent
  ↑           │  │         │
  │           │  │         ↓ (async DSN arrives later)
  │           │  │       bounced ✗  → webhook: email.bounced (source: rfc3464/fallback)
  │           │  │                     set by bounce handler (#24)
  │           │  │
  │           │  └───→ bounced ✗     → webhook: email.bounced (source: inline)
  │           │       (inline 5xx)     set by handleSendFailure (#68)
  │           │                        on attempt 1 — stops retrying
  │           │
  └───────────┴───→ queued (retry, attempts < 3, soft 4xx or infra error)

queued ──→ sending ──→ failed ✗ (attempts >= 3, soft 4xx or infra error)
                       → webhook: email.failed (never confirmed unreachable)
```

| Status | Meaning |
|---|---|
| `queued` | Waiting for the queue processor |
| `sending` | Mid-SMTP-transaction |
| `sent` | SMTP transaction succeeded; recipient's MX accepted |
| `bounced` | The recipient is permanently unreachable. Set either when an inline 5xx came back during the SMTP transaction (#68) **or** when a DSN arrived later (#24). Auto-suppression fires in both cases. |
| `failed` | All retries exhausted on a transient (4xx) or infrastructure error. We never confirmed whether the recipient is reachable. |

See [docs/bounces.md](bounces.md) for both bounce paths.

## Multi-MX Delivery (#87)

Each `emails` row can address recipients across multiple domains (`to` + `cc` + `bcc`). On send, the mailer service:

1. Parses all three fields into a flat recipient list (kind preserved; `to` > `cc` > `bcc` precedence on dedup).
2. Resolves the MX for each unique domain — one DNS query per domain, issued in parallel.
3. **Groups recipients by destination MX**. Two domains that share an MX (CNAME aliases, shared receiving infrastructure) merge into one group — fewer SMTP connections.
4. Generates one canonical `Message-ID:` for the whole email so all recipients see the same identifier (bounce/complaint feedback loops join on this).
5. For each MX group, opens one SMTP session and submits the **same DKIM-signed message** with `envelope.to` overridden to that group's recipients only.

The `To:` / `Cc:` headers on the rendered message always carry the **original full lists** so every recipient sees who else was addressed. BCC addresses appear only in their MX group's envelope, never in the rendered headers.

### Aggregate status semantics

| Outcome | Email status | Auto-suppression | Retry |
|---|---|---|---|
| All groups deliver | `sent` | — | — |
| All groups fail, inline 5xx | `bounced` | `to` only | — |
| All groups fail, transient | `queued` | — | yes (3 attempts) |
| Mixed success | `sent` (with `lastError`) | per-recipient on 5xx groups | **no** (Phase 2) |

### Partial-failure caveat (Phase 2 follow-up)

When some MX groups succeed and others fail, the email row is marked `sent` and the failed groups are surfaced through `lastError` + the per-recipient `email.bounced` webhook. The row is **not** retried — retrying would double-send to the groups that already delivered, since the queue currently tracks state per-row, not per-group. Tracked separately for follow-up (Phase 2, #97): add a `delivery_state` JSONB column on `emails` so a retry can skip groups already marked `sent`.

## Queue Architecture

- **Polling interval:** 2 seconds
- **Batch size:** 5 emails per cycle
- **Max attempts:** 3
- **Atomic claim:** Each cycle's `queued → sending` transition is one statement guarded by Postgres `FOR UPDATE SKIP LOCKED` (#20). Concurrent workers always see disjoint claims — running multiple BunMail instances against the same DB will not double-send.
- **Per-MX throttle (#91):** SMTP sessions are throttled per destination MX via a module-level semaphore (`src/utils/mx-throttle.ts`). Default is **one parallel session per MX** (configurable via `MAIL_MX_CONCURRENCY`). Sends to different MXs run in parallel; sends to the same MX serialize. The semaphore holds across poll cycles, so back-to-back batches that share a destination can't pile up either. This is what stops strict receivers (Outlook, Yahoo) from `421`ing parallel sessions from the same source IP. Operators with established IP reputation can raise the cap to 2-3; values above 3 are rarely worth it.
- **Crash recovery:** On startup, `sending` → `queued`
- **DKIM:** Automatically signs with domain's RSA key when available
- **Webhooks:** Dispatches `email.sent` and `email.failed` events

## Tombstones (#34)

Hard-deleting an email — whether by the periodic trash purge sweep, the per-row `DELETE /:id/permanent` API, or the bulk `POST /trash/empty` — writes a snapshot to the `email_tombstones` table **before** it actually deletes the row. Tombstones preserve only **identifiers**: `id`, `apiKeyId`, `messageId`, `fromAddress`, `toAddress`, `subject`, `status`, `sentAt`, `deletedAt`, `purgedAt`. Body / html / text are deliberately dropped — purging the body is the whole point of trash retention; the tombstone is forensic-only.

### Why

When a complaint, late bounce, or compliance audit arrives weeks later referring to a `Message-ID`, an operator needs to be able to answer "did we send this?". Without tombstones, the row was gone after the trash purge ran and that question was unanswerable. With them, the read API at `GET /api/v1/emails/tombstones?messageId=…` returns the snapshot in milliseconds.

### Lifecycle

```
emails row (sent/bounced/failed)
       │
       ▼  user soft-deletes (deleted_at = now())
emails row (in trash)
       │
       ▼  TRASH_RETENTION_DAYS later — purge sweep, or operator hits "permanent"
       │  ╳── all five hard-delete paths route through `deleteEmailsWithTombstones`
       │     which wraps INSERT INTO email_tombstones + DELETE FROM emails in one tx
       ▼
email_tombstones row (snapshot)  ←─ readable via API + dashboard for TOMBSTONE_RETENTION_DAYS
       │
       ▼  TOMBSTONE_RETENTION_DAYS later — `runTombstoneRetention` sweeps it
(gone forever)
```

### Snapshot semantics — no foreign keys

Tombstones must outlive the `api_keys` row that owned the original email — exactly the audit-trail use case is "you revoked the key, but a complaint about a message it sent six weeks ago just arrived". So `apiKeyId` on the tombstone is a **denormalised text snapshot**, not a FK. CASCADE on api_keys deletion does not touch tombstones.

### Read API

```bash
# Trace a Message-ID (the bounce/complaint hot path).
# Accepts both wrapped and unwrapped forms — operators paste from logs / DSNs.
curl https://your-host/api/v1/emails/tombstones?messageId=abc-123@your-domain \
  -H "Authorization: Bearer $BM_KEY"

# Or by original email id:
curl https://your-host/api/v1/emails/tombstones/msg_abc123... \
  -H "Authorization: Bearer $BM_KEY"
```

Dashboard equivalent: `/dashboard/emails/tombstones` with a Message-ID search box.

### Configuration

```bash
TOMBSTONE_RETENTION_DAYS=90   # default; how long tombstones survive their parent's hard-delete
```

### Out of scope

- **Inbound tombstones.** Inbound emails have a different shape (`fromAddress` / `receivedAt` instead of `toAddress` / `sentAt`); the audit-trail value is real but a separate ticket. Today the inbound trash purge still hard-deletes without a snapshot.
- **Restore from tombstone.** Tombstones don't keep the body — there's nothing to restore. They're read-only forensic data.
