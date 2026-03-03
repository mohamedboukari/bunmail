# BunMail

> Self-hosted email API for developers. No SendGrid. No limits. No cost.

BunMail is a REST API for sending transactional emails with direct SMTP delivery, DKIM/SPF/DMARC signing, an email queue with retries, and a web dashboard.

## Tech Stack

| Layer        | Technology                          |
|--------------|-------------------------------------|
| Runtime      | [Bun](https://bun.sh)              |
| Backend      | [Elysia](https://elysiajs.com)     |
| SMTP         | Nodemailer (direct mode, no relay)  |
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
# Edit .env and set DATABASE_URL

# Push database schema
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

## API Endpoints

All endpoints (except `/health`) require `Authorization: Bearer <api-key>`.

### Emails

| Method | Path                     | Description            |
|--------|--------------------------|------------------------|
| POST   | `/api/v1/emails/send`    | Queue an email         |
| GET    | `/api/v1/emails`         | List emails (paginated)|
| GET    | `/api/v1/emails/:id`     | Get email by ID        |

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
bun test                 # Run tests
```

## Architecture

```
Elysia API (routes/) → Services (services/) → Database (db/)
                            ↓
                       Queue (retries) → SMTP Send (Nodemailer + DKIM)
```

- **Routes** (`src/modules/*/`) — REST API endpoints under `/api/v1/`
- **Services** — Business logic: mailer, queue, DKIM, DNS verification
- **Middleware** (`src/middleware/`) — Bearer auth + rate limiting
- **Database** (`src/db/`) — Drizzle ORM with PostgreSQL

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system design.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — System design, schemas, deployment
- [docs/api.md](docs/api.md) — Full API reference
- [docs/emails.md](docs/emails.md) — Emails module documentation
- [docs/api-keys.md](docs/api-keys.md) — API keys module documentation

## Docker

```bash
docker compose up -d
```

This starts BunMail + PostgreSQL. The app runs on port 3000.

## License

MIT
