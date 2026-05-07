# Inbound Module

Receives emails via a built-in SMTP server and stores them in the database.

## Bounce branching

Before any inbound message hits `inbound_emails`, the receiver runs it through the bounce parser. If the message is a Delivery Status Notification (DSN) — i.e. a bounce for one of our outbound sends — we route it to the bounce handler instead of generic inbound storage. See [docs/bounces.md](bounces.md) for the bounce flow.

Why this matters: bounces shouldn't pollute the inbound list (operators get noise about delivery failures from `mailer-daemon@gmail` every time someone mistypes an address), and the suppression-list auto-update only happens when bounces are processed as bounces.

## Module Layout

```
src/modules/inbound/
├── inbound.plugin.ts                ← Elysia plugin: list, get, trash/restore/permanent/empty
├── services/
│   ├── smtp-receiver.service.ts     ← SMTP server (smtp-server + mailparser)
│   └── inbound.service.ts           ← Reads + trash/restore/permanent/empty (DB layer)
├── models/
│   └── inbound-email.schema.ts      ← Drizzle pgTable definition
├── serializations/
│   └── inbound.serialization.ts     ← Response mapper (strips raw message)
└── types/
    └── inbound.types.ts             ← InboundEmail type
```

## Database Schema

Table: `inbound_emails`

| Column       | Type           | Constraints                |
|--------------|----------------|----------------------------|
| id           | varchar(36)    | PK, prefixed `inb_`       |
| from_address | varchar(255)   | NOT NULL                   |
| to_address   | varchar(255)   | NOT NULL                   |
| subject      | varchar(500)   | nullable                   |
| html         | text           | nullable                   |
| text_content | text           | nullable                   |
| raw_message  | text           | nullable (full RFC 822)    |
| received_at  | timestamp      | NOT NULL, default `now()`  |
| deleted_at   | timestamp      | nullable                   |

`deleted_at` is the soft-delete marker — set when an inbound email is moved to trash. Auto-purged after `TRASH_RETENTION_DAYS`.

**Indexes:** `idx_inbound_received_at`, `idx_inbound_deleted_at`

## Configuration

| Env Variable   | Default | Description                                |
|----------------|---------|--------------------------------------------|
| `SMTP_ENABLED` | `false` | Set to `true` to start the SMTP server     |
| `SMTP_PORT`    | `2525`  | Port for the inbound SMTP server           |

In production, set `SMTP_PORT=25` and configure your domain's MX record to point to your server.

## Spam Protection

Three layers of protection run before any email is processed. All are enabled by default.

### Layer 1 — DNSBL IP Check

Checks the connecting IP against a DNS blackhole list (default: [Spamhaus ZEN](https://www.spamhaus.org/zen/)). Blacklisted IPs are rejected with SMTP 554 before they can send data.

| Env Variable         | Default              | Description                     |
|----------------------|----------------------|---------------------------------|
| `SMTP_DNSBL_ENABLED` | `true`              | Enable/disable DNSBL checks     |
| `SMTP_DNSBL_ZONE`    | `zen.spamhaus.org`  | DNSBL zone to query             |

Private/loopback IPs and IPv6 addresses skip the DNSBL check.

### Layer 2 — Connection Rate Limiting

Per-IP sliding window rate limit on SMTP connections. Exceeding the limit returns SMTP 421 (temporary rejection).

| Env Variable            | Default | Description                       |
|-------------------------|---------|-----------------------------------|
| `SMTP_RATE_LIMIT_ENABLED` | `true` | Enable/disable rate limiting     |
| `SMTP_RATE_LIMIT_MAX`    | `10`   | Max connections per IP per window |
| `SMTP_RATE_LIMIT_WINDOW` | `60`   | Window size in seconds           |

### Layer 3 — Recipient Domain Validation

Rejects mail addressed to domains not registered in BunMail's Domains table. This prevents your server from being used as an open relay.

| Env Variable                | Default | Description                             |
|-----------------------------|---------|-----------------------------------------|
| `SMTP_RECIPIENT_VALIDATION` | `true`  | Enable/disable recipient domain checks  |

### Layer 4 — Envelope and Stream Hardening

Always-on protections (no env toggles):

- **Message size cap:** 10 MB. Advertised via the `SIZE` ESMTP extension and enforced inside the data stream — oversize messages are rejected with SMTP 552 and the buffered chunks are dropped immediately.
- **Recipient cap:** 50 RCPT TO commands per transaction. Beyond that the server replies SMTP 452 (too many recipients) so the connection can't be used as a fan-out relay.
- **MAIL FROM validation:** rejects addresses that don't match a basic email shape with SMTP 553. The empty envelope sender (`<>`) is allowed because it's how DSN bounces address themselves per RFC 3464.

### Fail-Open Design

All three layers fail open on errors (DNS timeout, DB unreachable). This means legitimate mail is never silently dropped due to transient failures.

## How It Works

1. Client connects → rate limit check (instant) → DNSBL check (DNS lookup)
2. RCPT TO command → recipient domain validated against registered domains
3. DATA command → message parsed with `mailparser`
4. Sender, recipient, subject, HTML, text, and raw message stored in `inbound_emails`
5. `email.received` webhook event fired to all subscribed webhooks

## Service Methods

### smtp-receiver.service.ts

#### `start(): void`
Starts the SMTP server on the configured port.

#### `stop(): void`
Gracefully shuts down the SMTP server.

### inbound.service.ts

All read methods exclude trashed rows by default; trash methods explicitly target trashed rows.

#### `listInboundEmails(filters)` / `getInboundEmailById(id)`
Live (non-trashed) reads, used by the API and dashboard.

#### `trashInboundEmail(id)` / `trashInboundEmails(ids[])`
Soft-delete single or bulk. Idempotent.

#### `listTrashedInboundEmails(filters)` / `getTrashedInboundEmailById(id)`
Trash-only reads.

#### `restoreInboundEmail(id)`
Clears `deleted_at`. 404 if not currently trashed.

#### `permanentDeleteInboundEmail(id)`
Hard-delete a trashed row.

#### `emptyInboundTrash()`
Permanently deletes every trashed inbound email. Returns count.

## API Endpoints

All routes require Bearer token auth and are rate-limited.

| Method | Path                                    | Description                           |
|--------|-----------------------------------------|---------------------------------------|
| GET    | `/api/v1/inbound`                       | List received emails (excludes trash) |
| GET    | `/api/v1/inbound/trash`                 | List trashed inbound                  |
| GET    | `/api/v1/inbound/:id`                   | Get inbound email by ID               |
| DELETE | `/api/v1/inbound/:id`                   | Move to trash                         |
| POST   | `/api/v1/inbound/bulk-delete`           | Bulk move to trash (`{ids: []}`)      |
| POST   | `/api/v1/inbound/:id/restore`           | Restore from trash                    |
| DELETE | `/api/v1/inbound/:id/permanent`         | Permanently delete a trashed row      |
| POST   | `/api/v1/inbound/trash/empty`           | Empty inbound trash                   |
