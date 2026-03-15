# Inbound Module

Receives emails via a built-in SMTP server and stores them in the database.

## Module Layout

```
src/modules/inbound/
├── inbound.plugin.ts                ← Elysia plugin (read-only API)
├── services/
│   └── smtp-receiver.service.ts     ← SMTP server (smtp-server + mailparser)
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

**Indexes:** `idx_inbound_received_at`

## Configuration

| Env Variable   | Default | Description                                |
|----------------|---------|--------------------------------------------|
| `SMTP_ENABLED` | `false` | Set to `true` to start the SMTP server     |
| `SMTP_PORT`    | `2525`  | Port for the inbound SMTP server           |

In production, set `SMTP_PORT=25` and configure your domain's MX record to point to your server.

## How It Works

1. The SMTP server accepts incoming connections (no auth required for inbound)
2. Each incoming message is parsed with `mailparser`
3. The sender, recipient, subject, HTML, text, and raw message are stored in `inbound_emails`
4. An `email.received` webhook event is fired to all subscribed webhooks

## Service Methods

#### `start(): void`
Starts the SMTP server on the configured port.

#### `stop(): void`
Gracefully shuts down the SMTP server.

## API Endpoints

All routes require Bearer token auth and are rate-limited.

| Method | Path                    | Description               |
|--------|-------------------------|---------------------------|
| GET    | /api/v1/inbound         | List received emails      |
| GET    | /api/v1/inbound/:id     | Get received email by ID  |
