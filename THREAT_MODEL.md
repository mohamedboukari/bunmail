# BunMail — Threat Model

> Last reviewed: 2026-05-01

A self-hosted email service has a different threat surface than a SaaS one — there is no provider firewall in front of you, and you own the IP reputation, the database, the keys, and the abuse-response. This document walks the assets, the attackers we model against, the controls already in place, and the responsibilities that **stay with the operator**.

If you self-host BunMail, read the **Operator responsibilities** section. Some controls are not in the code and never will be.

## 1. Assets

| Asset | Why it matters |
|---|---|
| **API keys** (`api_keys.key_hash`) | Authenticate every API request. Compromise = full mail-send abuse. |
| **DKIM private keys** (`domains.dkim_private_key`) | Sign outbound mail as a verified sender. Compromise = an attacker can forge mail from your domain that passes DKIM. |
| **Email queue + history** (`emails`, `inbound_emails`) | Contains every recipient address, subject, and body that has flowed through the system. PII / commercial intelligence. |
| **Sending IP reputation** | Earned over weeks. A few hours of abuse can take it months to recover. |
| **Webhook secrets** (`webhooks.secret`) | HMAC keys shared with the consumer. Compromise = forged webhook deliveries. |
| **Dashboard session secret** (`SESSION_SECRET`) | HMAC key for browser sessions. Compromise = arbitrary dashboard access without password. |

## 2. Attackers we model against

| Attacker | Goal | Realistic? |
|---|---|---|
| **Spam operator on the public internet** | Use BunMail as an open relay (inbound SMTP) or to send mail through stolen API keys. | Constant — assume always present. |
| **Internet scanner** | Find exposed dashboards, leaked `.env` files, vulnerable endpoints. | Constant. |
| **Compromised API consumer** | A leaked key sends mail from real domains. | Likely over time. |
| **Insider with DB read** (read-only replica access, leaked dump) | Recover DKIM keys, harvest recipient lists, read inbound mail. | Likely on careless backups. |
| **Privileged insider with DB write** | Forge mail history, grant their own API keys, exfiltrate. | Lower likelihood; full DB write effectively bypasses the app. |
| **Network adversary on egress path** | Strip TLS on outbound to recipients (downgrade attack). | Realistic on hostile networks; mostly irrelevant on cloud egress. |
| **Web XSS in dashboard** | Steal session cookie, send mail. | Mitigated by JSX auto-escaping + `safe` discipline. |

We **do not** model nation-state attackers with side-channel access to the host — if they're on the box, the game is already over.

## 3. Trust boundaries

```
   ┌────────────────────────────────────────────────────────────────┐
   │  PUBLIC INTERNET                                               │
   │                                                                │
   │  ┌────────────────┐         ┌──────────────────────────────┐   │
   │  │ API consumer   │  TLS    │ Recipient MX servers         │   │
   │  │  (Bearer key)  │◄──────►│  (Gmail, Outlook, …)          │   │
   │  └───────┬────────┘         └──────────▲───────────────────┘   │
   └──────────┼─────────────────────────────┼───────────────────────┘
              │                             │ STARTTLS opportunistic
              ▼                             │
   ┌──────────────────────────────────────────────────────────────┐
   │  HOST (your VPS / bare metal)                                │
   │                                                              │
   │  ┌──────────────────────────┐    ┌────────────────────────┐  │
   │  │ Elysia: REST + dashboard │───►│ PostgreSQL             │  │
   │  └──────────┬───────────────┘    │  • API keys (hashed)   │  │
   │             │                    │  • DKIM keys (PEM)     │  │
   │             ▼                    │  • email queue + body  │  │
   │  ┌──────────────────────────┐    └────────────────────────┘  │
   │  │ smtp-server (inbound)    │                                │
   │  └──────────────────────────┘                                │
   └──────────────────────────────────────────────────────────────┘
```

The trust boundaries are: **public internet ↔ host** and **app process ↔ database**. Anything inside a single trust boundary is presumed cooperative; anything crossing one needs validation, authentication, or transport encryption.

## 4. What's mitigated in code today

### Authentication

- **API keys** are stored only as SHA-256 hashes (`api_keys.key_hash` is `UNIQUE`); the raw `bm_live_…` value is shown once at creation and never persisted. Bearer tokens are validated on every authenticated request via `src/middleware/auth.ts` — the lookup is cached on the `Request` (`WeakMap`) so we hash + query once per request.
- **Dashboard sessions** use HMAC-SHA256 over a Unix timestamp (`createSessionCookie` in `src/pages/pages.plugin.tsx`). Cookies are `HttpOnly` + `SameSite=Lax`. Validation uses `crypto.timingSafeEqual` to defeat timing oracles.
- **Production guard:** the app refuses to start when `BUNMAIL_ENV=production` and `DASHBOARD_PASSWORD` is empty (`src/config.ts`). The dashboard exposes unscoped read/write across all keys; an unprotected production deployment would leak everyone's mail.

### Inbound SMTP open-relay defences

Spam protection runs in four layers (`src/modules/inbound/services/smtp-receiver.service.ts`):

1. **Per-IP connection rate limiting** — sliding window, 10 connections / 60 s by default.
2. **DNSBL check** — Spamhaus ZEN by default. Listed IPs get SMTP 554 before they can issue `MAIL FROM`.
3. **Recipient domain validation** — RCPT TO is rejected with SMTP 550 unless the recipient's domain is registered in BunMail's `domains` table. This is the primary anti-relay control.
4. **Envelope + stream hardening** (#18):
   - SMTP `SIZE` extension caps messages at 10 MB; the `onData` stream re-counts bytes and aborts with SMTP 552 if a non-conforming client tries to overflow.
   - `RCPT TO` is rejected with SMTP 452 once 50 recipients are accepted in one transaction.
   - `MAIL FROM` is shape-validated; malformed envelopes get SMTP 553. Empty sender (`<>`) is preserved for legitimate DSN bounces.

All four layers **fail open** on internal errors (DNS timeout, DB unreachable) so legitimate mail isn't dropped on infrastructure hiccups.

### Outbound delivery

- **DKIM signing** uses per-domain RSA-2048 keys generated at registration time and stored in `domains.dkim_private_key`.
- **Opportunistic STARTTLS** (#21): every recipient MX that advertises STARTTLS is upgraded to TLS. Only legacy receivers without STARTTLS support stay in plaintext.
- **Body size cap** (#26): `html` and `text` are validated at the DTO layer at 5 MB each — oversize bodies return `422` instead of pushing into the queue and crashing the transport on retry.
- **Queue isolation:** trashed and soft-deleted rows are excluded from the queue selector (`src/modules/emails/services/queue.service.ts`) so a deletion mid-flight cancels the send.

### HTTP API hygiene

- **Per-API-key rate limiting** (`src/middleware/rate-limit.ts`): 100 requests / 60 s, sliding window.
- **Cleanup interval** (#22): the in-memory rate-limit map is pruned every 5 minutes so distinct keys can't grow it unbounded.
- **CORS:** none configured by default — the API is intended for server-to-server use. Operators that need browser-side access should add CORS deliberately.

### Webhooks

- Outgoing webhook payloads are HMAC-SHA256 signed using the per-webhook secret and sent in the `X-BunMail-Signature` header (`src/modules/webhooks/services/webhook-dispatch.service.ts`).
- **Replay protection** is tracked separately in **#43** — the current signature covers the body only; a captured payload can be replayed against the receiver. Add the `X-BunMail-Timestamp` header + a `|now - timestamp| < 5 min` check on the consumer side once #43 lands.

### Dashboard XSS

- `@kitajs/html` requires explicit `safe` on user-supplied strings; everything else is escaped. The current dashboard codebase audits clean — search for `unsafe`, `innerHTML`, or raw `{{...}}` interpolation if you fork.

### Logging

- The structured logger doesn't emit secrets — `key_hash`, `dkim_private_key`, and `SESSION_SECRET` are never logged.
- Recipient PII (`from`, `to`) **does** currently appear in info logs. Tracked in #33 — a per-env redaction helper is the planned mitigation.

## 5. What's NOT mitigated in code (operator responsibilities)

These are the controls the codebase cannot apply for you. If you skip them, the threat model breaks.

| Control | What you must do |
|---|---|
| **Disk encryption / DB volume** | DKIM private keys are stored in PEM (#23 will encrypt them at rest with `DKIM_ENCRYPTION_KEY`). Until that ships, treat the Postgres volume and any backups as secret-bearing. Encrypt the disk; lock down backup storage. |
| **Reverse proxy + TLS termination** | The dashboard ships HTTP-only on port 3000. Put it behind nginx/Caddy/Cloudflare with a real cert. Never expose `:3000` directly. |
| **Firewall / port hygiene** | Inbound SMTP listens on port 25 (or 2525 if `SMTP_PORT=2525`). Block every other port from the public internet. Specifically block `:5432` so the database isn't reachable from anywhere except the app process. |
| **`.env` secrecy** | `DATABASE_URL`, `DASHBOARD_PASSWORD`, `SESSION_SECRET`, and `POSTGRES_PASSWORD` live in `.env`. Don't commit it. Don't paste it into chat tools. Rotate if it leaks. |
| **PTR / reverse DNS** | Set the rDNS record for your sending IP to match `MAIL_HOSTNAME`. Without this, mail goes to spam regardless of code-side hardening. |
| **SPF / DKIM / DMARC publishing** | BunMail tells you what records to publish; you have to actually publish them and keep them current. |
| **IP reputation monitoring** | Watch [mxtoolbox.com/blacklists.aspx](https://mxtoolbox.com/blacklists.aspx) for your sending IP. Address listings within hours, not weeks. |
| **OS / runtime patches** | `bun upgrade`, `apt upgrade`, container image rebuilds. The codebase can't keep itself current. |
| **API key rotation** | Treat `bm_live_…` keys like any other secret. Revoke (set `is_active = false`) and rotate periodically. |
| **Backup integrity** | Test restores. A backup you can't restore is not a backup. |
| **Dashboard access scope** | The dashboard is admin-only — anyone who logs in sees every email across every API key. Don't share the password. |
| **Scaling caveats** | Rate limit + queue state are in-memory. Multiple replicas would each have their own counters and could double-send the same queued row. The queue race is tracked in #20 — until it's fixed, run a single replica. |

## 6. Known residual risks

These are real but accepted (or pending) trade-offs.

- **Outbound certificate validation is relaxed** (`rejectUnauthorized: false` in `mailer.service.ts`). MTA-to-MTA delivery routinely hits self-signed and expired certs; refusing them would mean dropping legitimate mail to a substantial fraction of receivers. Per-domain `requireValidCert` is tracked in #42 and per-send TLS metrics in #37.
- **DKIM private keys are PEM at rest.** Tracked in #23. Mitigate today via disk encryption + backup secrecy.
- **Webhook signature lacks replay protection.** Tracked in #43.
- **Recipient PII in logs.** Tracked in #33.
- **No bounce parsing / suppression list.** Repeated sends to bouncing addresses tank IP reputation. Tracked in #24 and #25.
- **Single-replica queue.** A second instance would double-send queued rows. Tracked in #20.

## 7. Reporting a vulnerability

See [SECURITY.md](SECURITY.md). Use GitHub's private vulnerability reporting — don't open a public issue.
