# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Consolidate the duplicate `### Added` sections under `[Unreleased]` (cosmetic, keeps Keep-a-Changelog format consistent). (#70)

### Added

- **DMARC `rua` aggregate report ingest.** When BunMail's inbound SMTP receives a DMARC aggregate report (the daily XML attachment that Microsoft / Google / Yahoo / Mail.ru send to the `rua=mailto:` address you publish in `_dmarc`), the new module ([src/modules/dmarc-reports/](src/modules/dmarc-reports/)) detects it via a heuristic on sender + subject + content-type, decompresses the attachment (gzip / zip / raw — sniffed by magic bytes, not filename), parses the RFC 7489 XML via `fast-xml-parser`, and stores the report in two new tables: `dmarc_reports` (one row per report, with `rawXml` kept for forensics) + `dmarc_records` (one row per source IP, FK with `ON DELETE CASCADE`). Re-receipt of the same report is deduped via `UNIQUE (org_email, report_id)` + `ON CONFLICT DO NOTHING`. DMARC-shaped messages **don't pollute** the `inbound_emails` table — they branch off in [smtp-receiver.service.ts](src/modules/inbound/services/smtp-receiver.service.ts) after the bounce branch. Two new REST endpoints — `GET /api/v1/dmarc-reports` (paginated, optional `?domain=`) and `GET /api/v1/dmarc-reports/:id` (with per-source-IP detail) — and matching dashboard pages at `/dashboard/dmarc-reports`. The detail view computes alignment totals and highlights misaligned source IPs in amber so spoofing attempts and unauthorised third-party senders are visually obvious. No webhook event for v1 (consumers can poll); no `ruf` / forensic report support; no backfill. See [docs/dmarc-reports.md](docs/dmarc-reports.md). (#41)
- **Integration test tier against real Postgres + service-level unit tests.** Two-pronged test coverage uplift: (a) New `test/integration/` directory with 40 tests across 5 services (`suppression`, `email-create`, `queue-recover`, `domain`, `webhook-dispatch`) running against a dedicated `bunmail_test` database. `test/integration/_preload.ts` overrides `DATABASE_URL` before any service module loads; each test wraps in `beforeEach(truncateAll)` for isolation. Catches `ON DELETE CASCADE` / `SET NULL` behaviour, `ON CONFLICT DO UPDATE` upserts, encryption round-trips, schema drift between TS models and the live DB. (b) New unit tests for every previously-uncovered service (`mailer`, `dns-verification`, `template`, `webhook`, `webhook-dispatch`, `api-key`, `domain`) using mocked dependencies — covers the orchestration code paths even without a DB. Plus 20 JSX render-smoke tests for every dashboard page + presentational component. **Overall coverage uplift: 61.7% → 89.8% functions, 66.1% → 93.0% lines**. `bunfig.toml` threshold raised to `function: 0.85, line: 0.9` so future PRs can't regress. CI provisions a `postgres:16` service container and runs all three tiers on every PR. New scripts: `test:unit`, `test:e2e`, `test:integration`, `test:integration:setup`, `test:all`, `test:coverage`. See [docs/testing.md](docs/testing.md). (#70)

### Added

- **Auto-suppress on inline SMTP 5xx rejections.** When a recipient's MX rejects an outbound send during the SMTP transaction with a `550 5.1.1` (the way Gmail / Outlook / Yahoo handle obviously-bad addresses today), the queue's failure path now classifies the error via [src/utils/smtp-error.ts](src/utils/smtp-error.ts), calls `suppressionService.addFromBounce()` to permanently suppress the recipient, marks the email `status = 'bounced'`, fires the `email.bounced` webhook with `source: "inline"`, and **stops retrying**. Previously the queue would retry three times, hitting the same MX with the same `5.1.1` each cycle — exactly the pattern that tanks IP reputation. Soft 4xx and infrastructure errors keep the existing retry-up-to-`MAX_ATTEMPTS` behaviour. Webhook payload shape matches the async-DSN bounce path from #24 — receivers get a uniform `email.bounced` signal regardless of which path fired. Closes the auto-suppression loop for hard bounces that #24 left open. (#68)
- **DSN / bounce parsing.** When BunMail's inbound SMTP receives a Delivery Status Notification, the new bounce module ([src/modules/bounces/](src/modules/bounces/)) parses it (RFC 3464 first, with a heuristic-gated regex fallback for non-RFC bounces from old MTAs), links it back to the original outbound email by `Original-Message-ID`, persists a per-API-key suppression via `suppressionService.addFromBounce()`, marks the original email row's `status` as `bounced`, and fires the `email.bounced` webhook. Hard bounces (5.x.x) become permanent suppressions; soft bounces (4.x.x) become 24-hour time-windowed suppressions and **escalate to permanent on a second soft bounce within the window** — repeated transient failures are effectively permanent for IP-reputation purposes. DSNs without an `Original-Message-ID` are dropped with a warning rather than risk suppressing under the wrong tenant. Bounce-shaped messages are routed via the new branch in [smtp-receiver.service.ts](src/modules/inbound/services/smtp-receiver.service.ts) and **don't pollute** the `inbound_emails` table. See [docs/bounces.md](docs/bounces.md). (#24)
- **Suppression list.** New `suppressions` table + `/api/v1/suppressions` CRUD endpoints (`POST`, `GET`, `GET /:id`, `DELETE /:id`). The list is **per-API-key** (different keys often represent different customer environments — one's bounces shouldn't gate another's sends). `POST /api/v1/emails/send` now runs a gate against the calling key's suppression list before any other work; suppressed recipients return HTTP 422 with `code: "RECIPIENT_SUPPRESSED"` and `suppressionId` so clients can pivot directly to `DELETE /api/v1/suppressions/:id`. The gate normalises addresses (case-fold, trim) so `Alice@Example.com` and `alice@example.com` resolve to the same row. Auto-suppression on bounces is wired by #24. See [docs/suppressions.md](docs/suppressions.md). (#25)

### Changed

- `EmailStatus` now includes `bounced`, surfaced via the `?status=bounced` filter on `GET /api/v1/emails`. The semantics: `sent` = the recipient's MX accepted the SMTP transaction; `bounced` = it accepted, then later returned a DSN; `failed` = we never reached an MX. (#24)

### Security

- **Breaking — DKIM private keys are now encrypted at rest.** Every `domains.dkim_private_key` is encrypted with AES-256-GCM using a new required `DKIM_ENCRYPTION_KEY` env var (32 bytes, base64). Stored as `v1:<iv>:<ciphertext>:<auth-tag>`. A DB dump without the env key leaks no signing material. Operators must add `DKIM_ENCRYPTION_KEY=$(openssl rand -base64 32)` to `.env` **before** pulling this version — boot fails loudly if it's missing or not 32 bytes. Existing rows are auto-encrypted on first boot via [src/db/encrypt-domain-keys.ts](src/db/encrypt-domain-keys.ts) (idempotent — already-encrypted rows are skipped on subsequent restarts). Rotation is documented in `SECURITY.md`. Decrypt failure at send time is fail-open (logs an error and sends unsigned) so a key-rotation accident can't take down outbound delivery. (#23)

### Fixed

- Email queue now resolves DKIM keys + `List-Unsubscribe` overrides via the email's `domainId` FK rather than parsing the sender domain out of `fromAddress`. The string-parse path was a correctness hazard for renamed domains and inconsistent with the schema's stamped FK. Falls back to a name-based lookup only when `domainId` is null (legacy rows from before the FK existed). Adds a unit test covering both paths. (#32)

### Changed

- **Runtime image no longer ships `drizzle-kit`.** Replaced `drizzle-kit migrate` at container start with a 60-line Bun-native runner (`src/db/migrate.ts`) that reads the committed `drizzle/<n>_*.sql` files and tracks applied tags in a new `__bunmail_migrations` table. Eliminates esbuild's bundled Go binary from the production image, closing ~36 Go-stdlib false-positive findings on Trivy's image scan. Existing `db:push`-provisioned databases are auto-baselined on first run (every known migration is recorded as applied without re-running its DDL). The Dockerfile is now multi-stage (install → prod-deps → run) so dev deps never reach the final layer; the run stage also applies the latest Debian security patches at build time. Migrations are now committed to `drizzle/` and removed from `.gitignore`. (#56)

### Security

- Bumped transitive deps via `package.json` `overrides` to close real medium-severity npm CVEs surfaced by the new image scan: `yaml@^2.8.4`, `file-type@^22.0.1`, `brace-expansion@^5.0.5`, `picomatch@^4.0.4`. `file-type` was promoted from a peer to a direct dep so the override applies. (#56)

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
