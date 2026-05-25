# Inbound Module

Receives emails via a built-in SMTP server and stores them in the database.

## Replying from the dashboard (#86)

Inbound email detail pages have a **Reply** button that opens the compose form with a reply skeleton pre-populated:

- **From** = the address that received the inbound (the user's own address), so SPF / DKIM / DMARC alignment is preserved.
- **To** = the original sender.
- **Subject** = original subject prefixed with `Re: ` (idempotent — already-`Re:`-prefixed subjects aren't double-prefixed).
- **HTML body** = original HTML wrapped in a `<blockquote>` with an `On <date>, <sender> wrote:` attribution line.
- **Text body** = original text quoted with `> ` line prefixes + the same attribution.

The reply route is `GET /dashboard/inbound/:id/reply` — a normal navigation, no side effects until the operator clicks Send. The operator can edit any field before sending, including swapping the From domain or rewriting the quoted body.

**Out of scope (Phase 2):** RFC 5322 threading headers (`In-Reply-To`, `References`). Phase 1 ships the compose UX; proper threading needs new columns on `emails` and is deferred.

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

### First-boot checklist (Docker Compose)

Inbound is **off by default** — sending-only is the common use case, and an open SMTP receiver is a footgun if it isn't configured deliberately. To turn it on with Docker Compose, three things have to agree:

1. **`.env`**: set `SMTP_ENABLED=true` and `SMTP_PORT=25`.
2. **`docker-compose.yml`**: uncomment the inbound SMTP port line under `services.app.ports`. It's commented out by default so a fresh checkout doesn't try to bind host port 25 unexpectedly.
3. **DNS**: add an `MX` record for your domain pointing at the host running BunMail.

Then `docker compose up -d --build`. From outside the host, verify with `nc -zv <your-host> 25` — the connection should be accepted. If it isn't, check `docker compose logs app` for the line `Inbound SMTP receiver disabled` — that means step 1 wasn't picked up.

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
