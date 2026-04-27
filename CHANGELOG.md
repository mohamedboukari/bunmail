# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Cap on outbound email body size — `html` and `text` fields are now limited to 5 MB each via DTO validation; oversize payloads return `422`. (#26)
- Periodic cleanup for the in-memory HTTP rate-limit map; expired entries are pruned every 5 minutes so the map can't grow unbounded under high cardinality. (#22)
- Opportunistic STARTTLS on outbound delivery — every recipient MX that advertises STARTTLS is now upgraded to TLS. Documented in `SECURITY.md`. (#21)
- Webhook event union now includes `email.received` (fired by the inbound SMTP path) and `email.complained` (reserved for FBL processing). (#31)

### Fixed

- The inbound SMTP receiver no longer casts `"email.received"` to `"email.queued"` to silence the type checker — the event name is properly typed and accepted by the webhook DTO. (#31)

### Security

- BunMail refuses to start in production with an empty `DASHBOARD_PASSWORD`. The dashboard mounts unscoped read/write routes across all API keys, so a deployment with `BUNMAIL_ENV=production` and no password is rejected with a clear error at config load. Development behaviour is unchanged (empty password disables the dashboard). (#19)

### Changed

- `LOG_LEVEL` is now validated at config load — invalid values fail loudly with a clear error instead of silently behaving like the default. (#39)
- Auth middleware no longer hashes the bearer token or queries `api_keys` twice per request. The lookup result is cached on the `Request` (via a `WeakMap`) and reused by `resolve`, halving DB load on the auth path. (#27)
- `api_keys.last_used_at` writes are now throttled to once every 60 s per key. A hot caller no longer fires one `UPDATE` per request; the timestamp can lag by up to the throttle window. (#28)

## [0.3.0] - 2026-04-26

### Added

- Trash / soft-delete for outbound and inbound emails — Gmail-style trash with restore, permanent delete, and "empty trash"
- Auto-purge service that permanently removes trashed emails after `TRASH_RETENTION_DAYS` (default `7`)
- New API endpoints on `/api/v1/emails` and `/api/v1/inbound`: `DELETE /:id` (move to trash), `POST /bulk-delete`, `POST /:id/restore`, `DELETE /:id/permanent`, `GET /trash`, `POST /trash/empty`
- Dashboard: bulk-select and "Move to trash" actions on emails / inbound list pages, dedicated trash views, "Move to trash" button on detail pages
- Richer dashboard home stats: 24h sent / failed, success rate, inbound totals, trash counts, templates and webhooks counts
- `TRASH_RETENTION_DAYS` env var (default `7`)

### Fixed

- Deleting a domain referenced by emails no longer fails — `emails.domain_id` FK now uses `ON DELETE SET NULL`, preserving the email audit log while detaching the domain

### Changed

- Email queue and dashboard stats now exclude trashed rows

## [0.2.1] - 2026-04-17

### Changed

- CI: pinned Bun to `1.3.10` and split unit/e2e test runs into separate processes to sandbox `mock.module()` leaks ([#16](https://github.com/mohamedboukari/bunmail/pull/16))
- Dependencies: bumped `knip` to `6.4.1`, `@types/nodemailer` to `8.0.0`, `softprops/action-gh-release` to `v3`

## [0.2.0] - 2026-03-16

### Added

- DNSBL IP check on inbound SMTP connections (Spamhaus ZEN by default)
- Per-IP connection rate limiting on inbound SMTP (10/min default)
- Recipient domain validation — rejects mail to unregistered domains
- `domainExistsByName()` service method for domain lookups by name
- 6 new env vars for configuring spam protection layers

### Fixed

- SPF record guidance changed from soft fail (`~all`) to hard fail (`-all`) for better deliverability

### Changed

- Open-source community files: SECURITY.md, CODE_OF_CONDUCT.md, CHANGELOG.md, LICENSE, issue/PR templates
- CI: Bun dependency caching, CodeQL scanning, Dependabot, release + Docker GHCR workflows
- README badges for CI, CodeQL, license, Bun, Elysia, Drizzle, Nodemailer, PostgreSQL

## [0.1.0] - 2026-03-16

### Added

- REST API for sending transactional emails (`POST /api/v1/emails/send`)
- Direct SMTP delivery via Nodemailer (no relay provider needed)
- DKIM signing with auto-generated 2048-bit RSA keys per domain
- DNS verification for SPF, DKIM, and DMARC records
- DB-backed email queue with 3 retries and crash recovery
- HMAC-signed webhooks for email lifecycle events (delivered, bounced, failed)
- Email templates with Mustache-style `{{variable}}` substitution
- Inbound SMTP server for receiving and storing incoming emails
- API key authentication (SHA-256 hashed Bearer tokens)
- Sliding-window rate limiting per API key
- Server-rendered dashboard (login, emails, templates, domains, API keys, webhooks)
- Dashboard password auth with HMAC session cookies
- OpenAPI 3.0 auto-generated docs at `/api/docs`
- Health check endpoint (`GET /health`)
- PostgreSQL database with Drizzle ORM
- Docker + Docker Compose for self-hosting
- CI pipeline (typecheck, lint, test) with GitHub Actions
- CodeQL security scanning
- Dependabot for npm + GitHub Actions updates
- 124 tests (unit + E2E)
