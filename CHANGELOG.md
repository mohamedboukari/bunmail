# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
