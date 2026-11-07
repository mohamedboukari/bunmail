# BunMail Architecture

> Self-hosted email API for developers. No SendGrid. No limits. No cost.

---

## System Overview

```
                        ┌─────────────────────────────────┐
                        │         Your Application        │
                        └────────────────┬────────────────┘
                                         │ POST /api/v1/emails/send
                                         │ Authorization: Bearer <API_KEY>
                                         ▼
┌────────────────────────────────────────────────────────────────────┐
│                         BunMail Server                             │
│                                                                    │
│  ┌──────────────┐    ┌──────────────┐    ┌───────────────────┐     │
│  │  Elysia API  │───▶│   Services   │───▶│    PostgreSQL     │     │
│  │  (Routes)    │    │  (Business   │    │    (Drizzle ORM)  │     │
│  │              │    │   Logic)     │    │                   │     │
│  └──────────────┘    └──────┬───────┘    └───────────────────┘     │
│         │                   │                                      │
│         │                   ▼                                      │
│  ┌──────────────┐    ┌──────────────┐    ┌───────────────────┐     │
│  │  Middleware  │    │ Email Queue  │───▶│  Nodemailer SMTP  │     │
│  │  - Auth      │    │ (backoff)    │    │  (direct to MX)   │     │
│  │  - Rate Limit│    │              │    │  + DKIM Signing   │     │
│  └──────────────┘    └──────────────┘    └────────┬──────────┘     │
│                                                    │               │
│  ┌──────────────┐                                  │               │
│  │   Pages      │    JSX server-rendered           │               │
│  │  /dashboard  │    via @elysiajs/html            │               │
│  └──────────────┘                                  │               │
│                                                    │               │
└────────────────────────────────────────────────────┼───────────────┘
                                                     │
                                                     ▼
                                          ┌────────────────────┐
                                          │  Recipient's MX    │
                                          │  Server (Gmail,    │
                                          │  Outlook, etc.)    │
                                          └────────────────────┘
```

---

## Tech Stack

| Layer            | Technology                          |
|------------------|-------------------------------------|
| Runtime          | Bun                                 |
| Backend          | Elysia                              |
| SMTP Sending     | Nodemailer, one transport per recipient MX on port 25, failover across MX hosts, no relay |
| Email Auth       | DKIM signing (AES-256-GCM at rest), SPF/DMARC DNS checks |
| Database         | PostgreSQL                          |
| ORM              | Drizzle ORM (`drizzle-orm/bun-sql`) |
| Dashboard        | Elysia JSX (`@elysiajs/html`)       |
| Deployment       | Docker + Docker Compose             |

---

## Project Structure

```
bunmail/
├── ARCHITECTURE.md
├── CLAUDE.md
├── BunMail-Plan.md
├── README.md
├── package.json
├── tsconfig.json
├── bunfig.toml
├── drizzle.config.ts
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── .gitignore
├── drizzle/                              ← Generated migrations
├── src/
│   ├── index.ts                          ← Elysia app entry point
│   ├── config.ts                         ← Assembles `config` from config/ and re-exports its readers
│   ├── config/                           ← Env readers with validation and the `config` section builders, one file per area (env, app, mail, auth, sso, smtp, retention, observability, storage)
│   ├── db/
│   │   ├── index.ts                      ← Drizzle DB connection
│   │   ├── schema.ts                     ← Re-exports all model schemas
│   │   ├── migrate.ts                    ← Bun-native migration runner (#56)
│   │   ├── encrypt-domain-keys.ts        ← Boot-time pass that encrypts legacy plaintext DKIM keys (#23)
│   │   ├── encrypt-webhook-secrets.ts    ← Boot-time pass that encrypts legacy plaintext webhook secrets (#259)
│   │   ├── jsonb.ts                      ← jsonb column type that stores real JSON, not a JSON string (#261)
│   │   ├── seed.ts                       ← Creates the first (admin) API key: `bun run src/db/seed.ts`
│   │   └── reset-owner.ts                ← Shell-only recovery: prints a fresh owner setup link (#215)
│   ├── middleware/
│   │   ├── request-context.ts            ← Request ID, X-Request-Id and the per-request log line (#284)
│   │   ├── security-headers.ts           ← CSP (page policy on / and /dashboard, baseline elsewhere), nosniff, X-Frame-Options, Referrer-Policy, HSTS, dashboard no-store (#255)
│   │   ├── auth.ts                       ← API key bearer auth
│   │   ├── last-used-throttle.ts         ← Once-a-minute claim of the last_used_at write per key, shared store (#185)
│   │   ├── rate-limit.ts                 ← Per-API-key rate limiter: Elysia wiring + cleanup timer
│   │   ├── rate-limit-core.ts            ← Pure fixed-window algorithm (unit-tested, #174)
│   │   └── login-rate-limit.ts           ← Per-IP dashboard login brute-force limiter (#109)
│   ├── utils/
│   │   ├── id.ts                         ← Prefixed ID generator
│   │   ├── logger.ts                     ← Structured JSON logger: adds the log context, redacts secret-named fields (#284)
│   │   ├── log-context.ts                ← Request/job/SMTP-session correlation IDs on AsyncLocalStorage (#284)
│   │   ├── tracing.ts                    ← OpenTelemetry spans, API only: start/stop, withSpan, SMTP session spans (#363)
│   │   ├── tracing-sdk.ts                ← The OpenTelemetry SDK setup, loaded by a dynamic import only when tracing is on (#363)
│   │   ├── redact.ts                     ← PII-aware email redaction for logs (#33)
│   │   ├── db-error.ts                   ← A failed write's log text: SQLSTATE only for drizzle query errors (#184)
│   │   ├── mx-throttle.ts                ← Outbound session semaphore, keyed by provider bucket (#91, #250), shared across replicas with Redis (#185)
│   │   ├── shared-store.ts               ← Fixed-window counters and one-time entries (with an atomic `claim`, #224): in memory, or the Redis backend (#185)
│   │   ├── redis-store.ts                ← Redis backend on Bun's RedisClient: Lua scripts, hashed and encrypted reveals, reconnect (#185)
│   │   ├── shared-slots.ts               ← Counting semaphores with leased slots (MX sessions): in memory, or the Redis backend (#185)
│   │   ├── redis-slots.ts                ← Redis side of the slots: sorted sets, one Lua script per step, Redis clock (#185)
│   │   ├── shared-tokens.ts              ← Token buckets (MX rate budget): in memory, or the Redis backend (#391)
│   │   ├── redis-tokens.ts               ← Redis side of the token buckets: one hash and one Lua script per take, Redis clock (#391)
│   │   ├── recipients.ts                 ← Recipient parsing and grouping per recipient domain (#87)
│   │   ├── smtp-error.ts                 ← Classifies an SMTP reply as hard, policy or soft (#68, #246, #250)
│   │   ├── ssrf-guard.ts                 ← Non-public address checks for webhook URLs, MX hosts and other outbound lookups (#128)
│   │   ├── dns-txt.ts                    ← TXT lookups over UDP/TCP sockets, record boundaries kept (Bun splits them, oven-sh/bun#44692)
│   │   ├── dns-wire.ts                   ← DNS wire format for dns-txt.ts: name checks, query, strict response parse (pure)
│   │   └── crypto.ts                     ← API key hashing + AES-256-GCM encryptSecret/decryptSecret (#23)
│   ├── modules/
│   │   ├── api-plugins.ts                ← Every REST API plugin, mounted by index.ts and the authz matrix test (#228)
│   │   ├── emails/
│   │   │   ├── emails.plugin.ts          ← POST /send, GET /emails
│   │   │   ├── errors.ts                 ← Typed send rejections with status + code (#245)
│   │   │   ├── services/
│   │   │   │   ├── email.service.ts      ← Email CRUD + trash/restore: public surface, re-exports the email-*.service.ts files (#380)
│   │   │   │   ├── email-create.service.ts ← createEmail, idempotent send, insert
│   │   │   │   ├── email-prepare.service.ts ← Every check a send passes before insert
│   │   │   │   ├── email-query.service.ts ← Reads, lists, tag filters, attachment lookups
│   │   │   │   ├── email-trash.service.ts ← Trash, restore, permanent delete
│   │   │   │   ├── idempotency.service.ts ← Idempotency keys of the send API (#188)
│   │   │   │   ├── tombstone.service.ts  ← Post-purge audit snapshots: hard delete with tombstone, retention (#34)
│   │   │   │   ├── custom-headers.ts     ← Custom header rules shared by REST, SMTP submission and the mailer (#177)
│   │   │   │   ├── sender-domain.service.ts ← Sender-domain gate + warnings, REQUIRE_VERIFIED_DOMAIN (#245)
│   │   │   │   ├── mailer.service.ts     ← Nodemailer transport + DKIM: `sendMail`, re-exports the mailer-*.service.ts files (#380)
│   │   │   │   ├── mailer-message.service.ts ← One transaction's message: headers, List-Unsubscribe, Feedback-ID; composed and DKIM-signed once per send (#345)
│   │   │   │   ├── dkim-signer.service.ts ← BunMail's own DKIM signer, over-signed headers (#345)
│   │   │   │   ├── mailer-state.service.ts ← Starting delivery state and signed return paths (#236)
│   │   │   │   ├── mailer-mta-sts.service.ts ← MTA-STS mode, hosts and verified TLS of a domain (#250)
│   │   │   │   ├── mailer-delivery.service.ts ← MX sessions: failover, throttle, rate budget, spans
│   │   │   │   ├── mailer-outcome.service.ts ← Each transaction's outcome on its delivery-state entry
│   │   │   │   ├── mx-route.ts           ← MX resolution per recipient domain, implicit MX, failover across hosts (#250)
│   │   │   │   ├── mx-address.ts         ← Checked addresses of an MX host, in the MAIL_IP_FAMILY order (#250)
│   │   │   │   ├── provider-bucket.ts    ← Throttle key of an MX host: microsoft, google, yahoo, apple, else its registrable domain (#250)
│   │   │   │   ├── rate-budget.ts        ← MAIL_MX_RATE_PER_MIN token bucket per provider bucket, in memory or shared in Redis (#250, #391)
│   │   │   │   ├── mx-transport.ts       ← One MX session: pooled transport, owned socket closed however it ends, deadline, STARTTLS recorder (#250)
│   │   │   │   ├── mta-sts.ts            ← Outbound MTA-STS: replaceable deps, pinned policy fetch, per-domain cache, discovery (#250); re-exports the mta-sts-*.ts files (#387)
│   │   │   │   ├── mta-sts-policy.ts     ← TXT record and policy file parsing, MX matching
│   │   │   │   ├── mta-sts-cache.ts      ← The policy cache class: bounded, failed fetches remembered
│   │   │   │   ├── mta-sts-fetch.ts      ← Fetch seams, policy host address check, capped body read
│   │   │   │   ├── list-unsubscribe.ts   ← Per-email List-Unsubscribe: one-click token or static domain settings (#249)
│   │   │   │   ├── from-name.ts          ← From display-name rules (#250)
│   │   │   │   ├── attachments.ts        ← Attachment rules: filename, Content-ID, strict base64, limits, blocked types, derived type (#181)
│   │   │   │   ├── attachment-storage.ts ← Storage interface for attachment bytes (Postgres) + metadata reads (#181)
│   │   │   │   ├── message-body.ts       ← Send-time HTML wrapper and text alternative (#250)
│   │   │   │   ├── html-to-text.ts       ← Bounded, linear HTML-to-text converter (#250)
│   │   │   │   ├── queue.service.ts      ← Queue processor + retries: public surface, re-exports the queue-*.service.ts files (#380)
│   │   │   │   ├── queue-worker.service.ts ← Poll loop and its state, send slots, lease renewal
│   │   │   │   ├── queue-claim.service.ts ← Fair claim, lease, fenced row release
│   │   │   │   ├── queue-send.service.ts ← One claimed email's send attempt
│   │   │   │   ├── queue-domain.service.ts ← Sender domain lookup for DKIM and List-Unsubscribe
│   │   │   │   ├── queue-outcome.service.ts ← Outcome transaction: bounces, suppressions, status, events (#184)
│   │   │   │   ├── queue-decision.service.ts ← Deferred, retry or terminal decision
│   │   │   │   ├── retry-schedule.ts     ← Retry backoff of temporary failures (#180)
│   │   │   │   ├── stats.service.ts      ← Dashboard stats aggregation
│   │   │   │   └── delivery-rates.ts     ← Success and bounce rate math (#250)
│   │   │   ├── dtos/
│   │   │   │   ├── send-email.dto.ts
│   │   │   │   └── list-emails.dto.ts
│   │   │   ├── models/
│   │   │   │   ├── email.schema.ts       ← emails pgTable
│   │   │   │   ├── email-attachment.schema.ts ← email_attachments pgTable (#181)
│   │   │   │   ├── email-tombstone.schema.ts ← email_tombstones pgTable (#34)
│   │   │   │   └── idempotency-key.schema.ts ← idempotency_keys pgTable (#188)
│   │   │   ├── serializations/
│   │   │   │   ├── email.serialization.ts
│   │   │   │   ├── email-tombstone.serialization.ts (#34)
│   │   │   │   └── delivery-state.serialization.ts ← Public per-MX delivery state (#250)
│   │   │   └── types/
│   │   │       └── email.types.ts
│   │   ├── api-keys/
│   │   │   ├── api-keys.plugin.ts        ← CRUD routes
│   │   │   ├── errors.ts                 ← Unauthorized sender, revoked key, inactive creator (#126, #219)
│   │   │   ├── services/
│   │   │   │   └── api-key.service.ts
│   │   │   ├── dtos/
│   │   │   │   ├── create-api-key.dto.ts
│   │   │   │   └── update-api-key.dto.ts
│   │   │   ├── models/
│   │   │   │   └── api-key.schema.ts     ← api_keys pgTable
│   │   │   ├── serializations/
│   │   │   │   └── api-key.serialization.ts
│   │   │   └── types/
│   │   │       └── api-key.types.ts
│   │   ├── domains/
│   │   │   ├── domains.plugin.ts         ← CRUD + verify + DKIM rotation routes
│   │   │   ├── errors.ts                 ← Already registered, invalid DKIM selector, rotation refused (#250)
│   │   │   ├── services/
│   │   │   │   ├── domain.service.ts     ← CRUD + DKIM key generation
│   │   │   │   ├── dkim-keys.ts          ← DKIM key pair, selector rules, dated selectors, TXT match (#250)
│   │   │   │   ├── dkim-rotation.service.ts ← DKIM key rotation: start, complete, cancel (#250)
│   │   │   │   ├── domain-dkim.service.ts ← DKIM options for out-of-queue mail (inbound notify, invitations, #217)
│   │   │   │   ├── dns-verification.service.ts ← SPF/DKIM/DMARC checks (pass, fail or unknown)
│   │   │   │   ├── domain-check-state.ts ← Verification state machine: failure count, flip, schedule (#250)
│   │   │   │   ├── domain-check.service.ts ← Stores a check + its webhook event in one transaction (#250)
│   │   │   │   ├── domain-reverify.service.ts ← Scheduled DNS re-verification worker (#250)
│   │   │   │   ├── dmarc-check.service.ts ← One DMARC record, org-domain fallback, strict tags (#250)
│   │   │   │   ├── domain-dns-status.service.ts ← Cached live DMARC check + MX status per domain (#250)
│   │   │   │   ├── required-dns-records.ts ← The DNS records to publish (`dnsRecords`, #250)
│   │   │   │   ├── sending-ip-dnsbl.service.ts ← Daily DNSBL self-check of the sending IPs (#250)
│   │   │   │   ├── sending-ips.service.ts ← Sending IPs and the reverse DNS check (#247, #248)
│   │   │   │   ├── spf-evaluator.ts      ← SPF check_host(), RFC 7208 strict: limits, deadline (#373)
│   │   │   │   ├── spf-syntax.ts         ← SPF record parsing and macro expansion (#373)
│   │   │   │   └── spf-address.ts        ← IP parsing and CIDR matching for SPF (#373)
│   │   │   ├── dtos/
│   │   │   │   ├── create-domain.dto.ts
│   │   │   │   └── update-domain.dto.ts
│   │   │   ├── models/
│   │   │   │   └── domain.schema.ts      ← domains pgTable
│   │   │   ├── serializations/
│   │   │   │   └── domain.serialization.ts
│   │   │   └── types/
│   │   │       ├── domain.types.ts
│   │   │       ├── domain-check.types.ts ← Check outcome and result (#250)
│   │   │       └── spf.types.ts          ← SPF result, resolver, check_host() input (#373)
│   │   ├── webhooks/
│   │   │   ├── webhooks.plugin.ts                 ← CRUD + deliveries inspection + replay
│   │   │   ├── services/
│   │   │   │   ├── webhook.service.ts             ← CRUD
│   │   │   │   ├── webhook-dispatch.service.ts    ← Outbox: enqueues webhook_deliveries in the caller's transaction (#30, #184)
│   │   │   │   ├── webhook-delivery.service.ts    ← Claim / send / reschedule / replay (#30): public surface, re-exports the webhook-delivery-*.service.ts files (#387)
│   │   │   │   ├── webhook-delivery-schedule.service.ts ← Retry backoff and attempt cap
│   │   │   │   ├── webhook-delivery-claim.service.ts ← Fair claim, attempt lease, signing secret
│   │   │   │   ├── webhook-delivery-attempt.service.ts ← One HTTP attempt behind the SSRF guard (pinned, no redirects, no decompression)
│   │   │   │   ├── webhook-delivery-query.service.ts ← List, get, replay
│   │   │   │   ├── webhook-delivery-outcome.service.ts ← Records an attempt's outcome
│   │   │   │   ├── webhook-delivery-retention.service.ts ← Retention purge
│   │   │   │   ├── webhook-delivery-worker.service.ts ← Poll loop + retention cleanup (#30)
│   │   │   │   └── replay-limit.service.ts        ← Replay budget per delivery, in memory (#258)
│   │   │   ├── dtos/
│   │   │   │   ├── create-webhook.dto.ts
│   │   │   │   ├── list-webhooks.dto.ts           (#258)
│   │   │   │   └── list-deliveries.dto.ts         (#30)
│   │   │   ├── models/
│   │   │   │   ├── webhook.schema.ts              ← webhooks pgTable
│   │   │   │   └── webhook-delivery.schema.ts     ← webhook_deliveries pgTable (#30)
│   │   │   ├── serializations/
│   │   │   │   ├── webhook.serialization.ts
│   │   │   │   └── webhook-delivery.serialization.ts (#30)
│   │   │   └── types/
│   │   │       └── webhook.types.ts
│   │   ├── templates/
│   │   │   ├── templates.plugin.ts       ← CRUD routes
│   │   │   ├── services/
│   │   │   │   └── template.service.ts   ← CRUD + renderTemplate()
│   │   │   ├── dtos/
│   │   │   │   ├── create-template.dto.ts
│   │   │   │   └── list-templates.dto.ts          (#258)
│   │   │   ├── models/
│   │   │   │   └── template.schema.ts    ← templates pgTable
│   │   │   ├── serializations/
│   │   │   │   └── template.serialization.ts
│   │   │   └── types/
│   │   │       └── template.types.ts
│   │   ├── inbound/
│   │   │   ├── inbound.plugin.ts         ← Routes: list, get, trash/restore/permanent/empty
│   │   │   ├── services/
│   │   │   │   ├── smtp-receiver.service.ts ← SMTP server (smtp-server): public surface, built from the smtp-receiver-*.service.ts files (#387)
│   │   │   │   ├── smtp-receiver-session.service.ts ← Per-connection stats, log context, spans, SMTP errors
│   │   │   │   ├── smtp-receiver-handlers.service.ts ← Connect (rate limit, DNSBL), MAIL FROM, RCPT TO, close
│   │   │   │   ├── smtp-receiver-data.service.ts ← DATA: unsubscribe, return-path, feedback, bounce, DMARC, storage, notification
│   │   │   │   ├── smtp-receiver-store.service.ts ← Inbound row + `email.received` in one transaction (#184)
│   │   │   │   ├── connection-limit.ts   ← Per-IP connection rate limit, shared store (#185)
│   │   │   │   ├── arf-parser.service.ts ← Pure ARF (RFC 5965) feedback-report parser (#191)
│   │   │   │   ├── feedback-handler.service.ts ← Message-ID link, recipient choice, complaint / opt-out, webhook (#191)
│   │   │   │   ├── dkim-verifier.service.ts ← DKIM signature verification (RFC 6376, rsa-sha256 and ed25519-sha256) for feedback reports (#373): verifyDkimSignatures, the dkim-verifier-*.service.ts files below (#387)
│   │   │   │   ├── dkim-verifier-parse.service.ts ← Message split, tag-lists, domains and selectors, the signature's tags
│   │   │   │   ├── dkim-verifier-canonical.service.ts ← Header and body canonicalization, the signed header data (also used by the outbound signer, #345)
│   │   │   │   ├── dkim-verifier-key.service.ts ← Key record lookup and checks, the signature check
│   │   │   │   ├── inbound-notify.service.ts ← "New email for <address>" notifications: plain text, no inbound content by default, automatic mail skipped (#106, #250)
│   │   │   │   ├── notify-throttle.ts    ← Notification budgets: 5 per address, 30 per domain, per 10 min, in memory (#250)
│   │   │   │   ├── threading.ts          ← Pure Message-ID extraction and reply chain rules (#192)
│   │   │   │   ├── reply-threading.service.ts ← Threading columns, reply headers, reply link (#192)
│   │   │   │   ├── smtp-listen.ts        ← Port bind failures of both SMTP servers: explain and exit (#167)
│   │   │   │   └── inbound.service.ts    ← Reads + trash/restore/permanent
│   │   │   ├── models/
│   │   │   │   └── inbound-email.schema.ts ← inbound_emails pgTable
│   │   │   ├── serializations/
│   │   │   │   └── inbound.serialization.ts
│   │   │   └── types/
│   │   │       ├── inbound.types.ts
│   │   │       ├── feedback-report.types.ts ← Parsed report, action and outcome (#191)
│   │   │       └── dkim.types.ts         ← DKIM verifier results, seams, parsed signature and key (#373)
│   │   ├── smtp-submission/                ← AUTH-required SMTP relay for apps to send THROUGH BunMail (#120)
│   │   │   ├── smtp-submission.plugin.ts    ← Route: GET /stats (usage + quota, #123)
│   │   │   ├── errors.ts                    ← SubmissionRejectedError: a message refused on its content (SMTP 550)
│   │   │   ├── services/
│   │   │   │   ├── smtp-submission.service.ts ← SMTP server (AUTH) → createEmail; start()/stop(): public surface (#387)
│   │   │   │   ├── smtp-submission-session.service.ts ← Per-connection stats, log context, spans, SMTP errors
│   │   │   │   ├── smtp-submission-tls.service.ts ← Implicit-TLS listener (#349, #351)
│   │   │   │   ├── smtp-submission-handlers.service.ts ← Connect limit, AUTH, RCPT TO cap, close
│   │   │   │   ├── smtp-submission-data.service.ts ← DATA: size cap, quota, parse → createEmail
│   │   │   │   ├── submission-limits.ts     ← Per-IP connection and failed-AUTH throttles, shared store (#185)
│   │   │   │   └── usage.service.ts         ← per-(key,day) usage counters + quota read (#123)
│   │   │   ├── message-mapper.ts           ← pure message → SendEmailInput mapping (BCC-aware)
│   │   │   ├── dtos/                        ← stats-query.dto
│   │   │   ├── models/
│   │   │   │   └── smtp-submission-usage.schema.ts ← smtp_submission_usage pgTable (#123)
│   │   │   └── serializations/
│   │   │       └── stats.serialization.ts
│   │   ├── trash/
│   │   │   └── services/
│   │   │       └── purge.service.ts      ← Periodic auto-purge of trashed rows (+ expired sessions, #216, audit log retention, #221, expired idempotency keys, #188)
│   │   ├── audit/                        ← Audit log of security-relevant actions (#221), no REST plugin
│   │   │   ├── models/audit-event.schema.ts ← audit_events pgTable (append-only, no FKs)
│   │   │   ├── services/                 ← audit.service.ts (record / list / purge), audit-context.service.ts (actor, IP, user agent of a request)
│   │   │   ├── types/audit.types.ts      ← actions, per-action metadata, labels
│   │   │   └── errors.ts                 ← AuditStoreError (SQLSTATE only)
│   │   ├── metrics/                      ← Prometheus metrics at GET /metrics (#362), no tables
│   │   │   ├── metrics.plugin.ts         ← The route and its METRICS_TOKEN bearer guard (404 when unset)
│   │   │   └── services/                 ← registry.ts (counter, histogram, gauge, text format), metrics.service.ts (BunMail's metrics), db-gauges.service.ts (queue, webhook backlog, suppressions)
│   │   ├── suppressions/                 ← Per-API-key send-time suppression list (#25)
│   │   │   ├── suppressions.plugin.ts    ← POST/GET/GET-:id/DELETE-:id under /api/v1/suppressions
│   │   │   ├── services/
│   │   │   │   ├── suppression.service.ts ← isSuppressed gate + create/list/delete + addFromBounce / addFromUnsubscribe / addFromComplaint hooks
│   │   │   │   ├── unsubscribe-token.ts  ← Stateless per-recipient unsubscribe token: HMAC mint/parse/verify (#249)
│   │   │   │   └── unsubscribe.service.ts ← Verify a token against its email row, suppress, fire email.unsubscribed (#249)
│   │   │   ├── dtos/                     ← create-suppression.dto, list-suppressions.dto
│   │   │   ├── models/
│   │   │   │   └── suppression.schema.ts ← suppressions pgTable
│   │   │   ├── serializations/
│   │   │   │   └── suppression.serialization.ts
│   │   │   ├── errors.ts                 ← SuppressedRecipientError → mapped to 422 in onError
│   │   │   └── types/
│   │   │       └── suppression.types.ts
│   │   ├── bounces/                      ← DSN parsing + bounce → suppression chain (#24)
│   │   │   ├── services/
│   │   │   │   ├── bounce-parser.service.ts  ← Pure RFC 3464 + regex fallback parser
│   │   │   │   ├── bounce-handler.service.ts ← Return-path verification, escalation, suppress, mark bounced, webhook
│   │   │   │   ├── return-path.ts            ← Signed per-recipient return path (VERP): mint, parse, MAC (#236)
│   │   │   │   └── return-path-mx.ts         ← Sign only when the sender domain's MX points here, cached; MX status for the domain page (#236, #250)
│   │   │   └── types/
│   │   │       └── bounce.types.ts
│   │   ├── users/                        ← Dashboard accounts schema (#214), owner bootstrap (#215), login + sessions (#216), invitations (#217), account management (#218), reset links (#277), password change (#279), active sessions (#281), new-device alerts (#282), TOTP two-factor (#220), record ownership (#219)
│   │   │   ├── models/                   ← users, user_credentials, sessions, session_token_history (#216), user_tokens, user_devices (#282), user_recovery_codes (#220)
│   │   │   ├── services/                 ← password.service.ts (argon2id), token.service.ts (SHA-256 tokens),
│   │   │   │                               owner.service.ts (bootstrap / reset / setup, advisory lock),
│   │   │   │                               owner-setup-policy.service.ts (pure: TTL, token format, password policy, URL),
│   │   │   │                               login.service.ts (email + password, one argon2id verify per branch),
│   │   │   │                               session.service.ts (create / look up / rotate / revoke / sweep / list own sessions, #281; re-exports the three below, #387),
│   │   │   │                               session-predicates.service.ts (interval literal, live-session predicate, sliding expiry),
│   │   │   │                               session-list.service.ts (Active sessions page: list, revoke one or the others, location, #281),
│   │   │   │                               session-two-factor.service.ts (pending session, enrolment secret, session locks, #220, #223, #224),
│   │   │   │                               session-location.service.ts (background location lookup after sign-in, #281),
│   │   │   │                               geoip.service.ts (approximate location: offline .mmdb or opt-in ipinfo, #281),
│   │   │   │                               user-agent.service.ts (pure: "Chrome on macOS" device label, #281),
│   │   │   │                               session-policy.service.ts (pure: lifetimes, input bounds, IP / user agent),
│   │   │   │                               invite.service.ts (create / resend / revoke / list / accept, per-address advisory lock; re-exports the three below, #387),
│   │   │   │                               invite-store.service.ts (the address lock, open / live / acceptable predicates, revokeInvitesIssuedBy),
│   │   │   │                               invite-issue.service.ts (create / resend under the lock, link and email after commit),
│   │   │   │                               invite-accept.service.ts (token lookup, acceptance transaction),
│   │   │   │                               invite-policy.service.ts (pure: who grants which role, name, expiry, URL),
│   │   │   │                               system-mail.service.ts (BunMail's own mail from SYSTEM_MAIL_FROM, DKIM-signed, #282),
│   │   │   │                               invite-email.service.ts (invitation email, via system-mail),
│   │   │   │                               device-policy.service.ts (pure: 30-day known window, 400-day retention, #282),
│   │   │   │                               user-device.service.ts (record a sign-in's browser in user_devices, sweep, #282),
│   │   │   │                               sign-in-device.service.ts (background new-device check after login, #282),
│   │   │   │                               new-device-alert.service.ts (new sign-in alert email, no links, #282; names the provider of an SSO sign-in, #224),
│   │   │   │                               totp.service.ts (pure: RFC 6238 / 4226 on node:crypto, base32, window + replay rule, otpauth URI, #220),
│   │   │   │                               recovery-code.service.ts (pure: generate / normalize / SHA-256 recovery codes, #220),
│   │   │   │                               two-factor-policy.service.ts (pure: REQUIRE_2FA coverage, enrolment paths, #220),
│   │   │   │                               two-factor.service.ts (enrol / confirm / second login step / disable / regenerate / remove, #220; re-exports the three below, #387),
│   │   │   │                               two-factor-match.service.ts (totp credential, secret, recovery codes, matchSecondFactor),
│   │   │   │                               two-factor-enrolment.service.ts (status, password hash, start / confirm enrolment),
│   │   │   │                               two-factor-recovery.service.ts (remove every second factor, which ones an account has, #223),
│   │   │   │                               two-factor-alert.service.ts (2FA, passkey and SSO link security emails via system-mail, no links, #220, #223, #224),
│   │   │   │                               passkey-policy.service.ts (pure: relying party from APP_BASE_URL, name, counter rule, credential JSON parsing, #223),
│   │   │   │                               passkey-challenge.service.ts (in-memory single-use 5-minute WebAuthn challenges, #223),
│   │   │   │                               passkey.service.ts (add / second step / passwordless / rename / remove, @simplewebauthn/server, #223; re-exports the files below, #387),
│   │   │   │                               passkey-store.service.ts (the stored passkey row, an account's passkeys),
│   │   │   │                               passkey-registration.service.ts (adding a passkey),
│   │   │   │                               passkey-assertion.service.ts (assertion check, second login step, passwordless sign-in),
│   │   │   │                               user-admin.service.ts (role change / deactivate / reactivate / remove / transfer / reset link, owner lock; re-exports the transfer, #387),
│   │   │   │                               user-admin-action.service.ts (the owner-locked action runner: live rows, rules, audit row, log line),
│   │   │   │                               user-admin-transfer.service.ts (ownership transfer: early checks, throttled password, locked transfer),
│   │   │   │                               user-admin-policy.service.ts (pure: who may act on whom, which buttons),
│   │   │   │                               password-reset.service.ts (mint / look up / complete reset links, owner lock, #277),
│   │   │   │                               password-reset-policy.service.ts (pure: one-hour TTL, URL, #277),
│   │   │   │                               password-change.service.ts (verify, then replace + sign out everywhere, owner lock, #279),
│   │   │   │                               password-change-policy.service.ts (pure: change form rules, #279),
│   │   │   │                               record-ownership.service.ts (owner backfill, transfer moves, disabling or downgrading a user's keys, #219),
│   │   │   │                               sso-discovery.service.ts (OIDC discovery, 1 h cache, 5 s / 64 KiB / no-redirect provider HTTP, #224),
│   │   │   │                               sso-flow-cookie.service.ts (AES-256-GCM bm_sso flow cookie, HKDF key, #224),
│   │   │   │                               sso-replay.service.ts (one callback per flow: consumed states claimed in the shared store, #224, #185),
│   │   │   │                               sso.service.ts (authorization URL + callback checks on oauth4webapi, #224),
│   │   │   │                               sso-link-policy.service.ts (pure: link key `oidc:<issuer>`, link name, owner rule, sign-in rules, link-by-verified-email rules, #224),
│   │   │   │                               sso-link.service.ts (password re-auth, link under a session lock, unlink with its sessions, removal by a completed reset, #224),
│   │   │   │                               sso-link-flow.service.ts (the callback's link checks in order, #224),
│   │   │   │                               sso-sign-in.service.ts (identity by `(issuer, sub)`, the sign-in rules, the `oauth` session under the link's lock, #224),
│   │   │   │                               sso-sign-in-flow.service.ts (the callback's sign-in checks in order, #224),
│   │   │   │                               sso-auto-link.service.ts (opt-in link of an unknown identity by its verified email, under the account's lock, `SSO_<ID>_AUTO_LINK`, #224),
│   │   │   │                               sso-owner-rule.service.ts (an owner with an SSO link keeps a second factor: TOTP off, passkey removal, ownership transfer, #224)
│   │   │   └── types/                    ← role / credential / assurance / purpose / invite / SSO value sets; user.types.ts keeps Tx and DbExecutor and re-exports one file per concern (#387): user-value-sets, invite, account, password, owner, session, two-factor, passkey
│   │   └── dmarc-reports/                ← DMARC `rua` aggregate report ingest (#41)
│   │       ├── dmarc-reports.plugin.ts   ← Routes: list + get
│   │       ├── services/
│   │       │   ├── dmarc-parser.service.ts   ← Pure XML/gzip/zip parser + heuristic
│   │       │   ├── dmarc-handler.service.ts  ← Persist with ON CONFLICT dedup
│   │       │   └── dmarc-reports.service.ts  ← Read queries (list / get / domains)
│   │       ├── dtos/
│   │       │   └── list-dmarc-reports.dto.ts
│   │       ├── models/
│   │       │   ├── dmarc-report.schema.ts    ← dmarc_reports pgTable
│   │       │   └── dmarc-record.schema.ts    ← dmarc_records pgTable (FK CASCADE)
│   │       ├── serializations/
│   │       │   └── dmarc-report.serialization.ts
│   │       └── types/
│   │           └── dmarc-report.types.ts
│   └── pages/                            ← Dashboard (presentation layer)
│       ├── pages.plugin.tsx              ← Parent plugin for /dashboard: public routes, session guard, then the area plugins (#291)
│       ├── plugins/                      ← One functional plugin per dashboard area (auth, home, account, passkeys (#223), sso and sso-login (#224), emails, api-keys, invitations, users, audit-log, domains, templates, webhooks, inbound, dmarc, suppressions); auth, account, passkeys and emails are composed of one group per concern (`auth-*`, `account-*`, `passkey-*`, `emails-*`, #387)
│       ├── lib/                          ← Shared dashboard helpers: session guard, session cookie, same-origin check, redirect/flash, record ownership, two-factor attempt budget (#220), DNS-verify throttle (#133, #185), sign-in helpers shared by password, passkey and SSO sign-in (#223, #224), SSO route helpers (#224), passkey route helpers (#223), Two-factor page helpers (#220), client IP for the account pages (#387)
│       ├── guards.tsx                    ← Per-route role and assurance checks (#222)
│       ├── reveal-store.ts               ← One-time secret reveal (keys, webhook secrets, invitation and reset links, recovery codes) bound to kind, user and session (#132, #280, #217, #277, #220)
│       ├── session.ts                    ← Session cookie read/set/clear (pure, #174, #216)
│       ├── viewer.ts                     ← Request-scoped viewer role, so the nav hides admin-only links (#218), and whether the viewer holds an SSO link (#224)
│       ├── flash-errors.ts               ← Error flash text that never carries an internal error message
│       ├── send-warnings.ts              ← Send-flash sentence for unverified DNS records (#245)
│       ├── favicon.ts                    ← Inline SVG favicon
│       ├── landing.plugin.tsx            ← Public landing page at /
│       ├── unsubscribe.plugin.tsx        ← Public one-click unsubscribe at /u/:token, rate limited (#249)
│       ├── static-assets.tsx             ← Serves dashboard.css / dashboard.js with a content-hash ?v= and a 1-year cache (#255)
│       ├── assets/
│       │   ├── dashboard.input.css       ← Tailwind v4 source; `bun run build:css` writes dashboard.css (gitignored, built in Docker) (#255)
│       │   ├── dashboard.js              ← The only script: theme, confirms, bulk select, chip inputs, time display, previews (#255)
│       │   └── icons.tsx                 ← Inline SVG icons
│       ├── layouts/
│       │   └── base.tsx                  ← HTML shell + self-hosted CSS/JS + nav (admin-only links by viewer role, #218; Active sessions, Change password, Two-factor and Passkeys for every role, #281, #279, #220, #223; Sign-in methods when SSO providers are configured or the viewer holds a link, #224)
│       ├── routes/
│       │   ├── login.tsx                 ← Email + password login form (standalone, no nav, #216), passkey button (#223), one "Sign in with `<label>`" button, with its logo, per SSO provider whose client id and secret are set (#224)
│       │   ├── login-two-factor.tsx      ← Second login step: TOTP or recovery code, and/or a passkey (standalone, #220, #223)
│       │   ├── setup.tsx                 ← Owner setup form + invalid-link page (standalone, #215)
│       │   ├── invite.tsx                ← Invitation accept form + invalid-link / account-exists pages (standalone, #217)
│       │   ├── invitations.tsx           ← Invitations: invite form, pending list, one-time link (#217)
│       │   ├── users.tsx                 ← Users: accounts, role change, deactivate, remove, transfer (#218), reset link (#277)
│       │   ├── audit-log.tsx             ← Audit log: security-relevant actions, filters (#221)
│       │   ├── reset.tsx                 ← Password reset form + invalid-link page (standalone, #277)
│       │   ├── account-password.tsx      ← Change password form for the signed-in user (#279)
│       │   ├── account-sessions.tsx      ← Active sessions of the signed-in user (#281)
│       │   ├── account-two-factor.tsx    ← Two-factor page: QR code enrolment, recovery codes, disable (#220)
│       │   ├── account-passkeys.tsx      ← Passkeys page: list, add, rename, remove (#223)
│       │   ├── account-sso.tsx           ← Sign-in methods page: SSO links, link and unlink (#224)
│       │   ├── home.tsx                  ← Stats overview (cards grid)
│       │   ├── landing.tsx               ← Public marketing page
│       │   ├── unsubscribe.tsx           ← Unsubscribe confirm / done / invalid pages, no script (#249)
│       │   ├── not-found.tsx             ← Custom 404 page
│       │   ├── forbidden.tsx             ← 403 page for a role or session assurance too low (#222)
│       │   ├── send-email.tsx            ← Compose & send email form
│       │   ├── emails.tsx                ← Email logs table + filters
│       │   ├── email-detail.tsx          ← Single email view
│       │   ├── api-keys.tsx              ← API keys list + create + revoke
│       │   ├── domains.tsx               ← Domains list + add + delete
│       │   ├── domain-detail.tsx         ← Domain verification status, DMARC policy, records to publish, MX and mail flow (#250); panels in domain-detail-*.tsx (#387)
│       │   ├── domain-detail-dns.tsx     ← Failing banner, verification cards, DMARC panel, records table
│       │   ├── domain-detail-dkim.tsx    ← DKIM key and rotation panel
│       │   ├── domain-detail-mail-flow.tsx ← MX and mail flow panel
│       │   ├── templates.tsx             ← Templates list + create
│       │   ├── template-detail.tsx       ← Template edit form
│       │   ├── webhooks.tsx              ← Webhooks list + create
│       │   ├── inbound.tsx               ← Inbound emails list (bulk-select + trash)
│       │   ├── inbound-detail.tsx        ← Inbound email detail + preview
│       │   ├── inbound-trash.tsx         ← Trashed inbound view
│       │   ├── emails-trash.tsx          ← Trashed outbound view
│       │   ├── email-tombstones.tsx      ← Post-purge audit snapshots + Message-ID search (#34)
│       │   ├── webhook-deliveries.tsx    ← Delivery history of one webhook (#30)
│       │   ├── webhook-delivery-detail.tsx ← Delivery detail + replay (#30)
│       │   ├── suppressions.tsx          ← Suppressions across every API key (#89)
│       │   ├── dmarc-reports.tsx         ← DMARC reports list + domain filter (#41)
│       │   └── dmarc-report-detail.tsx   ← DMARC report detail (per-source-IP, #41)
│       └── components/
│           ├── stats-card.tsx            ← Stat card (label, value, accent)
│           ├── status-badge.tsx          ← Status + verification badges
│           ├── pagination.tsx            ← Prev/Next page links
│           ├── flash-message.tsx         ← Success/error banner
│           ├── qr-code.tsx               ← QR code as server-drawn inline SVG from the `uqr` matrix (#220)
│           ├── sso-logo.tsx              ← SSO button logos, inline SVG chosen by the issuer's host (#224)
│           ├── created-by.tsx            ← "Created by" display names (#219)
│           ├── email-chip-input.tsx      ← Multi-recipient chip input
│           ├── html-preview.tsx          ← HTML preview in a sandboxed iframe
│           ├── time-display.tsx          ← Timestamps rendered in the viewer's time zone (#104)
│           └── empty-state.tsx           ← "No data yet" placeholder
├── test/
│   ├── setup.ts                          ← Global preload (env vars, mocks)
│   ├── unit/                             ← Pure unit tests, no DB / network
│   ├── e2e/                              ← Plugin-level tests with mocked services
│   └── integration/                      ← Real Postgres tests (#70)
│       ├── _preload.ts                   ← Locks DATABASE_URL to bunmail_test
│       ├── _helpers.ts                   ← truncateAll, seed factories
│       ├── setup-db.ts                   ← One-shot: create bunmail_test + migrate
│       └── *.integration.test.ts         ← One file per service or feature
```

See [docs/testing.md](docs/testing.md) for the three-tier strategy + how to run each.

---

## Module Architecture

Each feature module follows this pattern:

```
src/modules/<feature>/
├── <feature>.plugin.ts     ← Elysia plugin (route group under /api/v1/<feature>)
├── services/               ← Business logic (only layer that touches DB)
├── dtos/                   ← Request/response validation schemas (Elysia t.Object)
├── models/                 ← Drizzle pgTable schemas
├── serializations/         ← Response mappers (hide internals, format output)
└── types/                  ← TypeScript types local to this module
```

The `src/pages/` folder is separate from modules: it's a presentation layer that consumes module services to render server-side JSX pages. It has no DTOs, models, or business logic of its own.

**Rules:**
- Route handlers are thin: they call services and return serialized responses
- Only services access the database
- DTOs and serializers are feature-local (no cross-module imports)
- Types stay local unless used in 3+ modules
- Pages import services but never the other way around

---

## Request Flow

```
Client Request
     │
     ▼
┌─────────────┐
│  Rate Limit │  ← Fixed window, memory or Redis (100 req/min per API key; a batch counts once per email, #178)
│  Middleware │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│    Auth     │  ← Bearer token → SHA-256 hash → DB lookup
│  Middleware │  ← Derives `apiKey` into request context
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   Route     │  ← Validates request body/params via DTOs
│   Handler   │  ← Calls service method
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   Service   │  ← Business logic + DB operations
│             │  ← Returns domain objects
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ Serializer  │  ← Maps domain objects → API response shape
└──────┬──────┘
       │
       ▼
  JSON Response
```

---

## Email Queue Architecture

The queue is DB-driven for crash recovery with an in-memory poll loop.

```
┌─────────────────────────────────────────────────────────────────┐
│  Queue Processor (self-scheduling poll, every 2 s +/-10%, #176) │
│  0. FREE SLOTS: QUEUE_MAX_CONCURRENT_SENDS (10) - in flight;    │
│     none free → claim nothing. Polls never overlap.             │
│                                                                 │
│  1. ATOMIC, FAIR CLAIM (#20, leases #180, fairness #258):       │
│     UPDATE emails SET status = 'sending',                       │
│                       attempts = attempts + 1,                  │
│                       locked_by = <worker>,                     │
│                       lease_until = now() + 15 min              │
│     WHERE id IN (                                               │
│       per API key (LATERAL): its first n due 'queued' rows      │
│         ORDER BY next_attempt_at LIMIT n                        │
│         FOR UPDATE SKIP LOCKED   ← concurrent-safe              │
│       + rows whose lease expired (at most n)                    │
│       ranked within their key (row_number), then                │
│       ORDER BY rank, next_attempt_at                            │
│       LIMIT n = min(batch 5, free slots)  ← round-robin by key  │
│     ) RETURNING *;                                              │
│                                                                 │
│  2. For each claimed row, in the background (not awaited):      │
│     ┌───────────────────────────────────────┐                   │
│     │ a. Call mailerService.sendMail()      │                   │
│     │    (Nodemailer per-MX + DKIM)         │                   │
│     │                                       │                   │
│     │ b. On SUCCESS:                        │                   │
│     │    status = 'sent', sentAt = now()    │                   │
│     │                                       │                   │
│     │ c. On TEMPORARY FAILURE:              │                   │
│     │    status = 'queued',                 │                   │
│     │    next_attempt_at = now() + backoff  │                   │
│     │    (5m,15m,30m,1h,2h, then every 4h)  │                   │
│     │    until the email is 48 h old, then  │                   │
│     │    status = 'failed'                  │                   │
│     │                                       │                   │
│     │ d. Every outcome clears the lease,    │                   │
│     │    only if this worker still holds it │                   │
│     │                                       │                   │
│     │ e. The outcome, its inline-bounce     │                   │
│     │    suppressions and its webhook       │                   │
│     │    events commit in ONE transaction   │                   │
│     │    (outbox, #184); no network inside  │                   │
│     └───────────────────────────────────────┘                   │
│                                                                 │
│  While sending: the lease is renewed every minute. A dead       │
│  worker's rows are reclaimed once their lease expires.          │
└─────────────────────────────────────────────────────────────────┘
```

`FOR UPDATE SKIP LOCKED` makes the claim safe under concurrency: two workers running the same statement at the same time get **disjoint** result sets: never the same row twice. Single-instance today, but the queue is no longer the blocker for horizontal scaling. (#20)

The batch is shared across API keys round-robin (#258): each key's oldest due row ranks 1, its next one 2, and the batch takes the lowest ranks first, so one key's backlog cannot delay another key's mail; a single key keeps FIFO order. Each key's rows are read through the partial index `idx_emails_due_per_key` (`api_key_id, next_attempt_at, created_at` WHERE `status = 'queued' AND deleted_at IS NULL`), one short probe per key whatever the backlog. The webhook delivery worker claims the same way, per webhook through `webhook_deliveries_due_per_webhook_idx` and ranked by the webhook's key. Details: [docs/emails.md](docs/emails.md#queue-architecture), [docs/webhooks.md](docs/webhooks.md#delivery-behavior).

**Webhook events are a transactional outbox (#184):** every state change that raises an event (the queue's outcome with `email.sent` / `email.failed` / inline `email.bounced`, a DSN bounce, an unsubscribe, a complaint, a stored inbound message) writes its `webhook_deliveries` rows in its own transaction, with one `INSERT ... SELECT` over the matching webhooks (`enqueueEvent`). Both commit or neither does, so a crash between them can no longer lose an event; an insert failure rolls the state change back and is logged at `error` (the SMTP paths answer `451` so the sender retries). After a send the queue never risks a second send for a webhook problem: it retries the transaction twice, then saves the status without the events (logged, the events are lost); only a database that cannot take even that leaves the row to its lease. Fan-out happens at write time: the match is an index probe on the owning key (#313) over at most `WEBHOOKS_MAX_PER_API_KEY` webhooks (#258), and the worker, replay and the dashboard read `webhook_deliveries` unchanged. Details: [docs/webhooks.md](docs/webhooks.md#transactional-outbox-184).

**Email Status Flow:**

```
queued → sending → sent → bounced  ← async DSN arrives later (#24)
                         → failed   ← async policy DSN, 5.7.x (#250): no suppression
                 → bounced          ← inline 5xx during SMTP transaction (#68)
                                     auto-suppress + stop retrying on attempt 1
                 → failed (soft 4xx or infra error until the email is MAIL_RETRY_MAX_AGE_HOURS old)
         ↘ queued (retry after a backoff on soft 4xx or infrastructure error)
```

`sent` = recipient's MX accepted the SMTP transaction. `bounced` = recipient confirmed permanently unreachable, either inline (`550 5.1.1 ...` during the send, #68) or via a DSN that came back later (#24). Both paths auto-suppress and fire `email.bounced` with `source: "inline"` vs `"rfc3464"` / `"fallback"`. `failed` = soft 4xx or infrastructure error exhausted retries: we never confirmed reachability either way.

The queue selector also filters `deleted_at IS NULL` so rows trashed while still queued are skipped instead of being sent.

---

## Trash & Auto-Purge

Both `emails` and `inbound_emails` use a `deleted_at` soft-delete marker. Setting `deleted_at = NOW()` moves a row to trash; clearing it restores. All read paths filter `deleted_at IS NULL` so trashed rows are invisible to the normal API and dashboard until they're explicitly accessed via `/trash` endpoints.

```
┌─────────────────────────────────────────────────────────┐
│ Trash Purge (setInterval, every 6 hours, also on boot)  │
│                                                         │
│   cutoff = NOW() - TRASH_RETENTION_DAYS                 │
│                                                         │
│   DELETE FROM emails                                    │
│     WHERE deleted_at IS NOT NULL                        │
│       AND deleted_at < cutoff                           │
│                                                         │
│   DELETE FROM inbound_emails                            │
│     WHERE deleted_at IS NOT NULL                        │
│       AND deleted_at < cutoff                           │
└─────────────────────────────────────────────────────────┘
```

`TRASH_RETENTION_DAYS` is configurable via env (default `7`). The purge runs once on boot to catch anything that aged out while the server was offline.

The same loop also deletes expired dashboard sessions (`runSessionSweep` → `purgeExpiredSessions`, #216: `DELETE FROM sessions WHERE expires_at < now()`, logged as `Expired session sweep completed`). Housekeeping only: the session guard enforces expiry itself. It also deletes sign-in devices not seen for 400 days (`runDeviceSweep` → `purgeStaleUserDevices`, #282, logged as `Stale sign-in device sweep completed`), audit events older than `AUDIT_LOG_RETENTION_DAYS` (default 365, #221: `runAuditRetention` → `purgeOldAuditEvents`, in batches of 5000, logged as `Audit log retention sweep completed` and recorded in the audit log itself as `audit_log.purged`), and idempotency keys past `IDEMPOTENCY_KEY_TTL_HOURS` (default 24, #188: `runIdempotencyKeySweep` → `purgeExpiredIdempotencyKeys`, in batches of 5000, logged as `Expired idempotency key sweep completed`). Housekeeping only: the send API treats an expired key as absent.

## Domain DNS Re-verification (#250)

`domain-reverify.service.ts` re-checks every domain's SPF, DKIM and DMARC records in the background (`DOMAIN_REVERIFY_ENABLED`, default `true`). It wakes every 5 minutes (plus or minus 20%) and claims due domains in one statement, `UPDATE domains SET next_check_at = NOW() + 15 min WHERE id IN (SELECT ... WHERE next_check_at IS NULL OR next_check_at <= NOW() ORDER BY next_check_at NULLS FIRST LIMIT 50 FOR UPDATE SKIP LOCKED)`, so replicas never check one domain at once. It checks them 8 at a time with Verify's code and reschedules: `DOMAIN_REVERIFY_INTERVAL_HOURS` (default 24) plus or minus an hour after a pass, an hour after a failure or a failed lookup. A failed lookup (`unknown`) never counts; two definitive failures in a row flip a verified domain to failing (`verified_at` cleared, flags follow the result) in one transaction with `domain.verification_failed` through the webhook outbox. Each run logs one line under `job: "domain-reverify"`. It never sends mail. See [docs/domains.md](docs/domains.md#scheduled-re-verification-250).

Every TXT lookup (Verify's SPF, DKIM and DMARC checks, the SPF evaluator, DKIM rotation, inbound DKIM verification and outbound MTA-STS) goes through `src/utils/dns-txt.ts`, not `dns/promises`: Bun's `resolveTxt` (1.3.14, oven-sh/bun#44692) returns each string of a multi-string record as a record of its own, which breaks 2048-bit DKIM keys and SPF records over 255 characters. The helper queries the resolvers of `dns.getServers()` itself (UDP with EDNS0, once more without it after a FORMERR, TCP when truncated, an unreachable server skipped for the next; every response checked against the query ID and question and parsed with bounds checks in `dns-wire.ts`) and returns Node's shape and `node:dns` error codes. Other record types still use `dns/promises`.

## Sending IP DNSBL Self-check (#250)

`sending-ip-dnsbl.service.ts` looks up each sending IP (`MAIL_PUBLIC_IP`, or the A/AAAA records of `MAIL_HOSTNAME`) on `zen.spamhaus.org`, `b.barracudacentral.org` and `bl.spamcop.net` (`SENDING_IP_DNSBL_CHECK`, default `true`): 45 to 75 s after boot, then every 24 hours plus or minus 5%, each run scheduled when the previous one ends. IPv4 is queried as reversed octets, IPv6 as reversed nibbles on ZEN only. Only `127.0.0.2` to `127.0.0.11` count as listed; `127.255.255.x` (query refused, typically through a public resolver) is `unavailable`, NXDOMAIN `not listed`, anything else `unknown`. The result stays in memory per replica (no table) for the dashboard home's **Blocklists** card. Each run logs one line under `job: "dnsbl-self-check"`, plus `warn` when an address becomes listed and `info` when it is delisted. Information only: a listing never holds or refuses mail. See [docs/self-hosting.md](docs/self-hosting.md#blocklists-dnsbl-self-check-250).

---

## Database Schema

### `emails`

| Column        | Type           | Constraints                     |
|---------------|----------------|---------------------------------|
| id            | varchar(36)    | PK, prefixed `msg_`             |
| api_key_id    | varchar(36)    | FK → api_keys.id, NOT NULL      |
| domain_id     | varchar(36)    | FK → domains.id, nullable       |
| from_address  | varchar(255)   | NOT NULL                        |
| from_name     | varchar(100)   | nullable: `From:` display name, no control, bidi-control or `@ < > "` character (#250) |
| to_address    | text           | NOT NULL: one address, or several comma-separated (at most 50, #178; `varchar(255)` until migration `0038`) |
| cc            | text           | nullable                        |
| bcc           | text           | nullable                        |
| reply_to      | text           | nullable                        |
| headers       | jsonb          | nullable: custom headers, name to value (#177) |
| subject       | varchar(500)   | NOT NULL                        |
| html          | text           | nullable                        |
| text_content  | text           | nullable                        |
| status        | varchar(20)    | NOT NULL, default `'queued'`    |
| source        | varchar(10)    | NOT NULL, default `'api'` (`api`\|`smtp`, #137) |
| category      | varchar(20)    | nullable: `transactional` (no `List-Unsubscribe`) \| `marketing` (one-click required) (#250) |
| tags          | jsonb          | nullable: caller labels, key to value, at most 10 (#189); filtered with `?tag=key:value`, carried by `email.*` webhooks |
| attempts      | integer        | NOT NULL, default `0`           |
| next_attempt_at | timestamptz  | NOT NULL, default `now()`: retry backoff (#180) |
| locked_by     | varchar(64)    | nullable: worker holding a `sending` row (#180) |
| lease_until   | timestamptz    | nullable: claim expiry while `sending` (#180) |
| last_error    | text           | nullable                        |
| delivery_state | jsonb         | nullable: per-recipient-domain (or per-recipient, #236/#250) outcomes with attempts, failure class, MX host, `tls`, `mtaSts` and `updatedAt` (#97, #250); keyed by MX on rows from before #250 |
| message_id    | varchar(255)   | nullable (SMTP Message-ID)      |
| sent_at       | timestamp      | nullable                        |
| created_at    | timestamp      | NOT NULL, default `now()`       |
| updated_at    | timestamp      | NOT NULL, default `now()`       |
| deleted_at    | timestamp      | nullable (soft-delete marker)   |

Indexes: `(status, created_at)`, `(api_key_id)`, `(api_key_id, deleted_at)`, `idx_emails_due_per_key` `(api_key_id, next_attempt_at, created_at)` partial WHERE `status='queued' AND deleted_at IS NULL` (fair queue claim, #258), `(lease_until)` partial WHERE `status='sending'` (expired leases, #180), `(message_id)` (linking inbound replies, bounces and complaints to the email by Message-ID, #192), `idx_emails_tags` GIN on `tags` with `jsonb_path_ops` (the tag filter's containment, #189).

`domain_id` uses `ON DELETE SET NULL` so deleting a domain detaches its emails rather than blocking. `deleted_at` is set when an email is moved to trash; rows with `deleted_at` older than `TRASH_RETENTION_DAYS` are auto-purged by `trash/services/purge.service.ts`.

### `email_attachments` (#181)

The files of an outbound email (migration `0037`), one row per attachment, inserted in the email's transaction. The bytes are kept only until the email reaches a final state: the outcome transaction that sets `sent`, `failed` or `bounced` sets `content = NULL` and keeps the metadata. Every read other than the mailer's send and the dashboard download selects the metadata columns only (`content IS NOT NULL` for `available`). Accessed through the `AttachmentStorage` interface (`services/attachment-storage.ts`), so an object store can replace the `content` column later. See [docs/emails.md](docs/emails.md#attachments-181).

| Column       | Type           | Constraints                                   |
|--------------|----------------|-----------------------------------------------|
| id           | varchar(36)    | PK (`att_…`)                                  |
| email_id     | varchar(36)    | NOT NULL, FK → emails.id `ON DELETE CASCADE`  |
| position     | integer        | NOT NULL: 0-based index in the send's list    |
| filename     | varchar(255)   | NOT NULL: checked, trimmed                    |
| content_type | varchar(255)   | NOT NULL: derived from the bytes, never declared |
| size_bytes   | integer        | NOT NULL: decoded size                        |
| content_id   | varchar(128)   | nullable: inline `cid`                        |
| sha256       | varchar(64)    | NOT NULL: hex digest (dedup, debugging)       |
| content      | bytea          | nullable: raw bytes; `NULL` once final        |
| created_at   | timestamp      | NOT NULL, default `now()`                     |

Indexes: `uq_email_attachments_email_position` unique `(email_id, position)` (also the `email_id` index).

### `api_keys`

| Column       | Type           | Constraints                     |
|--------------|----------------|---------------------------------|
| id           | varchar(36)    | PK, prefixed `key_`             |
| name         | varchar(100)   | NOT NULL                        |
| key_hash     | varchar(255)   | NOT NULL, UNIQUE                |
| key_prefix   | varchar(12)    | NOT NULL                        |
| is_active    | boolean        | NOT NULL, default `true`        |
| is_admin     | boolean        | NOT NULL, default `false`: admin (management plane) vs restricted / send-only (#130); operator-set only |
| allowed_senders | jsonb       | NOT NULL, default `[]`: `From` allowlist (#126); empty = unrestricted |
| last_used_at | timestamp      | nullable                        |
| created_at   | timestamp      | NOT NULL, default `now()`       |
| created_by_user_id | varchar(36) | nullable, FK → users.id `ON DELETE SET NULL`, indexed: the user it belongs to (#219); NULL = the owner |
| disabled_reason | varchar(20) | nullable, CHECK `revoked` / `creator_deactivated` / `creator_removed`: why an inactive key is inactive (#219) |

### `domains`

| Column            | Type           | Constraints                  |
|-------------------|----------------|------------------------------|
| id                | varchar(36)    | PK, prefixed `dom_`          |
| name              | varchar(255)   | NOT NULL, UNIQUE             |
| dkim_private_key  | text           | nullable; AES-256-GCM encrypted at rest (#23) |
| dkim_public_key   | text           | nullable                     |
| dkim_selector     | varchar(63)    | NOT NULL, default `'bunmail'`; chosen on create or set by a completed rotation (#250) |
| dkim_pending_selector | varchar(63) | nullable; dated selector of a pending DKIM key rotation (#250) |
| dkim_pending_private_key | text     | nullable; pending private key, AES-256-GCM encrypted at rest (#250) |
| dkim_pending_public_key | text      | nullable; pending public key (#250) |
| dkim_pending_created_at | timestamp | nullable; when the pending rotation started (#250) |
| dkim_previous_selector | varchar(63) | nullable; selector active before the last rotation, informational, never signs (#250) |
| dkim_previous_public_key | text     | nullable; its public key (#250) |
| dkim_rotated_at   | timestamp      | nullable; when the last rotation switched keys (#250) |
| unsubscribe_email | varchar(255)   | nullable; per-domain mailto override for `List-Unsubscribe` (#40) |
| unsubscribe_url   | text           | nullable; per-domain URL form for `List-Unsubscribe` + One-Click POST (#40); replaced by the per-recipient `/u/<token>` link on single-recipient mail when `APP_BASE_URL` is `https://` (#249) |
| notify_email      | varchar(255)   | nullable; address notified on inbound mail for this domain (#106) |
| spf_verified      | boolean        | NOT NULL, default `false`    |
| dkim_verified     | boolean        | NOT NULL, default `false`    |
| dmarc_verified    | boolean        | NOT NULL, default `false`    |
| verified_at       | timestamp      | nullable; set only when SPF, DKIM and DMARC all pass, cleared when the domain flips to failing (#250) |
| last_checked_at   | timestamptz    | nullable; when the DNS checks last ran (#250) |
| next_check_at     | timestamptz    | nullable, indexed; when the re-verification loop checks it next, NULL = due (#250) |
| consecutive_failures | integer     | NOT NULL, default `0`; checks in a row with a definitive failure (#250) |
| last_check_result | jsonb          | nullable; per check `{ status: pass/fail/unknown, reason }` (#250) |
| created_at        | timestamp      | NOT NULL, default `now()`    |
| updated_at        | timestamp      | NOT NULL, default `now()`    |
| created_by_user_id | varchar(36) | nullable, FK → users.id `ON DELETE SET NULL`, indexed: the user it belongs to (#219); NULL = the owner |

### `webhooks`

| Column       | Type           | Constraints                     |
|--------------|----------------|---------------------------------|
| id           | varchar(36)    | PK, prefixed `whk_`            |
| api_key_id   | varchar(36)    | FK → api_keys.id, NOT NULL, indexed (#173) |
| url          | text           | NOT NULL                        |
| events       | jsonb          | NOT NULL, default `[]`          |
| secret       | varchar(255)   | NOT NULL, encrypted at rest (#259) |
| is_active    | boolean        | NOT NULL, default `true`        |
| created_at   | timestamp      | NOT NULL, default `now()`       |
| updated_at   | timestamp      | NOT NULL, default `now()`       |
| created_by_user_id | varchar(36) | nullable, FK → users.id `ON DELETE SET NULL`, indexed: the user it belongs to (#219); NULL = the owner |

### `email_tombstones` (#34)

Post-purge audit trail. Every hard-delete of an `emails` row first writes a snapshot here so operators can trace late complaints / bounces back to a sent message after the body has been purged. Body / html / text are deliberately NOT preserved. **No foreign keys**: snapshots survive their parent api_key / domain being deleted. See [docs/emails.md](docs/emails.md#tombstones).

| Column         | Type           | Constraints                                   |
|----------------|----------------|-----------------------------------------------|
| id             | varchar(36)    | PK: matches the original email's id (`msg_…`)|
| api_key_id     | varchar(36)    | NOT NULL: snapshot, NOT a FK                 |
| message_id     | varchar(255)   | nullable: SMTP `Message-ID`, indexed         |
| from_address   | varchar(255)   | NOT NULL                                      |
| to_address     | text           | NOT NULL: the email's `to` list as stored (#178) |
| subject        | varchar(500)   | nullable                                      |
| status         | varchar(20)    | NOT NULL: sent / bounced / failed at delete time |
| sent_at        | timestamptz    | nullable                                      |
| deleted_at     | timestamptz    | nullable, when the original was soft-deleted to trash |
| purged_at      | timestamptz    | NOT NULL, default `now()`: retention starts here |
| attachments    | jsonb          | nullable: each attachment's `filename`, `contentType`, `size` (#181), never the bytes |

Indexes: `(message_id)` (bounce/complaint trace hot path), `(api_key_id, purged_at)` (dashboard list).

Retention: `TOMBSTONE_RETENTION_DAYS` (default 90): the existing 6h trash purge loop also runs `runTombstoneRetention` on the same cadence.

### `idempotency_keys` (#188)

`Idempotency-Key` header values seen on `POST /api/v1/emails/send` (migration `0030`), one row per (API key, key) for `IDEMPOTENCY_KEY_TTL_HOURS` (default 24, 1 to 168). A table rather than a column on `emails`: a unique index on `emails` cannot express the TTL, and keys must not follow emails through trash and purge. See [docs/emails.md](docs/emails.md#idempotency-keys).

| Column          | Type           | Constraints                                   |
|-----------------|----------------|-----------------------------------------------|
| id              | varchar(36)    | PK (`idk_…`)                                  |
| api_key_id      | varchar(36)    | NOT NULL, FK → api_keys.id `ON DELETE CASCADE` |
| key             | text           | NOT NULL: the header value                    |
| request_hash    | text           | NOT NULL: SHA-256 hex of the canonical JSON body |
| email_id        | varchar(36)    | nullable, FK → emails.id `ON DELETE SET NULL`, indexed |
| response_status | integer        | nullable (only inside the creating transaction) |
| response_body   | jsonb          | nullable: the first response without message content (subject, html, text, headers are filled from the live email on replay, or null); attachment metadata only, never a file (#181) |
| created_at      | timestamptz    | NOT NULL, default `now()`                     |
| expires_at      | timestamptz    | NOT NULL, indexed (purge)                     |

Unique index `(api_key_id, key)`: the send claims the key with `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE expires_at <= now()` in the transaction that inserts the email, so concurrent duplicates wait on it and replay the committed row (no in-progress state).

### `webhook_deliveries` (#30)

Persisted retry queue and transactional outbox (#184). An event enqueues one row per subscribed webhook in the same transaction as the state change it describes; the worker drains it on a 5s poll. See [docs/webhooks.md](docs/webhooks.md) for the full lifecycle.

| Column                | Type           | Constraints                                   |
|-----------------------|----------------|-----------------------------------------------|
| id                    | varchar(36)    | PK, `wdl_` + 32 hex from `gen_random_uuid()` (#184; older rows `wdl_` + 24 hex) |
| webhook_id            | varchar(36)    | FK → webhooks.id, NOT NULL, `ON DELETE CASCADE` |
| event                 | varchar(50)    | NOT NULL                                      |
| payload               | text           | NOT NULL: JSON body bytes (re-signed per attempt) |
| status                | varchar(20)    | NOT NULL, default `pending` (pending\|delivered\|failed) |
| attempts              | integer        | NOT NULL, default 0                           |
| last_error            | text           | nullable                                      |
| last_response_status  | integer        | nullable                                      |
| next_attempt_at       | timestamptz    | NOT NULL, default `now()`                     |
| delivered_at          | timestamptz    | nullable                                      |
| last_response_body    | jsonb          | nullable                                      |
| created_at            | timestamptz    | NOT NULL, default `now()`                     |
| updated_at            | timestamptz    | NOT NULL, default `now()`                     |

Indexes: `(webhook_id, next_attempt_at)` partial WHERE `status='pending'` (fair worker claim, #258), `(webhook_id, created_at)` (dashboard inspection).

Retention: finished rows (`delivered` and `failed`) are deleted by the worker's hourly cleanup once their `updated_at` is older than `WEBHOOK_DELIVERY_RETENTION_DAYS` (default 30, 1 to 365), in batches of 5,000; `pending` rows never are (#258).

### `templates`

| Column       | Type           | Constraints                     |
|--------------|----------------|---------------------------------|
| id           | varchar(36)    | PK, prefixed `tpl_`            |
| api_key_id   | varchar(36)    | FK → api_keys.id, NOT NULL, indexed (#173) |
| name         | varchar(255)   | NOT NULL                        |
| subject      | varchar(500)   | NOT NULL                        |
| html         | text           | nullable                        |
| text_content | text           | nullable                        |
| variables    | jsonb          | NOT NULL, default `[]`          |
| created_at   | timestamp      | NOT NULL, default `now()`       |
| updated_at   | timestamp      | NOT NULL, default `now()`       |
| created_by_user_id | varchar(36) | nullable, FK → users.id `ON DELETE SET NULL`, indexed: the user it belongs to (#219); NULL = the owner |

`created_by_user_id` on `api_keys`, `domains`, `webhooks` and `templates` (#219, migration `0020`): set from the signed-in user on dashboard creates and from the calling key's creator on REST creates. Legacy rows (NULL) are assigned to the owner by the owner bootstrap at boot, not by the migration (the owner row does not exist yet when migrations run on an upgrade). Members manage only their own keys and templates; domains and webhooks carry it for attribution. See [docs/users.md](docs/users.md#record-ownership-219).

### `inbound_emails`

| Column       | Type           | Constraints                     |
|--------------|----------------|---------------------------------|
| id           | varchar(36)    | PK, prefixed `inb_`            |
| from_address | varchar(255)   | NOT NULL                        |
| to_address   | varchar(255)   | NOT NULL                        |
| subject      | varchar(500)   | nullable                        |
| html         | text           | nullable                        |
| text_content | text           | nullable                        |
| raw_message  | text           | nullable                        |
| message_id   | text           | nullable: the message's valid `Message-ID` (#192) |
| in_reply_to  | text           | nullable: up to 20 valid msg-ids from `In-Reply-To` (#192) |
| references   | text           | nullable: up to 20 valid msg-ids from `References`, root kept (#192) |
| in_reply_to_email_id | varchar(36) | nullable, FK → emails.id `ON DELETE SET NULL`: the email of ours it replies to, same sender domain only (#192) |
| received_at  | timestamp      | NOT NULL, default `now()`       |
| deleted_at   | timestamp      | nullable (soft-delete marker)   |

Indexes: `(received_at)`, `(deleted_at)`, `(in_reply_to_email_id)` (#192). The msg-id columns are attacker-controlled and validated before storage; see [docs/inbound.md](docs/inbound.md#threading-192).

### `suppressions`

Per-API-key list of addresses we refuse to send to (#25). Send-time gate at `createEmail` rejects with HTTP 422 before any insert / queue / SMTP work. Auto-populated by the bounce handler (#24) when DSNs come back, by the unsubscribe flow (#249), and by feedback-loop complaints (#191).

| Column            | Type           | Constraints                  |
|-------------------|----------------|------------------------------|
| id                | varchar(36)    | PK, prefixed `sup_`          |
| api_key_id        | varchar(36)    | FK → api_keys.id, NOT NULL, `ON DELETE CASCADE` |
| email             | varchar(255)   | NOT NULL; stored lower-cased + trimmed |
| reason            | text           | NOT NULL; one of `bounce | complaint | manual | unsubscribe` (validated at API boundary; column stays text for forward compat). `unsubscribe` is set by the one-click unsubscribe flow (#249) and `opt-out` feedback reports; `complaint` by feedback-loop complaints (#191), which take precedence over every other reason |
| bounce_type       | varchar(20)    | nullable; `hard | soft | null` |
| diagnostic_code   | text           | nullable; SMTP enhanced status (e.g. `5.1.1`) |
| source_email_id   | varchar(36)    | FK → emails.id, `ON DELETE SET NULL` |
| expires_at        | timestamptz    | nullable; null = permanent   |
| created_at        | timestamptz    | NOT NULL, default `now()`    |

Indexes: `UNIQUE (api_key_id, email)` (gate hot-path + `ON CONFLICT DO UPDATE` upsert); `suppressions_shared_hard_email_idx` on `(email) WHERE expires_at IS NULL AND reason IN ('bounce', 'complaint')` (migration 0034), the cross-key lookup of `SUPPRESSIONS_SHARED_HARD` (#250): with it `true`, the gate also refuses an address any key holds an automatic permanent hard bounce (`bounce_type = 'hard'`) or feedback-loop complaint (`source_email_id` set) for, naming neither that key nor its row (`suppressionId: null`). See [docs/suppressions.md](docs/suppressions.md#shared-hard-suppressions-suppressions_shared_hard-250).

### `smtp_submission_usage`

Per-`(api_key, UTC day)` counters for the SMTP submission server (#123): backs the per-key daily quota and the `/api/v1/smtp-submission/stats` endpoint. One row per key per day (not a per-message log). Auth *failures* are not recorded here (no key to attribute to).

| Column       | Type        | Constraints                                     |
|--------------|-------------|-------------------------------------------------|
| id           | varchar(36) | PK, prefixed `smu_`                             |
| api_key_id   | varchar(36) | FK → api_keys.id, NOT NULL, `ON DELETE CASCADE` |
| day          | date        | NOT NULL; UTC calendar day                      |
| accepted     | integer     | NOT NULL, default 0                             |
| rejected     | integer     | NOT NULL, default 0 (post-auth rejections)      |
| created_at   | timestamptz | NOT NULL, default `now()`                       |
| updated_at   | timestamptz | NOT NULL, default `now()`                       |

Indexes: `UNIQUE (api_key_id, day)` (quota read + `ON CONFLICT DO UPDATE` upsert + stats range scan).

### `dmarc_reports` / `dmarc_records`

DMARC aggregate (`rua`) reports parsed from inbound XML attachments (#41). Operator-level data, not tenant-scoped, no FK to `domains` or `api_keys`. See [docs/dmarc-reports.md](docs/dmarc-reports.md).

`dmarc_reports` (one row per received report):

| Column        | Type            | Constraints                                       |
|---------------|-----------------|---------------------------------------------------|
| id            | varchar(36)     | PK, prefixed `dmr_`                               |
| org_name      | varchar(255)    | NOT NULL                                          |
| org_email     | varchar(255)    | NOT NULL                                          |
| report_id     | varchar(255)    | NOT NULL                                          |
| domain        | varchar(255)    | NOT NULL                                          |
| date_begin    | timestamptz     | NOT NULL                                          |
| date_end      | timestamptz     | NOT NULL                                          |
| policy_p      | varchar(20)     | NOT NULL                                          |
| policy_pct    | integer         | NOT NULL                                          |
| raw_xml       | text            | NOT NULL (kept verbatim for forensics)            |
| received_at   | timestamptz     | NOT NULL, default `now()`                         |

Indexes: `UNIQUE (org_email, report_id)` (dedup hot-path), `(domain, date_end DESC)` (dashboard list hot-path).

`dmarc_records` (one row per source IP, child of the report):

| Column            | Type            | Constraints                                    |
|-------------------|-----------------|------------------------------------------------|
| id                | varchar(36)     | PK, prefixed `dmrec_`                          |
| report_id         | varchar(36)     | FK → dmarc_reports.id, NOT NULL, `ON DELETE CASCADE` |
| source_ip         | varchar(45)     | NOT NULL                                       |
| count             | integer         | NOT NULL                                       |
| disposition       | varchar(20)     | NOT NULL                                       |
| dkim_aligned      | boolean         | NOT NULL                                       |
| spf_aligned       | boolean         | NOT NULL                                       |
| header_from       | varchar(255)    | nullable                                       |
| dkim_auth_domain  | varchar(255)    | nullable                                       |
| dkim_selector     | varchar(255)    | nullable                                       |
| dkim_result       | varchar(20)     | nullable                                       |
| spf_auth_domain   | varchar(255)    | nullable                                       |
| spf_result        | varchar(20)     | nullable                                       |

### `users` (#214)

Dashboard accounts: identity only; login methods live in `user_credentials`. Exactly one `owner`, enforced by `users_single_owner` (unique on `role WHERE role = 'owner'`). See [docs/users.md](docs/users.md) for every column, index and check.

| Column            | Type         | Constraints                                                   |
|-------------------|--------------|---------------------------------------------------------------|
| id                | varchar(36)  | PK, prefixed `usr_`                                           |
| email             | varchar(255) | NOT NULL, UNIQUE, CHECK lower-cased                           |
| email_verified_at | timestamptz  | nullable                                                      |
| name              | varchar(100) | nullable                                                      |
| role              | varchar(10)  | NOT NULL, default `member`, CHECK IN (`owner`,`admin`,`member`) |
| disabled_at       | timestamptz  | nullable                                                      |
| created_at        | timestamptz  | NOT NULL, default `now()`                                     |
| updated_at        | timestamptz  | NOT NULL, default `now()`                                     |

### `user_credentials` (#214)

One row per login method: `password`, `totp` (the second factor, #220), `passkey` (WebAuthn, a first or second factor, #223) and `oauth` (an SSO link, #224: not a second factor). FK `users` ON DELETE CASCADE. Unique: one `password` row per user; one `totp` row per user (#220, migration `0027`); `(provider, provider_account_id)` where provider is set; `provider_account_id` where `type = 'passkey'` (the WebAuthn credential id, #223, migration `0039`); `(user_id, provider)` where `type = 'oauth'` (one SSO link per provider per user, #224, migration `0040`). Columns: `secret_hash` (argon2id hash, or the TOTP secret encrypted with `DKIM_ENCRYPTION_KEY`; null for an SSO link: no token is stored), `provider` (varchar(255): `oidc:<issuer>` for an SSO link, #224, migration `0040`), `provider_account_id` (text: the passkey credential id, base64url, or the SSO subject), `name` (passkey label, 1 to 64 characters; for an SSO link the provider email, else the `name` claim, at link time, shown only), `public_key` (passkey COSE key, base64url), `transports` (varchar(255), nullable, comma-separated known passkey transports, #223), `counter` (bigint: passkey signature counter for clone detection, or the last accepted TOTP step for replay protection), `last_used_at`, timestamps. A `totp` row exists only once confirmed; a `passkey` row only once its registration verified. "Has a second factor" (`hasSecondFactor`) means a `totp` or `passkey` row.

### `user_recovery_codes` (#220)

TOTP recovery codes (migration `0027`): `id` (`rcv_`), `user_id` (FK `users` ON DELETE CASCADE), `credential_id` (FK `user_credentials` ON DELETE CASCADE: the codes go with the `totp` credential), `code_hash` (SHA-256 of the normalized code; the code is never stored), `used_at` (nullable: single use), `created_at`. UNIQUE `(user_id, code_hash)`; index on `credential_id`. Ten per account. Rules: [docs/users.md](docs/users.md#two-factor-authentication-220).

### `sessions` (#214, #216)

Opaque session tokens stored as SHA-256 (`token_hash`, UNIQUE), FK `users` ON DELETE CASCADE, `assurance` CHECK IN (`pending`,`password`,`mfa`) (#220: `pending` after the password of an account with a second factor, TOTP or a passkey (#223), 10 minutes, never admitted by the guard; `mfa` after the code or a passkey, and for a passwordless passkey sign-in), `auth_method` (`passkey` for a passwordless sign-in, whose session is bound to the passkey by `credential_id`; `oauth` for an SSO sign-in, #224, `pending` or `password` like after a password, bound to the link, so unlinking ends it), `expires_at` (24 h idle, capped at `created_at` + 7 days), `last_seen_at`, `ip`, `user_agent`. Token rotation (#216, migration `0017`) adds `previous_token_hash` (nullable, the token the last rotation replaced) and `rotated_at` (nullable). `credential_id` (#277, migration `0019`, nullable, FK `user_credentials` ON DELETE CASCADE) binds a session to the credential it was opened with: replacing a password deletes those sessions, and a login racing a reset cannot open one on the old password. `location` (#281, migration `0025`, nullable `varchar(128)`): the approximate location of `ip` ("City, Country" or "Country"), looked up once in the background after the session is created when GeoIP is configured. `totp_pending_secret` (#220, migration `0027`, nullable `text`): the encrypted secret of a TOTP enrolment started in this session and not confirmed yet. Indexes on `user_id`, `expires_at`, `previous_token_hash` and `credential_id`. Every superseded hash is also kept in `session_token_history` (`token_hash` PK, `session_id` FK ON DELETE CASCADE, `superseded_at`) until the session ends, so reuse of a token of any age is detected. Lifecycle (create, rotate, reuse detection, revoke, sweep): [docs/users.md](docs/users.md#sessions-216).

### `user_tokens` (#214)

One-time tokens (`purpose` CHECK IN `owner_setup`,`invite`,`password_reset`), stored as SHA-256 (`token_hash`, UNIQUE). `user_id` (FK CASCADE) or `email` (lower-cased) must be set; `role` for invites; `invited_by` FK ON DELETE SET NULL so invite history survives (for a `password_reset` row it records who issued the link, #277); `expires_at`, `used_at`, `revoked_at`. Index on `(email, purpose)`. `user_tokens_invite_check` (#217, migration `0018`): an `invite` row must have an `email` and a `role` of `admin` or `member`, never `owner`. Invitation lifecycle: [docs/users.md](docs/users.md#invitations-217).

### `user_devices` (#282)

The browsers each account signed in from (with a password, a passkey or SSO), for the new-device sign-in alert (migration `0026`). `id` (`udv_`), `user_id` (FK `users` ON DELETE CASCADE), `device_hash` (SHA-256 of the `bm_device` cookie value; the value is never stored), `user_agent` (the device label, "Chrome on macOS"), `ip`, `location` (nullable, #281), `first_seen_at`, `last_seen_at`. UNIQUE `(user_id, device_hash)` (the sign-in upsert's conflict target); indexes on `user_id` and `last_seen_at` (the 400-day sweep). Rules: [docs/users.md](docs/users.md#new-device-alerts-282).

### `audit_events` (#221)

Security-relevant actions (migration `0028`): `id` (`aud_`), `occurred_at` (default `now()`), `actor_type` (CHECK IN `user`,`api_key`,`system`), `actor_id` and `actor_label` (snapshot: email or key name), `action` (code-level union, e.g. `auth.login.failed`), `outcome` (CHECK IN `success`,`failure`), `target_type` / `target_id` / `target_label`, `ip` (IP literal only), `user_agent` (256 characters at most), `metadata` (jsonb, small typed details, never secrets). Indexes: `(occurred_at DESC, id DESC)`, `(action, occurred_at DESC)`, `(actor_id, occurred_at DESC)`. **No foreign keys**: deleting a user or a key never touches its history. **Append-only**: the statement-level trigger `audit_events_no_update` raises on any `UPDATE`; `DELETE` is left to the retention purge (`AUDIT_LOG_RETENTION_DAYS`). Read on `/dashboard/audit-log` (admins and the owner). Details: [docs/audit-log.md](docs/audit-log.md).

### `__bunmail_migrations`

System table managed by the Bun-native migration runner ([src/db/migrate.ts](src/db/migrate.ts), #56). Each row is one applied migration tag (`0000_wonderful_psylocke`, etc.). The runner reads the committed `drizzle/<n>_*.sql` files at boot, applies anything not yet recorded, and auto-baselines legacy `db:push`-provisioned databases by detecting the schema's first table. The whole run holds a session-level advisory lock (`pg_advisory_lock(hashtext('bunmail:migrations'))`) on a single pinned connection (#175), so concurrent runs from several replicas serialize instead of racing.

### Relationships

```
api_keys  ──1:N──▶ emails
api_keys  ──1:N──▶ webhooks
webhooks  ──1:N──▶ webhook_deliveries  (CASCADE on parent delete)
api_keys  ──1:N──▶ templates
api_keys  ──1:N──▶ suppressions
domains   ──1:N──▶ emails
users     ──1:N──▶ api_keys, templates, domains, webhooks  (created_by_user_id, SET NULL on delete, #219)
users     ──1:N──▶ user_credentials, sessions, user_tokens, user_devices, user_recovery_codes  (CASCADE on user delete; user_tokens.invited_by SET NULL)
user_credentials ──1:N──▶ sessions  (credential_id, CASCADE, #277)
user_credentials ──1:N──▶ user_recovery_codes  (credential_id of the totp row, CASCADE, #220)
sessions  ──1:N──▶ session_token_history  (CASCADE, #216)
emails    ──1:N──▶ suppressions    (source_email_id, when auto-suppressed from a bounce, unsubscribe or complaint)
emails    ──1:N──▶ email_attachments  (CASCADE on email delete, #181)
dmarc_reports ──1:N──▶ dmarc_records  (CASCADE on parent delete)
```

---

## API Endpoints

### Emails

| Method | Path                                | Description                                | Auth |
|--------|-------------------------------------|--------------------------------------------|------|
| POST   | /api/v1/emails/send                 | Send an email (optional `Idempotency-Key` header, #188; optional `attachments`, #181; `to` a string or an array of up to 50, #178) | Yes  |
| POST   | /api/v1/emails/batch                | Send 1 to 100 distinct emails, one result per item, always 200; counts as N sends against the rate limit (#178) | Yes  |
| GET    | /api/v1/emails                      | List sent emails (excludes trash); `status`, `source` and repeatable `tag=key:value` filters | Yes  |
| GET    | /api/v1/emails/trash                | List trashed emails                        | Yes  |
| GET    | /api/v1/emails/:id                  | Get email by ID, with its per-MX `deliveryState` (#250) | Yes  |
| DELETE | /api/v1/emails/:id                  | Move email to trash                        | Yes  |
| POST   | /api/v1/emails/bulk-delete          | Bulk move to trash (`{ ids: [] }`)         | Yes  |
| POST   | /api/v1/emails/:id/restore          | Restore from trash                         | Yes  |
| DELETE | /api/v1/emails/:id/permanent        | Permanently delete a trashed email (writes a tombstone) | Yes  |
| POST   | /api/v1/emails/trash/empty          | Permanently delete all trashed emails (writes tombstones) | Yes  |
| GET    | /api/v1/emails/tombstones           | List post-purge audit snapshots (`?messageId=` filter) | Yes  |
| GET    | /api/v1/emails/tombstones/:id       | Single tombstone by original email id       | Yes  |

### API Keys

| Method | Path                     | Description           | Auth |
|--------|--------------------------|-----------------------|------|
| POST   | /api/v1/api-keys         | Create API key (+ `allowedSenders`) | Yes  |
| GET    | /api/v1/api-keys         | List API keys         | Yes  |
| PATCH  | /api/v1/api-keys/:id     | Update name / allowed-senders (#126) | Yes  |
| DELETE | /api/v1/api-keys/:id     | Revoke API key        | Yes  |

### Domains

| Method | Path                          | Description           | Auth |
|--------|-------------------------------|-----------------------|------|
| POST   | /api/v1/domains               | Add domain (auto-DKIM)| Yes  |
| GET    | /api/v1/domains               | List domains          | Yes  |
| GET    | /api/v1/domains/:id           | Get domain details    | Yes  |
| POST   | /api/v1/domains/:id/verify    | Verify DNS records    | Yes  |
| PATCH  | /api/v1/domains/:id           | Edit unsubscribe settings | Yes |
| DELETE | /api/v1/domains/:id           | Remove domain         | Yes  |
| POST   | /api/v1/domains/:id/dkim/rotate | Start a DKIM key rotation (#250) | Yes |
| POST   | /api/v1/domains/:id/dkim/rotate/complete | Switch to the pending key once published (#250) | Yes |
| DELETE | /api/v1/domains/:id/dkim/rotate | Cancel the pending rotation (#250) | Yes |

### Webhooks

| Method | Path                          | Description           | Auth |
|--------|-------------------------------|-----------------------|------|
| POST   | /api/v1/webhooks              | Register webhook      | Yes  |
| GET    | /api/v1/webhooks              | List webhooks (paginated, default limit 100, #258) | Yes  |
| DELETE | /api/v1/webhooks/:id          | Delete webhook (cascades to deliveries) | Yes  |
| GET    | /api/v1/webhooks/:id/deliveries | List delivery attempts (filter by `?status=`) | Yes |
| GET    | /api/v1/webhooks/deliveries/:deliveryId | Single delivery + payload + last response | Yes |
| POST   | /api/v1/webhooks/deliveries/:deliveryId/replay | Replay a delivery, flips to `pending` (5 per delivery per hour, #258) | Yes |

Events: `email.queued`, `email.sent`, `email.failed`, `email.bounced`, `email.complained` (#191), `email.unsubscribed` (#249), all scoped to the sending key; `email.received`, `domain.verification_failed` and `domain.verified` (#250) to admin keys only. See [docs/webhooks.md](docs/webhooks.md#event-types).

### Templates

| Method | Path                          | Description           | Auth |
|--------|-------------------------------|-----------------------|------|
| POST   | /api/v1/templates             | Create template       | Yes  |
| GET    | /api/v1/templates             | List templates (paginated, default limit 100, #258) | Yes  |
| GET    | /api/v1/templates/:id         | Get template          | Yes  |
| PUT    | /api/v1/templates/:id         | Update template       | Yes  |
| DELETE | /api/v1/templates/:id         | Delete template       | Yes  |

### Suppressions

| Method | Path                                | Description                                | Auth |
|--------|-------------------------------------|--------------------------------------------|------|
| POST   | /api/v1/suppressions                | Add an address (idempotent upsert)         | Yes  |
| GET    | /api/v1/suppressions                | List, paginated, optional `?email=` filter | Yes  |
| GET    | /api/v1/suppressions/:id            | Get a suppression by ID                    | Yes  |
| DELETE | /api/v1/suppressions/:id            | Remove (recipient eligible immediately)    | Yes  |

`POST /api/v1/emails/send` returns HTTP 422 with `{ code: "RECIPIENT_SUPPRESSED", suppressionId }` when any recipient (any `to`, #178, `cc` or `bcc` address) is on the calling key's list (`suppressionId: null` for a shared hard suppression of another key, `SUPPRESSIONS_SHARED_HARD`, #250). No row inserted, no queue entry, no SMTP attempt. See [docs/suppressions.md](docs/suppressions.md) and [docs/bounces.md](docs/bounces.md).

A successful send also returns `warnings` (#245): the sender domain's records that are not verified (`dkim_unverified`, `spf_unverified`, `dmarc_unverified`, or `domain_unregistered` in development). An unregistered sender domain in production is `422 SENDER_DOMAIN_NOT_REGISTERED`; with `REQUIRE_VERIFIED_DOMAIN=true` a domain whose DKIM record is still unverified after one inline DNS re-check is `422 SENDER_DOMAIN_UNVERIFIED`. See [docs/emails.md](docs/emails.md#domain-linking).

### Inbound

| Method | Path                                | Description                                | Auth |
|--------|-------------------------------------|--------------------------------------------|------|
| GET    | /api/v1/inbound                     | List received emails (excludes trash)      | Yes  |
| GET    | /api/v1/inbound/trash               | List trashed inbound                       | Yes  |
| GET    | /api/v1/inbound/:id                 | Get received email                         | Yes  |
| DELETE | /api/v1/inbound/:id                 | Move to trash                              | Yes  |
| POST   | /api/v1/inbound/bulk-delete         | Bulk move to trash (`{ ids: [] }`)         | Yes  |
| POST   | /api/v1/inbound/:id/restore         | Restore from trash                         | Yes  |
| DELETE | /api/v1/inbound/:id/permanent       | Permanently delete a trashed inbound       | Yes  |
| POST   | /api/v1/inbound/trash/empty         | Permanently delete all trashed inbound     | Yes  |

### DMARC Reports

| Method | Path                                | Description                                | Auth |
|--------|-------------------------------------|--------------------------------------------|------|
| GET    | /api/v1/dmarc-reports               | List DMARC aggregate reports (filter by `?domain=`) | Yes |
| GET    | /api/v1/dmarc-reports/:id           | Single report + per-source-IP records      | Yes  |

### SMTP Submission

| Method | Path                                | Description                                | Auth |
|--------|-------------------------------------|--------------------------------------------|------|
| GET    | /api/v1/smtp-submission/stats       | SMTP submission usage + quota (calling key) | Yes  |

### Dashboard (HTML)

| Method | Path                               | Description             | Auth     |
|--------|------------------------------------|-------------------------|----------|
| GET    | /dashboard/login                   | Email + password login form | No   |
| POST   | /dashboard/login                   | Check email + password, open a session (`pending` for a 2FA account, #220) | No |
| GET    | /dashboard/login/two-factor        | Second login step form (#220) | Pending session |
| POST   | /dashboard/login/two-factor        | Check the TOTP or recovery code (throttled, replay-proof), `mfa` session with a new token (#220) | Pending session |
| POST   | /dashboard/login/two-factor/passkey/options | Passkey request options for the second step, the account's passkeys allowed, JSON (#223) | Pending session |
| POST   | /dashboard/login/two-factor/passkey | Verify a passkey assertion (same budget as codes), `mfa` session with a new token (#223) | Pending session |
| POST   | /dashboard/login/passkey/options   | Passwordless passkey options (discoverable), `bm_wa` cookie, one login attempt counted, JSON (#223) | Public |
| POST   | /dashboard/login/passkey           | Verify the passkey (origin, RP ID, UV, signature, counter), `mfa` session bound to it (#223) | Public |
| POST   | /dashboard/login/sso/:provider     | Start an SSO sign-in: same-origin, per-IP limiter checked, `bm_sso` cookie (`login`), 302 to the provider (#224) | Public |
| GET    | /dashboard/login/sso/:provider/callback | The provider's answer: per-IP limiter counted, `bm_sso` read and cleared, every flow check; a sign-in opens a session for the account linked to `(issuer, sub)` (`pending` with a second factor, else `password`, bound to the link), an unknown identity is first linked by its verified email when the provider has `SSO_<ID>_AUTO_LINK=true`; a link is finished for the same live session (#224) | `bm_sso` flow cookie |
| POST   | /dashboard/logout                  | Revoke the session, clear the cookie | No |
| GET    | /dashboard/setup?token=            | Owner setup form (read-only, never spends the token) | Setup token |
| POST   | /dashboard/setup                   | Set owner password, spend the token, sign in | Setup token |
| GET    | /dashboard/invite?token=           | Invitation accept form (read-only, never spends the token, #217) | Invite token |
| POST   | /dashboard/invite                  | Create the invited account, spend the token, sign in (#217) | Invite token |
| GET    | /dashboard/reset?token=            | Password reset form (read-only, never spends the token, #277) | Reset token |
| POST   | /dashboard/reset                   | Set the new password, spend the token, sign out everywhere, sign in (#277) | Reset token |
| GET    | /dashboard/assets/dashboard.css    | Self-hosted stylesheet, cached 1 year (#255) | No |
| GET    | /dashboard/assets/dashboard.js     | Dashboard script, cached 1 year (#255) | No |
| GET    | /dashboard                         | Stats overview          | Member |
| GET    | /dashboard/account/password        | Change password form (any role, #279) | Member |
| POST   | /dashboard/account/password        | Change own password: throttled current-password check, sign out every other session, new session here (#279) | Member |
| GET    | /dashboard/account/sessions        | Own live sessions: device, IP, approximate location, signed in, last active, this device marked (#281) | Member |
| POST   | /dashboard/account/sessions/:id/revoke | Sign out one own session (another user's id: 404, nothing changes); the current one signs this browser out (#281) | Member |
| POST   | /dashboard/account/sessions/revoke-others | Sign out every own session except the current one (#281) | Member |
| GET    | /dashboard/account/two-factor      | Own 2FA status, enrolment QR code and key, recovery codes shown once (#220) | Member |
| POST   | /dashboard/account/two-factor/start | New TOTP secret, kept encrypted on this session until confirmed (#220) | Member |
| POST   | /dashboard/account/two-factor/confirm | First code: 2FA on, ten recovery codes, every other session signed out, this one `mfa` (#220) | Member |
| POST   | /dashboard/account/two-factor/recovery-codes | Ten new recovery codes, needs an app code (#220) | Member |
| POST   | /dashboard/account/two-factor/disable | 2FA off, needs the password and a code (#220) | Member |
| GET    | /dashboard/account/passkeys        | Own passkeys: name, added, last used; add, rename, remove (#223) | Member |
| POST   | /dashboard/account/passkeys/options | Current password (password change budget), then creation options bound to this session, JSON (#223) | Member |
| POST   | /dashboard/account/passkeys        | Verify and store the new passkey; the first second factor signs out every other session, this one `mfa` (#223) | Member |
| POST   | /dashboard/account/passkeys/:id/rename | Rename an own passkey (#223) | Member |
| POST   | /dashboard/account/passkeys/:id/delete | Remove an own passkey, needs the password; its sessions end (#223) | Member |
| GET    | /dashboard/account/sso             | Sign-in methods: own SSO links, one row per configured provider (#224) | Member |
| POST   | /dashboard/account/sso/:id/link    | Owner rule, one link per provider, current password (password change budget), then the `bm_sso` cookie and a redirect to the provider `:id` (#224) | Member |
| POST   | /dashboard/account/sso/:id/unlink  | Remove an own SSO link `:id`, needs the password; the sessions it opened end (#224) | Member |
| GET    | /dashboard/send                    | Compose & send email    | Member |
| POST   | /dashboard/send                    | Queue email for send    | Member |
| GET    | /dashboard/emails                  | Email logs + filters + bulk-select | Member |
| GET    | /dashboard/emails/trash            | Trashed emails view     | Member |
| POST   | /dashboard/emails/bulk-trash       | Bulk move to trash      | Admin |
| POST   | /dashboard/emails/trash/bulk-restore   | Bulk restore        | Admin |
| POST   | /dashboard/emails/trash/bulk-permanent | Bulk hard-delete    | Admin |
| POST   | /dashboard/emails/trash/empty      | Empty email trash       | Admin |
| POST   | /dashboard/emails/:id/trash        | Move single to trash    | Admin  |
| POST   | /dashboard/emails/:id/restore      | Restore single          | Member |
| POST   | /dashboard/emails/:id/permanent    | Hard-delete single (writes tombstone) | Admin |
| GET    | /dashboard/emails/tombstones       | Tombstone list + Message-ID search | Member |
| GET    | /dashboard/emails/:id              | Email detail, attachments table (#181) | Member |
| GET    | /dashboard/emails/:id/attachments/:position | Forced download of one attachment (octet-stream, `attachment`, nosniff, sandbox CSP, no-store; 410 once dropped, #181) | Member |
| GET    | /dashboard/api-keys                | API keys management (a member: own keys, #219) | Member |
| POST   | /dashboard/api-keys                | Create API key (a member: restricted only, #219) | Member |
| POST   | /dashboard/api-keys/:id/revoke     | Revoke API key (a member: own keys, #219) | Member |
| POST   | /dashboard/api-keys/:id/admin      | Promote/demote a key to admin (#130) | Admin |
| POST   | /dashboard/api-keys/:id/senders    | Set a key's allowed senders (#126; a member: own keys, #219) | Member |
| GET    | /dashboard/invitations             | Pending invitations + invite form, one-time link (#217) | Admin |
| POST   | /dashboard/invitations             | Invite an address (owner: admin or member; admin: member) | Admin |
| POST   | /dashboard/invitations/:id/revoke  | Revoke an invitation (roles the actor may grant) | Admin |
| POST   | /dashboard/invitations/:id/resend  | New link for the same address and role, sent again | Admin |
| GET    | /dashboard/users                   | Every account with role, status and allowed actions (#218) | Admin |
| GET    | /dashboard/audit-log               | Security-relevant actions, filter by action, actor and outcome; read-only (#221) | Admin |
| POST   | /dashboard/users/:id/role          | Member to admin or back (owner only, in the service) | Admin |
| POST   | /dashboard/users/:id/deactivate    | Disable, revoke sessions and open invitations (owner: any non-owner; admin: members) | Admin |
| POST   | /dashboard/users/:id/reactivate    | Enable again (same rules) | Admin |
| POST   | /dashboard/users/:id/remove        | Delete, confirmed by the account's email (same rules) | Admin |
| POST   | /dashboard/users/:id/transfer      | Hand ownership to an active admin, confirmed by password (owner only, in the service) | Admin |
| POST   | /dashboard/users/:id/reset-password | One-time reset link, shown once to the issuer (same rules as deactivate, active accounts only, #277) | Admin |
| GET    | /dashboard/domains                 | Domains management      | Member |
| POST   | /dashboard/domains                 | Add domain              | Admin |
| POST   | /dashboard/domains/:id/delete      | Delete domain           | Admin |
| POST   | /dashboard/domains/:id/verify      | Verify domain DNS       | Admin |
| POST   | /dashboard/domains/:id/dkim/rotate | Start a DKIM key rotation (#250) | Admin |
| POST   | /dashboard/domains/:id/dkim/rotate/complete | Switch to the pending key once its record is published (#250) | Admin |
| POST   | /dashboard/domains/:id/dkim/rotate/cancel | Cancel the pending rotation (#250) | Admin |
| POST   | /dashboard/domains/:id/notify-email | Set/clear inbound notification address (#106) | Admin |
| POST   | /dashboard/domains/:id/unsubscribe | Set/clear List-Unsubscribe overrides (#243) | Admin |
| GET    | /dashboard/domains/:id             | Domain detail           | Member |
| GET    | /dashboard/templates               | Templates management    | Member |
| POST   | /dashboard/templates               | Create template         | Member |
| GET    | /dashboard/templates/:id           | Template detail + edit  | Member |
| POST   | /dashboard/templates/:id/edit      | Update template (a member: own templates, #219) | Member |
| POST   | /dashboard/templates/:id/delete    | Delete template (a member: own templates, #219) | Member |
| GET    | /dashboard/webhooks                | Webhooks management     | Member |
| POST   | /dashboard/webhooks                | Create webhook          | Admin |
| POST   | /dashboard/webhooks/:id/delete     | Delete webhook          | Admin |
| GET    | /dashboard/webhooks/:id/deliveries | Delivery history of one webhook (#30) | Member |
| GET    | /dashboard/webhooks/deliveries/:deliveryId | Delivery detail | Member |
| POST   | /dashboard/webhooks/deliveries/:deliveryId/replay | Re-queue a delivery | Admin |
| GET    | /dashboard/inbound                 | Inbound emails list + bulk-select | Member |
| GET    | /dashboard/inbound/trash           | Trashed inbound view    | Member |
| POST   | /dashboard/inbound/bulk-trash      | Bulk move to trash      | Admin |
| POST   | /dashboard/inbound/trash/bulk-restore   | Bulk restore       | Admin |
| POST   | /dashboard/inbound/trash/bulk-permanent | Bulk hard-delete   | Admin |
| POST   | /dashboard/inbound/trash/empty     | Empty inbound trash     | Admin |
| POST   | /dashboard/inbound/:id/trash       | Move single to trash    | Admin  |
| POST   | /dashboard/inbound/:id/restore     | Restore single          | Member |
| POST   | /dashboard/inbound/:id/permanent   | Hard-delete single      | Admin |
| GET    | /dashboard/inbound/:id             | Inbound email detail    | Member |
| GET    | /dashboard/inbound/:id/reply       | Compose form pre-filled as a reply (#86); the send sets `In-Reply-To` / `References` from the inbound id (#192) | Member |
| GET    | /dashboard/dmarc-reports           | DMARC reports list + domain filter | Member |
| GET    | /dashboard/dmarc-reports/:id       | DMARC report detail (per-source-IP) | Member |
| GET    | /dashboard/suppressions            | Suppressions across every API key (#89) | Member |
| POST   | /dashboard/suppressions/:id/delete | Remove a suppression (#89) | Admin |

Dashboard auth is account login (#216): email and password against `user_credentials`, then a server-side session in `sessions` whose opaque token rides in the `bm_session` cookie (only its SHA-256 is stored). Sessions expire after 24 h idle and 7 days at most; the token rotates after 60 s of use, and a replaced token presented after its 30 s grace revokes every session of the user. Logout deletes the row. `POST /dashboard/login` and `/dashboard/logout` require same-origin, and login is brute-force-throttled per client IP (5 failures / 15 min → `429`, #109), see [Rate Limiting](#rate-limiting). The owner account (#215) is claimed through the one-time `/dashboard/setup` link logged on first boot; completing it stores the owner password, deletes the owner's sessions and opens a new one. Every other account arrives by invitation (#217): an admin or the owner invites an address from `/dashboard/invitations`, the accept link is emailed from `SYSTEM_MAIL_FROM` (or shown to the inviter once), and `/dashboard/invite` creates the account and signs it in. A password login also sets the long-lived `bm_device` cookie (#282, 400 days, not a credential, only its SHA-256 stored in `user_devices`); a sign-in from a browser the account has not used in 30 days emails it a "New sign-in to your BunMail account" alert from `SYSTEM_MAIL_FROM` (no links), checked in the background so it never delays the login. Two-factor authentication (#220): an account with a TOTP second factor gets a `pending` session (10 minutes, admitted nowhere) after the password, and an `mfa` session with a new token after a valid code from its authenticator app or one of its ten recovery codes; codes are single-use (the last accepted time step is stored with a compare-and-swap) and every code check has a fixed budget (5 failures per 15 minutes, always on): the login step per account and per client IP, checks inside a session per session (a stolen session cannot lock the account's sign-in, and is revoked when its budget runs out). Turning 2FA on needs the current password; a `password`-level session stops working once its account has 2FA; the account is emailed (no links) when 2FA is turned on or off, recovery codes are replaced, a reset removes it, or its login code budget runs out. `REQUIRE_2FA` (`none` by default, `owner`, `admin`) holds an account it covers on its Two-factor page until it enrols. A completed reset link or `reset-owner` link removes the account's second factor (the lost-phone path). See [docs/dashboard.md](docs/dashboard.md#auth-flow) and [docs/users.md](docs/users.md#sessions-216).

Roles (#222): the session guard (an Elysia `resolve`) exposes the signed-in account to every protected handler as `auth` (`user: { id, email, role }`, `session: { id, assurance }`) from its single session lookup, and every protected route carries a role check as its own `beforeHandle` (`memberGuard`, `adminGuard` or `ownerGuard`, `src/pages/guards.tsx`; owner > admin > member). The Auth column above is the minimum role. A role too low gets `403` with a small Forbidden page and a `warn` log line. Account management (#218) adds owner-only and members-only rules inside `user-admin.service.ts`, checked against the live roles under the `bunmail:owner` lock; the sidebar hides admin-only links from members. `test/integration/dashboard-route-access.integration.test.ts` fails on any route missing from its table or carrying the wrong guard. See [docs/dashboard.md](docs/dashboard.md#roles-222).

### Health

| Method | Path     | Description    | Auth |
|--------|----------|----------------|------|
| GET    | /health  | Health check   | No   |
| GET    | /metrics | Prometheus metrics (#362), see [docs/metrics.md](docs/metrics.md) | `Bearer <METRICS_TOKEN>`; 404 when unset |

### Unsubscribe (public, #249)

| Method | Path       | Description | Auth |
|--------|------------|-------------|------|
| GET    | /u/:token  | Confirmation page; never suppresses (prefetch-safe). Invalid token: `404` | Token |
| POST   | /u/:token  | RFC 8058 one-click (`List-Unsubscribe=One-Click`) or the confirmation form: permanent `unsubscribe` suppression for the sending key, `email.unsubscribed` on first creation | Token |

Not under `/api/v1` and outside the auth middleware: the token (an HMAC over email id, recipient and API key) is the credential. Rate limited to 30 requests a minute per client IP; `no-store`, `no-referrer`, `noindex`, page CSP with no script. The inbound receiver also turns mail to `unsub+<token>@<sender domain>` into the same suppression. See [docs/suppressions.md](docs/suppressions.md#one-click-unsubscribe).

---

## Authentication

- **Method:** Bearer token in `Authorization` header
- **Key format:** `bm_live_<random>` (e.g., `bm_live_a1b2c3d4e5f6g7h8`)
- **Storage:** Only SHA-256 hash stored in DB; raw key shown once at creation
- **Lookup:** Hash incoming token → match against `key_hash` column
- **Roles (#130):** keys are **admin** or **restricted** (`is_admin`). `adminMiddleware` (`src/middleware/auth.ts`, used after `authMiddleware`) gates the management plane (`/api/v1/api-keys`, `/api/v1/domains`, `/api/v1/inbound`) returning `403 ADMIN_REQUIRED` for restricted keys. `is_admin` is operator-set only (dashboard + seed), never via a REST DTO. Existing keys migrated to admin; new API-created keys default restricted.
- **Bootstrap:** Run `bun run src/db/seed.ts` to create the first API key (admin). The dashboard owner is created on boot from `BUNMAIL_OWNER_EMAIL` (#215); recover a lost setup link with `bun run src/db/reset-owner.ts`
- **Dashboard (separate from API keys, #216):** account login (email + password, argon2id) and server-side sessions in Postgres. The cookie token is looked up by its SHA-256 through an indexed column, so no secret is compared in JavaScript; sessions rotate their token every minute with reuse detection, and `reset-owner` signs the owner out everywhere. Optional TOTP two-factor authentication with recovery codes, mandatory for the owner or admins with `REQUIRE_2FA` (#220). Passkeys (WebAuthn, `@simplewebauthn/server`): a phishing-resistant passwordless sign-in or second factor, bound to `APP_BASE_URL`, user verification required, clone detection on the signature counter (#223). Single sign-on with any OpenID Connect provider (`oauth4webapi`, #224): authorization code + PKCE, an identity keyed by `(issuer, sub)` and signing in only to the account it was linked to (explicitly behind the password, or by verified email for members when a provider opts in), a first factor only, so BunMail's own second factor still applies; an owner with a link always keeps a second factor. Every protected route requires a minimum account role (owner > admin > member, #222). Details: [docs/dashboard.md](docs/dashboard.md#auth-flow)

---

## Rate Limiting

Independent fixed-window limiters, in the shared store (`src/utils/shared-store.ts`, #185): Redis when `REDIS_URL` is set, else process memory:

**API requests** (`src/middleware/rate-limit.ts`, algorithm in `rate-limit-core.ts`)
- **Default limit:** 100 requests per minute per API key
- **Scope:** Per API key ID
- **Response on limit:** `429 Too Many Requests` with `Retry-After` header
- **Tunable:** `API_RATE_LIMIT_MAX` / `API_RATE_LIMIT_WINDOW` (seconds)

**Dashboard login** (`src/middleware/login-rate-limit.ts`, #109)
- **Default limit:** 5 failed logins (any reason) per 15 minutes, per client IP; no per-account lockout
- **Scope:** Per client IP: resolved by counting `DASHBOARD_TRUSTED_PROXY_HOPS` entries from the right of `X-Forwarded-For` (default `0` = raw socket IP; the leftmost header entry is never trusted)
- **Response on limit:** `429 Too Many Requests` with `Retry-After`; a successful login gives back only its own attempt, earlier failures stay until the window ends (#256); IPv6 clients counted per `/64`
- **Tunable:** `DASHBOARD_LOGIN_RATE_LIMIT_{ENABLED,MAX,WINDOW}` (MAX 1 to 100, WINDOW 60 to 86400 seconds, validated at boot, #220; two-factor code checks keep a fixed 5 per 15 minutes)

**SMTP submission** (`src/modules/smtp-submission/services/submission-limits.ts`, #120, #190)
- **Connections:** 30 per 60 s per IP (`SMTP_SUBMISSION_RATE_LIMIT_*`), then `421`
- **Failed AUTH:** 10 per 900 s per IP (`SMTP_SUBMISSION_AUTH_RATE_LIMIT_*`), then `454` before the key is looked up; each AUTH is counted before the lookup and a valid key gives back its own count, into that window only; earlier failures stay
- **Client address:** the socket's, IPv6 per /64 and IPv4-mapped as IPv4 (the login's buckets, #256); a load balancer in front must preserve the client source address (no SNAT; PROXY protocol is not supported yet)

**Inbound SMTP connections** (`src/modules/inbound/services/connection-limit.ts`): 10 per 60 s per IP (`SMTP_RATE_LIMIT_*`), then `421`

**Dashboard DNS verify** (`src/pages/lib/dns-verify-throttle.ts`, #133): 5 DNS checks per minute per domain id (verify and the DKIM rotation's complete step)

Check and count are one atomic step (a Lua script in Redis), so a parallel burst cannot pass a limit, on one replica or several. Without `REDIS_URL` the counters live in memory: they reset on restart and are per replica (one replica only); one sweep every 5 minutes drops ended windows from every in-memory counter (`startLocalCounterSweep`). See [Several replicas](#several-replicas) below.

---

## Email Delivery

BunMail sends emails directly to recipient MX servers: no SMTP relay or third-party provider. For each recipient domain the mailer resolves the MX hosts itself on every attempt (#250): sorted by preference with ties shuffled, the domain's own A/AAAA records when it has no MX (implicit MX), a terminal failure for NXDOMAIN, a null MX or no records at all, and a retry for any temporary DNS error. It refuses private or loopback addresses (unless `MAIL_ALLOW_PRIVATE_MX=true`), and builds a Nodemailer transport to a checked address on port 25 with the MX name as TLS SNI (opportunistic STARTTLS, TLS 1.2 at least, certificates not verified). A recipient domain that publishes an MTA-STS policy (RFC 8461, #250) in enforce mode gets only the MX hosts the policy names, with STARTTLS required and the certificate verified for the MX name; a TLS failure or no matching host is retried, never bounced. The policy is fetched over HTTPS from `mta-sts.<domain>`, pinned to an address that passed the same private-address check, and cached in memory per domain and policy `id` until `max_age` (per replica). Each entry records the mode it ran under (`mtaSts`). See [docs/emails.md](docs/emails.md#mta-sts-250). It fails over to the next address or host (at most 5 hosts, 2 addresses each, one shared session deadline) only on a connection-level failure or a `421`; any other reply decides the attempt. When the MX accepts some recipients of a transaction and refuses others at `RCPT TO`, each refused recipient gets its own entry: retried for a 4xx, failed and suppressed for a 5xx. See [docs/emails.md](docs/emails.md#mx-resolution-and-failover-250). Each delivery-state entry records whether its latest session used STARTTLS or plaintext (`tls`, read from Nodemailer's connection events, #250); the API returns it in `deliveryState`, and the email detail page badges a plaintext delivery. See [docs/emails.md](docs/emails.md#tls-record-250).

Sessions are throttled per **provider bucket** (#91, #250): every Microsoft, Google, Yahoo or Apple MX host counts as one bucket per provider, any other MX as its registrable domain, with `MAIL_MX_CONCURRENCY` sessions at once per bucket (default 1), per replica, or across every replica with `REDIS_URL` (#185, see [Several replicas](#several-replicas)). The optional `MAIL_MX_RATE_PER_MIN` adds a token bucket of messages per minute per bucket; a message over it is deferred (the email back to `queued` until a token is due, no attempt counted, no error, no webhook), and the other recipient domains of the email go ahead. MX hosts are reached over IPv4 when they have an IPv4 address (`MAIL_IP_FAMILY=4`, the default) or over IPv6 first (`6`). Both limits are in memory, per replica, unless `REDIS_URL` is set, which shares them across replicas (#185, #391). There is no source-address setting (Bun ignores `localAddress`), and no connection reuse across sessions. See [docs/emails.md](docs/emails.md#throttle-provider-buckets-and-rate-budget-250).

**What this means:**
- The server's IP reputation directly affects deliverability
- DKIM, SPF, and DMARC records are critical to avoid spam folders
- A PTR (reverse DNS) record should match the sending hostname
- The sending IPs are checked daily on Spamhaus ZEN, Barracuda and SpamCop (#250, information only, see [Sending IP DNSBL Self-check](#sending-ip-dnsbl-self-check-250))

**DKIM Signing:**
- RSA 2048-bit key pair generated per domain
- Private key encrypted at rest with AES-256-GCM via `DKIM_ENCRYPTION_KEY` (#23); public key provided as DNS TXT record value
- Decrypted in memory on each send and used by BunMail's own signer (`dkim-signer.service.ts`, #345), not nodemailer's. A key that does not decrypt fails closed in production (#244): the boot refuses to start, naming the domains, and the queue holds the email on the retry backoff instead of sending it unsigned (development warns and sends unsigned)
- relaxed/relaxed, rsa-sha256 (ed25519-sha256 for an ed25519 key), the same tags nodemailer emitted. **Over-signing (#345):** `h=` lists each signed field once per instance and the over-signed set (From, Sender, Reply-To, To, Cc, Subject, Date, Message-ID, In-Reply-To, References, MIME-Version, Content-Type, Content-Transfer-Encoding, Content-Disposition, List-Unsubscribe, List-Unsubscribe-Post, Auto-Submitted, Feedback-ID) once more, so a field of that set added in transit (a second `From:`) breaks the signature
- The message is composed once per send with nodemailer's `MailComposer`, signed before any DNS lookup or connection, and handed to nodemailer as `raw` bytes with each transaction's envelope, so what is signed is exactly what is sent. A key that decrypts but cannot sign is never sent unsigned: a queued email is held on the retry backoff like an undecryptable key (#244), and system mail reports a failed send. See [docs/emails.md](docs/emails.md#dkim-signing-345)

**Bounce → Suppression chain:** two paths converge on the same suppression list and webhook event.
- **Inline 5xx** during the SMTP transaction → classified per group, or per refused recipient when the MX accepted others (#250) ([`classifySendFailure`](src/utils/smtp-error.ts)) and recorded by the queue's `recordSendOutcome` ([queue-outcome.service.ts](src/modules/emails/services/queue-outcome.service.ts)): the suppression, `email.bounced` and the email's status in one transaction (#184). Auto-suppress on attempt 1; **don't retry** (#68).
- **Async DSN** received at the inbound SMTP → routed to the bounce module ([src/modules/bounces/](src/modules/bounces/)) before generic inbound storage (#24). Only a DSN delivered to a verified **signed return path** counts (#236): with `SMTP_ENABLED=true` and the sender domain's MX naming `MAIL_HOSTNAME` (cached per domain; other domains keep the From address as envelope sender), each recipient is sent in its own SMTP transaction with envelope sender `b+<email id hex>.<recipient index>.<MAC>@<sender domain>` (HMAC under a key derived from `DKIM_ENCRYPTION_KEY`), the receiver refuses (`550`) a `b+` address that does not verify, and the DSN then applies to exactly that email and recipient, whatever its body says. A DSN to any other address (the Message-ID link of before #236) has no effect; non-DSN mail to a return path (auto-replies) is dropped. Same sender domain as before, so SPF and DMARC alignment are unchanged. See [docs/bounces.md](docs/bounces.md#signed-return-paths-236).
- Hard bounces (5.x.x) → permanent per-API-key suppression in either path. A sender policy block (5.7.x, or a reply naming a blocklist, reputation or SPF/DKIM/DMARC failure) suppresses nobody, inline (#246: the group fails with `blocked: true` and `email.failed` carries `blocked: true`) or in an async DSN, which is classified by the same `parseSmtpError` rules (#250: a `sent` email is marked `failed` with the reason and `email.failed` fires with `blocked: true`, no `email.bounced`).
- A bounce never weakens a suppression (#191): `addFromBounce` only rewrites a temporary row; a permanent one (complaint, unsubscribe, manual, earlier hard bounce) is kept, and the email is still marked `bounced` and `email.bounced` still fires. Precedence: complaint > unsubscribe / manual / hard bounce > temporary. See [docs/suppressions.md](docs/suppressions.md#precedence).
- Soft bounces (4.x.x): async DSN path applies a 24h windowed suppression with escalation to permanent on a second soft bounce. Inline 4xx path retries with backoff until the email is `MAIL_RETRY_MAX_AGE_HOURS` old (#180), then `failed`; only a recipient whose last reply was `4.2.2` (mailbox full) then gets a 24h soft suppression and a soft `email.bounced`, in the outcome transaction (#250). Other 4xx codes and failures with no SMTP reply get neither, and there is no soft → hard escalation inline.
- Subsequent sends to suppressed recipients return HTTP 422 with `code: "RECIPIENT_SUPPRESSED"` from the gate at `createEmail`.

**Unsubscribe → Suppression (#249):** `transactional` mail and BunMail's own mail carry no `List-Unsubscribe`, and `marketing` mail is accepted only when it can carry the per-recipient link (#250). Single-recipient mail carries a per-recipient `List-Unsubscribe` (`<APP_BASE_URL/u/<token>>` + One-Click, and `<mailto:unsub+<token>@<domain>>` when `SMTP_ENABLED`). A one-click POST, the confirmation page or a message to that mailbox (handled before generic inbound storage) becomes a permanent `unsubscribe` suppression under the sending key and fires `email.unsubscribed` once.

**Complaint → Suppression (#191):** ARF feedback reports (RFC 5965, `multipart/report; report-type=feedback-report`) from mailbox-provider feedback loops arrive at the inbound SMTP and are routed to the feedback handler before the bounce parser, never stored as inbound mail. A report counts only when its Original-Message-ID (feedback part, or the reported message's headers) exactly matches the Message-ID of an email BunMail sent; unlinkable reports are logged and dropped. `abuse` / `fraud` (or no type) → permanent `complaint` suppression for the recipient under the email's key (strongest reason: replaces any other) + `email.complained`; `opt-out` → the #249 unsubscribe path (`source: "fbl"`); `not-spam`, `virus` and the rest are dropped. DKIM on the report is checked by the built-in verifier (`dkim-verifier.service.ts`, #373) and logged, not required. See [docs/feedback-loops.md](docs/feedback-loops.md).

---

## Deployment

```yaml
# docker-compose.yml (abridged: SMTP ports are published from docker-compose.override.yml, #205)
x-logging: &default-logging          # log rotation (#284): 5 files of 10 MB per container
  driver: json-file
  options:
    max-size: "10m"
    max-file: "5"

services:
  app:
    logging: *default-logging
    build: .
    ports:
      - "127.0.0.1:${PORT:-3000}:${PORT:-3000}"   # HTTP API + Dashboard, loopback only (#205)
    env_file: .env                     # DKIM_ENCRYPTION_KEY, MAIL_HOSTNAME, BUNMAIL_OWNER_EMAIL, ...
    environment:
      DATABASE_URL: postgres://${POSTGRES_USER:-bunmail}:${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env}@db:5432/${POSTGRES_DB:-bunmail}
      BUNMAIL_ENV: production          # always: the production config guards apply
    depends_on:
      db:
        condition: service_healthy
    sysctls:
      net.ipv4.ip_unprivileged_port_start: 0   # non-root user may bind 25/465/587 (#167)
    restart: unless-stopped

  db:
    logging: *default-logging
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-bunmail}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env}
      POSTGRES_DB: ${POSTGRES_DB:-bunmail}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-bunmail}"]
      interval: 5s
      timeout: 5s
      retries: 5
    restart: unless-stopped

volumes:
  pgdata:
```

Because compose always sets `BUNMAIL_ENV=production`, the app refuses to start until `.env` has `POSTGRES_PASSWORD`, `DKIM_ENCRYPTION_KEY` (#23, `openssl rand -base64 32`), a real `MAIL_HOSTNAME` (#242) and `BUNMAIL_OWNER_EMAIL` (#215, the dashboard login account since #216). `DASHBOARD_PASSWORD` and `SESSION_SECRET` are no longer read (#216). Optional for invitations (#217): `SYSTEM_MAIL_FROM` (sender of invitation emails and new-device sign-in alerts (#282), on a DKIM-verified domain registered in BunMail; malformed refuses to boot) and `INVITE_EXPIRY_DAYS` (1 to 90, default 7); set `APP_BASE_URL` too, or invitation and password reset links point at `localhost`. Optional for the Active sessions page (#281): `GEOIP_DB_PATH` (an offline DB-IP Lite or GeoLite2 `.mmdb` file) or `GEOIP_PROVIDER=ipinfo` with `GEOIP_API_TOKEN` (online, sends every sign-in IP to ipinfo.io) for an approximate location per session; unset, no location is shown, and a bad combination refuses to boot. Optional: `REQUIRE_2FA` (#220): `none` (default), `owner` or `admin` (admins and the owner) must set up two-factor authentication before using the dashboard; anything else refuses to boot. Optional: `AUDIT_LOG_RETENTION_DAYS` (#221, 30 to 3650, default 365) sets how long audit log entries are kept; anything else refuses to boot. Optional (#258): `WEBHOOKS_MAX_PER_API_KEY` (1 to 100, default 10) caps webhooks per API key, and `WEBHOOK_DELIVERY_RETENTION_DAYS` (1 to 365, default 30) sets how long finished webhook deliveries are kept; anything else refuses to boot. Optional: `IDEMPOTENCY_KEY_TTL_HOURS` (#188, 1 to 168, default 24) sets how long an `Idempotency-Key` on the send API is remembered; anything else refuses to boot. Optional: `ATTACHMENTS_MAX_TOTAL_MB` (#181, 1 to 18 MB of 1,000,000 bytes, default 5) caps the decoded attachments of one email; the HTTP body limit and the SMTP submission size limit follow it; anything else refuses to boot. Optional: `INBOUND_NOTIFY_PREVIEW=true` (#250) adds the original subject and a link-stripped preview to the body of inbound notifications (default `false`: no inbound content; only `true` or `false`, anything else refuses to boot). Optional: `REQUIRE_VERIFIED_DOMAIN=true` (#245) refuses sends from a domain whose DKIM record is not verified (default `false`: queued, with `warnings` in the send response). Optional (#250): `DOMAIN_REVERIFY_ENABLED` (default `true`) and `DOMAIN_REVERIFY_INTERVAL_HOURS` (6 to 168, default 24) control the scheduled DNS re-verification of domains; anything invalid refuses to boot. Optional: `SUPPRESSIONS_SHARED_HARD=true` (#250) also refuses addresses any API key holds a permanent hard-bounce or complaint suppression for (default `false`; only `true` or `false`, anything else refuses to boot). Optional: `SENDING_IP_DNSBL_CHECK=false` (#250) turns off the daily DNSBL self-check of the sending IPs (default `true`; only `true` or `false`, anything else refuses to boot). Optional: `REDIS_URL` (#185) moves the state several replicas must share (rate limits, login throttles, one-time reveals) to Redis or Valkey: a `redis://` or `rediss://` URL with a host, optional credentials and database number (anything else refuses to boot; never logged with its password); unset keeps it in memory, for one replica (see [Several replicas](#several-replicas)). Optional: `METRICS_TOKEN` (#362) turns on `GET /metrics` for Prometheus scrapers that send it as a bearer token (unset: the endpoint is a 404; 32 to 256 letters, digits, `-` or `_` with at least 8 distinct characters, anything else refuses to boot; see [docs/metrics.md](docs/metrics.md)). Optional: OpenTelemetry tracing (#363), off by default: `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (an http(s) URL; OTLP/HTTP protobuf) or `OTEL_TRACES_EXPORTER=otlp` turns it on, `OTEL_SDK_DISABLED=true` or `OTEL_TRACES_EXPORTER=none` forces it off, with `OTEL_SERVICE_NAME` (`bunmail`), `OTEL_TRACES_SAMPLER` (`parentbased_always_on`) and `OTEL_TRACES_SAMPLER_ARG` (`1`); malformed values refuse to boot; see [docs/tracing.md](docs/tracing.md). Optional: single sign-on with OpenID Connect (#224; accounts link an identity on Account > Sign-in methods, then use "Sign in with `<label>`" on the login page, BunMail's own second factor still applying): `SSO_PROVIDERS` (provider ids) with, per id, `SSO_<ID>_ISSUER` (required, except for the presets `google` and `gitlab`, whose issuer defaults), `SSO_<ID>_CLIENT_ID` and `SSO_<ID>_CLIENT_SECRET` (the switch: both set enable a provider, and enable a preset even when it is not listed; a listed provider with neither is skipped with a boot warning, one with only one of the two refuses to boot), `SSO_<ID>_LABEL` (`Google` / `GitLab` for a preset, else the id), `SSO_<ID>_SCOPES` (`openid email profile`), `SSO_<ID>_ALLOWED_DOMAINS` and `SSO_<ID>_AUTO_LINK` (`false`; `true` links a member's first SSO sign-in by verified email, needs allowed domains and is refused for a Microsoft Entra issuer); any malformed value, and two ids with the same issuer, refuse to boot, and SSO stays off with a boot warning unless `APP_BASE_URL` is `https://` (plain `http://` only on a loopback host). GitHub (no OpenID Connect) and Apple (`form_post` responses) are not supported. The redirect URI to register is `${APP_BASE_URL}/dashboard/login/sso/<id>/callback` (see [docs/self-hosting.md](docs/self-hosting.md#single-sign-on-224) and [docs/users.md](docs/users.md#single-sign-on-224)). Optional tuning, with defaults: `PORT` (`3000`) and `HOST` (`0.0.0.0`); `API_RATE_LIMIT_MAX` / `API_RATE_LIMIT_WINDOW` (`100` requests per `60` seconds, positive integers); `DASHBOARD_TRUSTED_PROXY_HOPS` (`0`) and `DASHBOARD_LOGIN_RATE_LIMIT_ENABLED` / `_MAX` / `_WINDOW` (`true`, `5` from 1 to 100, `900` seconds from 60 to 86400); `MAIL_PUBLIC_IP` (unset: the A/AAAA records of `MAIL_HOSTNAME`), `MAIL_MX_CONCURRENCY` (`1`), `MAIL_MX_RATE_PER_MIN` (unset, 1 to 100000), `MAIL_IP_FAMILY` (`4` or `6`, default `4`), `MAIL_RETRY_MAX_AGE_HOURS` (`48`, a positive integer) and `MAIL_ALLOW_PRIVATE_MX` (`false`); `QUEUE_BATCH_SIZE` (`5`, 1 to 100), `QUEUE_POLL_INTERVAL_MS` (`2000`, 250 to 60000) and `QUEUE_MAX_CONCURRENT_SENDS` (`10`, 1 to 500); `INBOUND_NOTIFY_ENABLED` (`true`) and `INBOUND_NOTIFY_FROM_LOCAL` (`notifications`); `TRASH_RETENTION_DAYS` (`7`) and `TOMBSTONE_RETENTION_DAYS` (`90`); `WEBHOOK_ALLOW_INSECURE_HTTP` (`false`); `LOG_LEVEL` (`info`: `debug`, `info`, `warn` or `error`) and `LOG_REDACT_PII` (`true` in production, `false` in development). The SMTP listeners' variables are listed below. Out-of-range values of the bounded variables refuse to boot. Descriptions: [.env.example](.env.example) and [docs/self-hosting.md](docs/self-hosting.md). Upgrading from 0.9.x: see the upgrade guide in the 0.10.0 entry of [CHANGELOG.md](CHANGELOG.md). For local development, `docker-compose.override.example.yml` (copy it to the untracked `docker-compose.override.yml`, #205) publishes Postgres on `127.0.0.1:5432` (#209).

**Local development:** Use [Neon](https://neon.tech) (free PostgreSQL cloud) to avoid installing PostgreSQL locally. Set `DATABASE_URL` in `.env`.

**Production:** `docker compose up -d --build` starts the app (published on `127.0.0.1:$PORT`, behind a reverse proxy) and PostgreSQL (compose network only). Host-specific ports and mounts live in an untracked `docker-compose.override.yml` copied from `docker-compose.override.example.yml` (#205). The container runs `bun run db:migrate && bun run start`, so pending migrations apply on every start.

### Optional SMTP listeners

Beyond the HTTP server, the app can start two independent, opt-in SMTP listeners as background services (both off by default; publish each port from `docker-compose.override.yml`, see `docker-compose.override.example.yml`, #205):

| Listener | Toggle / port env | Purpose |
|---|---|---|
| **Inbound receiver** | `SMTP_ENABLED` / `SMTP_PORT` (default `2525`; use `25` in production) | Receives MX mail for your domains → `inbound_emails` (AUTH disabled; validates recipient domains). Spam protection: `SMTP_DNSBL_ENABLED` (`true`), `SMTP_DNSBL_ZONE` (`zen.spamhaus.org`), `SMTP_RECIPIENT_VALIDATION` (`true`), `SMTP_RATE_LIMIT_ENABLED` / `_MAX` / `_WINDOW` (`true`, `10` connections per `60` seconds). See [docs/inbound.md](docs/inbound.md). |
| **Submission server** (#120) | `SMTP_SUBMISSION_ENABLED` / `SMTP_SUBMISSION_PORT` (`465` with a TLS cert, `587` without) | Lets apps send *through* BunMail over SMTP (AUTH required = API key; relays to any recipient via `createEmail`). TLS via `SMTP_SUBMISSION_TLS_CERT`/`_KEY`: implicit TLS from the first byte, terminated by Bun's TLS server (`SMTP_SUBMISSION_TLS_MODE`, default `implicit`; `starttls` refuses to boot on Bun, which cannot upgrade a connection server-side, #349), or `SMTP_SUBMISSION_ALLOW_INSECURE=true` for plaintext AUTH on a trusted network (default `false`: with neither TLS nor this flag the server refuses to start); per-IP connection and failed-AUTH throttles via `SMTP_SUBMISSION_RATE_LIMIT_ENABLED` / `_MAX` / `_WINDOW` (`true`, `30` per `60` seconds) and `SMTP_SUBMISSION_AUTH_RATE_LIMIT_ENABLED` / `_MAX` / `_WINDOW` (`true`, `10` failures per `900` seconds); `SMTP_SUBMISSION_DAILY_QUOTA` per key per UTC day (`0`: unlimited). See [docs/smtp-submission.md](docs/smtp-submission.md). |

Both are started from [src/index.ts](src/index.ts) after the queue processor and stopped in the graceful shutdown handler.

### Several replicas

The send queue, webhook deliveries, the domain re-verification and the owner bootstrap coordinate through Postgres (`FOR UPDATE SKIP LOCKED`, leases, advisory locks), so several app containers on one database never double-send. The rest of the shared state needs `REDIS_URL` (#185, optional; Redis or Valkey on Bun's built-in client, no dependency; Redis Cluster is not supported):

| State | Without `REDIS_URL` | With `REDIS_URL` | When Redis fails |
|---|---|---|---|
| API rate limit (`rl:api`) | per replica, in memory | one budget per key across replicas | falls back to per-replica memory, `error` line once a minute |
| Login, passkey sign-in, ownership transfer, password re-check and two-factor code budgets (`rl:login`) | per replica | shared | falls back to per-replica memory (still throttled, nobody locked out) |
| SMTP submission failed-AUTH and connection limits (`rl:smtp-auth`, `rl:smtp-submission`) | per replica (N replicas allow N times the API-key guesses) | one budget per IP across replicas | falls back to per-replica memory |
| Inbound SMTP connection limit (`rl:smtp-inbound`), dashboard DNS-verify throttle (`rl:dns-verify`) | per replica | shared | falls back to per-replica memory |
| `last_used_at` write claim, once a minute per API key (`throttle:last-used`) | per replica | one write a minute per key across replicas | falls back to per-replica memory (a few extra writes) |
| Outbound MX sessions per provider bucket (`slots:mx`) | per replica (N replicas open N times `MAIL_MX_CONCURRENCY`) | one limit across replicas: slots leased for 60 s, renewed every 20 s while the session runs; waiters served first come, first served | falls back to per-replica memory, `error` line once a minute |
| Outbound MX rate budget per provider bucket (`rate:mx`, #391) | per replica (N replicas send N times `MAIL_MX_RATE_PER_MIN`) | one token bucket per provider across replicas, refilled continuously (Redis clock) | falls back to per-replica memory (starts full), `error` line once a minute |
| One-time reveal tokens (`reveal`) | per replica: the GET after a create must reach the same replica | any replica redeems; the key is the token's SHA-256, the secret AES-256-GCM encrypted with `DKIM_ENCRYPTION_KEY` | fails closed: the secret is not shown (revoke and recreate), `error` line |

Every Redis key expires (counters with their window, reveals after 60 s, MX slots with their latest lease, MX rate buckets once they would be full again). Redis must answer a `PING` at boot or the app refuses to start; a later outage degrades as above, reconnects on demand (backoff from 500 ms to 30 s, 1 s command timeout) and logs `Redis connection lost` / `Redis connection restored`. #185 is complete: every in-memory map it listed is shared. The MX rate budget is shared too (#391). Still per replica: passkey challenges (sticky sessions needed), the two-factor alert mark, and the notification, replay and unsubscribe budgets.

---

## Error Handling

- Services throw; routes don't catch
- Elysia's global `onError` handler in [src/index.ts](src/index.ts) maps known error classes to structured JSON responses:
  - Request validation failure → 422 with `{ code: "VALIDATION_ERROR", details: [{ path, message }] }` (submitted values never echoed); malformed JSON → 400 `INVALID_BODY`
  - `NOT_FOUND` → 404 (HTML for `Accept: text/html`, JSON otherwise)
  - `SuppressedRecipientError` → 422 with `{ code: "RECIPIENT_SUPPRESSED", suppressionId }` (#25)
  - `EmailSendRejectedError` subclasses (`src/modules/emails/errors.ts`) → their own status and code: 404 `TEMPLATE_NOT_FOUND`; 422 `SENDER_DOMAIN_NOT_REGISTERED`, `SENDER_DOMAIN_UNVERIFIED` (#245), `SUBJECT_REQUIRED`, `BODY_REQUIRED` (#250), `INVALID_CUSTOM_HEADER` (#177), `IDEMPOTENCY_KEY_REUSED` (#188), `MARKETING_REQUIRES_ONE_CLICK` (#250), `TOO_MANY_ATTACHMENTS`, `ATTACHMENTS_TOO_LARGE`, `ATTACHMENT_TYPE_NOT_ALLOWED` (with `index`, #181); an invalid `fromName` (`InvalidFromNameError`, #250) is 422 `VALIDATION_ERROR` with `details` naming `/fromName`, an invalid attachment input (`InvalidAttachmentError`, #181) the same at `/attachments/<i>/<field>`
  - `DomainAlreadyRegisteredError` → 409 `DOMAIN_ALREADY_REGISTERED`; `InvalidDkimSelectorError` → 422 `INVALID_DKIM_SELECTOR`; `DkimRotationError` → 409 with its code (`DKIM_ROTATION_PENDING`, `DKIM_NO_PENDING_ROTATION`, `DKIM_PENDING_NOT_PUBLISHED`, `DKIM_PENDING_KEY_UNREADABLE`, #250)
  - `TemplateTooLargeError` → 422 `TEMPLATE_OUTPUT_TOO_LARGE`
  - `InactiveApiKeyError` → 401 `API_KEY_REVOKED`
  - `ApiKeyCreatorInactiveError` → 403 `API_KEY_CREATOR_INACTIVE` (#219)
  - `UnauthorizedSenderError` → 403 with `{ code: "UNAUTHORIZED_SENDER", sender }`: `From` not in the key's allowed-senders list (#126)
  - `InboundEventsRequireAdminError` → 403 `INBOUND_EVENTS_REQUIRE_ADMIN`
  - `BlockedUrlError` → 422 `WEBHOOK_URL_BLOCKED` (#128)
  - `WebhookLimitReachedError` → 422 `WEBHOOK_LIMIT_REACHED` (#258)
  - `ReplayLimitReachedError` → 429 `REPLAY_LIMIT_REACHED` with `Retry-After` (#258)
  - Unhandled errors → 500; the client gets `"Internal server error"` in production (#133), the message in development; the detail is logged server-side
- Email queue failures are logged and stored in the `last_error` column

---

## Future (v2+)

- Open/click tracking
- Analytics dashboard with charts
- SDK packages (`npm i bunmail`)
- CLI tool (`bunx bunmail init`)
- Scheduled emails
- Bun-native SMTP client (subsumes #37, #42, see #60)
- Redis backing for the per-replica state left outside #185: passkey challenges, the other budgets
