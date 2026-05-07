# BunMail

> Self-hosted email API for developers. No SendGrid. No limits. No cost. Just deploy and send.

---

> ⚠️ **Historical planning document.** This is the original scope/plan from before the project was built. Kept for reference. For the **current** state of the project, read these instead:
>
> - [README.md](README.md) — current features, endpoints, getting started
> - [ARCHITECTURE.md](ARCHITECTURE.md) — current architecture, schema, request flow
> - [CHANGELOG.md](CHANGELOG.md) — what shipped in each release
> - [docs/](docs/) — per-module reference docs

---

## The Problem

Every developer needs to send emails — auth codes, notifications, alerts, invoices. The options today:

- **SendGrid** — free tier is 100 emails/day, then you pay
- **Resend** — 3,000 emails/month free, then $20/mo
- **AWS SES** — cheap but complex setup, vendor lock-in
- **Gmail SMTP** — 500/day limit, Google can block you anytime
- **Mailgun** — no more free tier

You're always dependent on someone else's API, limits, and pricing.

---

## The Solution

A self-hosted, open-source email service built on **Bun + Elysia**.

One `docker compose up` and you have your own email infrastructure. No API keys, no monthly bills, no limits.

---

## Why Developers Will Love It

1. **Free forever** — you own the server, you own the emails
2. **No third-party dependency** — direct SMTP, no middleman
3. **Simple REST API** — `POST /send` and done, just like Resend/SendGrid
4. **Self-hosted** — your data stays on your server
5. **Built on Bun + Elysia** — fast, modern, lightweight

---

## Who Is This For

- Indie hackers tired of paying for email APIs
- Developers with side projects that need transactional emails
- Teams who want control over their email infra
- Anyone hitting free tier limits on SendGrid/Resend

---

## What It Does

- **Send emails** via REST API (no provider needed)
- **DKIM/SPF/DMARC** signing built-in (so emails don't land in spam)
- **Email queue** with automatic retries on failure
- **Templates** with variable injection
- **Logs & Analytics** — track sent, delivered, bounced, failed
- **Dashboard** — web UI to manage everything
- **Multi-domain** support
- **Webhooks** — get notified on bounce/delivery
- **Attachments** support
- **Rate limiting** to protect your IP reputation

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Bun |
| Backend | Elysia |
| SMTP Sending | Nodemailer (direct mode) |
| SMTP Receiving | smtp-server |
| Email Auth | DKIM, SPF, DMARC |
| Database | SQLite (simple) or PostgreSQL (scale) |
| Queue | Custom with retries |
| Frontend | React or Svelte |
| Deploy | Docker |

---

## Architecture

```
Your App
   ↓
Elysia API  →  Queue  →  SMTP Send (Nodemailer + DKIM)
   ↓                         ↓
Database              Recipient Inbox
   ↓
Dashboard (logs, analytics, templates)
```

---

## API Design

### Send an email

```
POST /api/v1/send
Authorization: Bearer <API_KEY>
```

```json
{
  "from": "hello@yourdomain.com",
  "to": "user@gmail.com",
  "subject": "Welcome!",
  "html": "<h1>Hello World</h1>",
  "text": "Hello World",
  "attachments": []
}
```

### Response

```json
{
  "id": "msg_abc123",
  "status": "queued",
  "from": "hello@yourdomain.com",
  "to": "user@gmail.com",
  "createdAt": "2026-03-03T10:00:00Z"
}
```

### Other Endpoints

```
GET    /api/v1/emails              — list sent emails
GET    /api/v1/emails/:id          — get email status
POST   /api/v1/templates           — create email template
GET    /api/v1/templates           — list templates
POST   /api/v1/send-template       — send using template
GET    /api/v1/analytics           — send/bounce/fail stats
POST   /api/v1/domains             — add a domain
GET    /api/v1/domains/:id/verify  — check DNS setup
POST   /api/v1/api-keys            — generate API key
GET    /api/v1/webhooks            — list webhooks
POST   /api/v1/webhooks            — register webhook
```

---

## Project Structure

```
bunmail/
├── docker-compose.yml
├── Dockerfile
├── package.json
├── bunfig.toml
├── src/
│   ├── index.ts                  — Elysia app entry
│   ├── config.ts                 — env + config
│   ├── routes/
│   │   ├── send.ts               — POST /send
│   │   ├── emails.ts             — email logs
│   │   ├── templates.ts          — template CRUD
│   │   ├── domains.ts            — domain management
│   │   ├── analytics.ts          — stats
│   │   ├── webhooks.ts           — webhook management
│   │   └── api-keys.ts           — API key management
│   ├── services/
│   │   ├── mailer.ts             — Nodemailer direct send
│   │   ├── dkim.ts               — DKIM signing
│   │   ├── queue.ts              — email queue + retries
│   │   ├── dns-checker.ts        — verify SPF/DKIM/DMARC
│   │   └── webhook.ts            — fire webhooks on events
│   ├── db/
│   │   ├── schema.ts             — database schema
│   │   ├── migrations/           — DB migrations
│   │   └── index.ts              — DB connection
│   ├── middleware/
│   │   ├── auth.ts               — API key auth
│   │   └── rate-limit.ts         — rate limiting
│   └── utils/
│       ├── logger.ts             — logging
│       └── crypto.ts             — key generation
├── dashboard/                    — frontend app
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Dashboard.tsx     — overview + stats
│   │   │   ├── Emails.tsx        — email logs
│   │   │   ├── Templates.tsx     — manage templates
│   │   │   ├── Domains.tsx       — domain setup wizard
│   │   │   ├── ApiKeys.tsx       — manage API keys
│   │   │   └── Settings.tsx      — config
│   │   └── components/
│   └── package.json
└── README.md
```

---

## MVP Features (v1)

- [ ] REST API to send emails (`POST /api/v1/send`)
- [ ] Direct SMTP sending via Nodemailer (no provider)
- [ ] DKIM signing
- [ ] SPF/DMARC DNS verification helper
- [ ] Email queue with retries (3 attempts)
- [ ] Send logs with status (queued, sent, delivered, bounced, failed)
- [ ] API key authentication
- [ ] Rate limiting
- [ ] Basic dashboard (send logs, stats)
- [ ] Domain management + DNS setup wizard
- [ ] Docker deployment
- [ ] README with setup guide

---

## Growth Features (v2+)

- [ ] Incoming email (receive emails via SMTP server)
- [ ] Email templates engine with variables
- [ ] Webhooks (bounce, delivery, open, click)
- [ ] Open tracking & click tracking
- [ ] Multiple API keys with permissions
- [ ] Team access / multi-user
- [ ] Analytics dashboard (charts, trends)
- [ ] SDK packages (`npm i bunmail`)
- [ ] CLI tool (`bunx bunmail init`)
- [ ] Scheduled emails (send later)
- [ ] Email preview / test mode
- [ ] Suppression list (unsubscribes, bounces)

---

## Competitors & Our Edge

| Tool | Language | Problem |
|---|---|---|
| Postal | Ruby | Heavy, complex setup |
| Mailtrain | Node | Focused on newsletters, not transactional |
| Haraka | Node | SMTP only, no API, no dashboard |
| Mail-in-a-Box | Python | Full mail server, overkill |
| **BunMail** | **Bun/Elysia** | **Lightweight, API-first, modern, simple** |

---

## DNS Setup (User Guide)

For emails to not land in spam, users need to add these DNS records:

### MX Record
```
Type: MX
Host: @
Value: mail.yourdomain.com
Priority: 10
```

### SPF Record
```
Type: TXT
Host: @
Value: v=spf1 a mx ip4:YOUR_SERVER_IP -all
```

### DKIM Record
```
Type: TXT
Host: bunmail._domainkey
Value: v=DKIM1; k=rsa; p=YOUR_PUBLIC_KEY
```

### DMARC Record
```
Type: TXT
Host: _dmarc
Value: v=DMARC1; p=quarantine; rua=mailto:dmarc@yourdomain.com
```

### Reverse DNS (PTR)
```
Set PTR record on your VPS to match your mail domain
```

BunMail's dashboard will have a DNS setup wizard that checks all of this automatically.

---

## Quick Start (Goal)

```bash
# Clone
git clone https://github.com/yourname/bunmail.git
cd bunmail

# Run
docker compose up -d

# Send your first email
curl -X POST http://localhost:3000/api/v1/send \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "hello@yourdomain.com",
    "to": "user@gmail.com",
    "subject": "Hello from BunMail!",
    "html": "<h1>It works!</h1>"
  }'
```

---

## One-Liner Pitch

> **BunMail — Self-hosted email API for developers. No SendGrid. No limits. No cost. Just deploy and send.**

---

## What Makes It "Repo of the Day"

- Solves a universal pain (every dev pays for email)
- "Free Resend/SendGrid alternative" tagline
- Modern stack (Bun + Elysia)
- Easy setup (`docker compose up`)
- Great dashboard screenshots for README
- Fills a gap in the JS/Bun ecosystem
