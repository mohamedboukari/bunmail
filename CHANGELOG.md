# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-05-03

> **Theme: security & deliverability hardening.** Webhook signatures now bind to a per-attempt timestamp (breaking — see migration note below). Outbound mail carries `List-Unsubscribe` headers. Production refuses to boot with an empty dashboard password. PII in logs is redacted by default. CI gains Trivy fs+image scans, gitleaks, and SHA-pinned actions. A documented threat model. Plus a long backlog of internal hygiene improvements.
>
> **Breaking change — webhook signature format.** If you have a webhook consumer, update verification before pulling 0.4.0. The signature now covers `<unix-timestamp>.<raw-body>`, the timestamp ships in `X-BunMail-Timestamp`, and consumers should also reject deliveries whose timestamp drifts > 5 minutes. Full Node.js + Python examples in [docs/webhooks.md](docs/webhooks.md#signature-verification).

### Added

- `List-Unsubscribe` (and optionally `List-Unsubscribe-Post: List-Unsubscribe=One-Click`) on every outbound message, addressing Gmail and Yahoo's Feb-2024 sender requirements. Per-domain overrides (`unsubscribeEmail`, `unsubscribeUrl`) accepted at `POST /api/v1/domains` and surfaced in the response. Defaults to `unsubscribe@<from-domain>` when no override is set. See [docs/emails.md](docs/emails.md#list-unsubscribe) for the resolution rules. (#40)
- Cap on outbound email body size — `html` and `text` fields are now limited to 5 MB each via DTO validation; oversize payloads return `422`. (#26)
- Periodic cleanup for the in-memory HTTP rate-limit map; expired entries are pruned every 5 minutes so the map can't grow unbounded under high cardinality. (#22)
- Opportunistic STARTTLS on outbound delivery — every recipient MX that advertises STARTTLS is now upgraded to TLS. Documented in `SECURITY.md`. (#21)
- Webhook event union now includes `email.received` (fired by the inbound SMTP path) and `email.complained` (reserved for FBL processing). (#31)

### Fixed

- The inbound SMTP receiver no longer casts `"email.received"` to `"email.queued"` to silence the type checker — the event name is properly typed and accepted by the webhook DTO. (#31)

### Security

- **Breaking — webhook signature format.** Replay protection: the signature is now computed over `<unix-timestamp>.<raw-body>` instead of the body alone, and a new `X-BunMail-Timestamp` header carries the timestamp. Consumers must update verification to recompute HMAC over `timestamp.body` and additionally check the timestamp is fresh (recommended ±5 minutes). Each retry attempt is signed with its own fresh timestamp, so a long retry chain doesn't ship a stale signature. Node.js + Python verification examples added to `docs/webhooks.md`, including the freshness check. (#43)
- Recipient and sender email addresses in log records are now redacted (e.g. `a***@example.com`) when `LOG_REDACT_PII=true`. Defaults to `true` in production and `false` in development so dev logs stay debuggable. Webhook payloads still carry full addresses — consumers depend on them; only logs are masked. (#33)
- BunMail refuses to start in production with an empty `DASHBOARD_PASSWORD`. The dashboard mounts unscoped read/write routes across all API keys, so a deployment with `BUNMAIL_ENV=production` and no password is rejected with a clear error at config load. Development behaviour is unchanged (empty password disables the dashboard). (#19)
- Inbound SMTP open-relay hardening: messages capped at 10 MB (advertised via the SIZE ESMTP extension and enforced inside the data stream), recipients capped at 50 per transaction (SMTP 452), and `MAIL FROM` validated for envelope shape (SMTP 553) — empty sender preserved for DSN bounces. (#18)
- Added `THREAT_MODEL.md` documenting assets, attackers, in-code controls, residual risks, and operator responsibilities (firewall, disk encryption, reverse-proxy TLS, IP-reputation monitoring). Linked from `README.md` and `SECURITY.md`. (#38)
- New `Security` workflow on every push / PR / weekly schedule with three jobs: Trivy filesystem scan (deps + Dockerfile), Trivy image scan (built image with base-OS CVEs), and gitleaks secret detection. All fail on findings; results upload to the Security tab as SARIF. (#54)
- `bun pm untrusted` in CI is now a hard failure (was non-blocking via `|| true`) so a new untrusted lifecycle script surfaces at PR time. (#54)
- All third-party GitHub Actions across `ci.yml`, `codeql.yml`, `docker.yml`, `release.yml`, and the new `security.yml` are now pinned to a commit SHA (with a trailing `# vX` comment) to defend against tag-hijack supply-chain attacks. Dependabot's `github-actions` ecosystem keeps the SHAs current; bumps are grouped into one PR per week. (#54)
- `bun.lock` is committed (was gitignored) so the Trivy filesystem scan can resolve transitive deps; the legacy `bun.lockb` binary format remains ignored. (#54)
- New `docs/security-ci.md` walks the five CI security layers, how to triage each kind of failure, and how to add jobs to branch-protection required checks. (#54)

### Changed

- `LOG_LEVEL` is now validated at config load — invalid values fail loudly with a clear error instead of silently behaving like the default. (#39)
- Removed every `as typeof context & { apiKeyId: string }` cast across the email, template, webhook, and inbound plugins. Elysia's type inference flows `apiKeyId` correctly through `.use(authMiddleware).resolve(...).as("scoped")`; the casts were defensive cargo from earlier Elysia versions. The `rate-limit` middleware's standalone-plugin cast is tightened to `{ apiKeyId?: string }` (was `Record<string, unknown>`) — express the exact shape we read. (#36)
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
