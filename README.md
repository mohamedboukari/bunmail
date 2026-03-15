# BunMail

> Self-hosted email API for developers. No SendGrid. No limits. No cost.

BunMail is a REST API for sending transactional emails with direct SMTP delivery, DKIM/SPF/DMARC signing, an email queue with retries, webhooks, email templates, inbound email receiving, and a web dashboard.

## Features

- **Direct SMTP delivery** — sends straight to recipient MX servers, no relay needed
- **DKIM signing** — auto-generates 2048-bit RSA keys per domain
- **DNS verification** — checks SPF, DKIM, and DMARC records
- **Email queue** — DB-backed with 3 retries and crash recovery
- **Webhooks** — HMAC-signed event notifications for email lifecycle events
- **Email templates** — Mustache-style `{{variable}}` substitution
- **Inbound SMTP** — receive and store incoming emails
- **API key auth** — SHA-256 hashed Bearer tokens with rate limiting
- **Web dashboard** — server-rendered UI for sending emails, managing templates, webhooks, domains, keys, and viewing inbound mail
- **OpenAPI spec** — auto-generated OpenAPI 3.0 docs at `/api/docs`
- **Docker ready** — one command to run the full stack

## Tech Stack

| Layer        | Technology                          |
|--------------|-------------------------------------|
| Runtime      | [Bun](https://bun.sh)              |
| Backend      | [Elysia](https://elysiajs.com)     |
| SMTP Sending | Nodemailer (direct mode + DKIM)     |
| SMTP Receiving | smtp-server + mailparser          |
| Database     | PostgreSQL                          |
| ORM          | Drizzle ORM (`drizzle-orm/bun-sql`) |
| Dashboard    | Elysia JSX (server-rendered)        |
| Deployment   | Docker + Docker Compose             |

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) v1.2+
- PostgreSQL (or [Neon](https://neon.tech) free cloud DB)

### Setup

```bash
# Clone the repository
git clone https://github.com/your-username/bunmail.git
cd bunmail

# Install dependencies
bun install

# Configure environment
cp .env.example .env
# Edit .env — at minimum set DATABASE_URL

# Push database schema (development)
bun run db:push

# Seed your first API key
bun run src/db/seed.ts
# Copy the raw key from the output — it's shown once!

# Start the dev server
bun run dev
```

### Send Your First Email

```bash
curl -X POST http://localhost:3000/api/v1/emails/send \
  -H "Authorization: Bearer bm_live_YOUR_KEY_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "hello@yourdomain.com",
    "to": "user@example.com",
    "subject": "Hello from BunMail!",
    "html": "<h1>It works!</h1>"
  }'
```

### Send with a Template

```bash
# 1. Create a template
curl -X POST http://localhost:3000/api/v1/templates \
  -H "Authorization: Bearer bm_live_YOUR_KEY_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Welcome",
    "subject": "Welcome, {{name}}!",
    "html": "<h1>Hello {{name}}</h1><p>Welcome to {{company}}.</p>",
    "variables": ["name", "company"]
  }'

# 2. Send using the template
curl -X POST http://localhost:3000/api/v1/emails/send \
  -H "Authorization: Bearer bm_live_YOUR_KEY_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "hello@yourdomain.com",
    "to": "user@example.com",
    "templateId": "tpl_YOUR_TEMPLATE_ID",
    "variables": { "name": "Alice", "company": "Acme Inc" }
  }'
```

## API Endpoints

All endpoints (except `/health`) require `Authorization: Bearer <api-key>`.

### Emails

| Method | Path                     | Description                     |
|--------|--------------------------|---------------------------------|
| POST   | `/api/v1/emails/send`    | Queue an email (direct or template) |
| GET    | `/api/v1/emails`         | List emails (paginated)         |
| GET    | `/api/v1/emails/:id`     | Get email by ID                 |

### Domains

| Method | Path                          | Description                 |
|--------|-------------------------------|-----------------------------|
| POST   | `/api/v1/domains`             | Register domain (auto-DKIM) |
| GET    | `/api/v1/domains`             | List domains                |
| GET    | `/api/v1/domains/:id`         | Get domain details          |
| POST   | `/api/v1/domains/:id/verify`  | Verify DNS records          |
| DELETE | `/api/v1/domains/:id`         | Delete domain               |

### Templates

| Method | Path                     | Description            |
|--------|--------------------------|------------------------|
| POST   | `/api/v1/templates`      | Create template        |
| GET    | `/api/v1/templates`      | List templates         |
| GET    | `/api/v1/templates/:id`  | Get template           |
| PUT    | `/api/v1/templates/:id`  | Update template        |
| DELETE | `/api/v1/templates/:id`  | Delete template        |

### Webhooks

| Method | Path                     | Description            |
|--------|--------------------------|------------------------|
| POST   | `/api/v1/webhooks`       | Register webhook       |
| GET    | `/api/v1/webhooks`       | List webhooks          |
| DELETE | `/api/v1/webhooks/:id`   | Delete webhook         |

### Inbound

| Method | Path                     | Description                 |
|--------|--------------------------|-----------------------------|
| GET    | `/api/v1/inbound`        | List received emails        |
| GET    | `/api/v1/inbound/:id`    | Get received email by ID    |

### API Keys

| Method | Path                     | Description            |
|--------|--------------------------|------------------------|
| POST   | `/api/v1/api-keys`       | Create API key         |
| GET    | `/api/v1/api-keys`       | List all keys          |
| DELETE | `/api/v1/api-keys/:id`   | Revoke a key           |

### Health

| Method | Path      | Description    | Auth |
|--------|-----------|----------------|------|
| GET    | `/health` | Health check   | No   |

See [docs/api.md](docs/api.md) for the full API reference.

## Development Commands

```bash
bun install              # Install dependencies
bun run dev              # Start dev server (watch mode)
bun run start            # Production start
bun run build            # Build for production
bun run db:generate      # Generate migration files
bun run db:migrate       # Run migrations
bun run db:push          # Push schema to DB (dev shortcut)
bun run db:studio        # Drizzle Studio UI
bunx tsc --noEmit        # Type-check
bun run lint             # ESLint
bun test                 # Run tests
```

## Architecture

```
Elysia API (modules/) → Services → Database (PostgreSQL / Drizzle)
                             ↓
                        Queue (retries) → SMTP Send (Nodemailer + DKIM)
                             ↓
                        Webhooks → Your app (HMAC-signed POST)
```

- **Modules** (`src/modules/`) — emails, domains, api-keys, webhooks, templates, inbound
- **Services** — Business logic: mailer, queue, DKIM, DNS verification, webhook dispatch
- **Middleware** (`src/middleware/`) — Bearer auth + sliding-window rate limiting
- **Database** (`src/db/`) — Drizzle ORM with PostgreSQL
- **Dashboard** (`src/pages/`) — Server-rendered JSX via `@elysiajs/html`

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system design.

## Docker

```bash
docker compose up -d
```

This starts BunMail + PostgreSQL. The app auto-runs database migrations on boot. API runs on port 3000, inbound SMTP on port 2525.

See [docs/self-hosting.md](docs/self-hosting.md) for the full deployment guide.

## Deliverability (Avoiding Spam)

To ensure emails land in the inbox, not spam, you need all of the following DNS records configured for your domain:

| Record | Example Value | Purpose |
|--------|---------------|---------|
| **SPF** | `v=spf1 a mx ip4:YOUR_IP ~all` | Tells receiving servers which IPs are allowed to send email on behalf of your domain. Prevents spoofing. |
| **DKIM** | 2048-bit RSA key (auto-generated) | Cryptographically signs outgoing emails so recipients can verify the message wasn't tampered with in transit. BunMail generates and manages DKIM keys automatically when you register a domain. |
| **DMARC** | `v=DMARC1; p=quarantine; rua=mailto:postmaster@yourdomain.com` | Instructs receiving servers how to handle emails that fail SPF/DKIM checks (`none` = monitor, `quarantine` = mark as spam, `reject` = drop). The `rua` address receives aggregate reports. |
| **MX** | `10 mail.yourdomain.com` | Points your domain's incoming mail to your server. Required even for outbound-only setups — many spam filters reject mail from domains without an MX record. The number (`10`) is priority (lower = preferred). |
| **PTR (rDNS)** | `mail.yourdomain.com.` | Maps your server IP back to a hostname. Must match your `MAIL_HOSTNAME`. Set by your VPS/hosting provider (not in your DNS panel). Many mail servers reject messages from IPs without a valid PTR record. |
| **A record** | `mail.yourdomain.com → YOUR_IP` | Maps your mail hostname to your server IP. Required for the MX and PTR records to resolve correctly. |

### How to verify

```bash
dig TXT yourdomain.com +short                           # SPF
dig TXT bunmail._domainkey.yourdomain.com +short        # DKIM
dig TXT _dmarc.yourdomain.com +short                    # DMARC
dig MX yourdomain.com +short                             # MX
dig -x YOUR_SERVER_IP +short                             # PTR (rDNS)
dig A mail.yourdomain.com +short                         # A record
```

### Test your score

Send a test email to [mail-tester.com](https://www.mail-tester.com) — aim for **8+/10**. Check your IP reputation at [mxtoolbox.com/blacklists.aspx](https://mxtoolbox.com/blacklists.aspx).

See [docs/self-hosting.md](docs/self-hosting.md#preventing-spam-deliverability-guide) for the full deliverability guide.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — System design and schemas
- [docs/api.md](docs/api.md) — Full API reference
- [docs/emails.md](docs/emails.md) — Emails module
- [docs/api-keys.md](docs/api-keys.md) — API keys module
- [docs/domains.md](docs/domains.md) — Domains module (DKIM + DNS verification)
- [docs/webhooks.md](docs/webhooks.md) — Webhooks module
- [docs/templates.md](docs/templates.md) — Templates module
- [docs/inbound.md](docs/inbound.md) — Inbound SMTP module
- [docs/dashboard.md](docs/dashboard.md) — Dashboard configuration
- [docs/self-hosting.md](docs/self-hosting.md) — Self-hosting guide

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)
