# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.1] - 2026-05-29

> **Theme: dashboard timestamps in viewer machine time.** Every server-rendered timestamp on the dashboard now formats in the viewer's browser locale + timezone instead of the server's (UTC in Docker), with relative phrasing for recent activity. No schema changes, no API changes — pull, restart, reload.

### Changed

- **Dashboard timestamps now render in the viewer's machine time** with relative phrasing (#104). Every server-rendered date was previously formatted in the server's timezone (UTC in Docker) and locale (`en-US`), and many places dropped the time entirely (`toLocaleDateString()`). A shared `<TimeDisplay>` component now emits a semantic `<time datetime>` tag; one hydration script in `BaseLayout` rewrites every such element on load to relative time (`5m ago`, `Yesterday 14:32`, `Jan 5, 14:32`) using `Intl.DateTimeFormat` in the browser's locale + timezone. The `title` tooltip carries the full absolute timestamp with timezone. The dashboard never shows a bare date anymore — every rendered value carries date and time together.

## [0.6.0] - 2026-05-25

> **Theme: multi-MX delivery + dashboard polish.** Cross-domain CC/BCC actually works now. The mailer parses recipients, groups by destination MX, and opens one SMTP session per group (with envelope override) so each receiver sees RCPT TO for only its own addresses — same DKIM-signed body, same canonical `Message-ID:` across all groups. Mixed-outcome rows retry only the groups that need it via a new per-group `delivery_state` JSONB column on `emails`, with no duplicate sends to groups that already succeeded. The outbound queue gains a per-MX semaphore (#91) so strict receivers stop 421-ing parallel sessions. Inbound SMTP is now loudly opt-in (#93) instead of silently disabled. The dashboard ships three new pieces: Gmail-style chip input for CC/BCC (#85), reply on inbound emails (#86), and an admin-scoped suppressions list with an explicit "Sending as" key picker (#89). Docker-compose port mappings are now `.env`-driven (#92).
>
> **Schema migration:** adds `emails.delivery_state JSONB NULL` (#97). Legacy rows stay null and use the original single-shot path. Run `bun run db:migrate` (or rebuild via `docker compose up -d --build`, which runs migrations automatically) before deploying.

### Changed

- **Full timestamp in emails list.** The "Created" column now shows `YYYY-MM-DD HH:MM:SS` instead of date-only, so operators can see exactly when each email was queued. Closes #84.

### Added

- **Reply to inbound emails from the dashboard (#86).** Inbound email detail pages now have a Reply button that links to `GET /dashboard/inbound/:id/reply`, a new route that pre-fills the compose form: `from` = the inbound's `toAddress` (keeps SPF/DKIM/DMARC alignment), `to` = original sender, `subject` = `Re: ` + original (no double-prefix when already-`Re:`), HTML body = original wrapped in a `<blockquote>` with `On <date>, <sender> wrote:` attribution, plain text body = original quoted with `> ` line prefixes. `SendEmailPage` gains an optional `prefill` prop used by the new route; existing send POST handler is unchanged. Proper RFC 5322 threading headers (`In-Reply-To`, `References`) are deferred to a Phase 2 follow-up. Closes #86.
- **Suppressions dashboard + explicit "Sending as" key picker (#89).** Two interlocking footguns: (a) dashboard sends silently picked the first active API key, so auto-suppressions ended up filed under a key the operator wasn't using; (b) there was no dashboard surface to inspect or delete suppressions across keys, so recovering from a stuck auto-suppression meant direct SQL. Both fixed in this PR. New **`/dashboard/suppressions`** page (admin-scoped, lists across every API key) with email-substring + api-key filters and per-row delete buttons. Each row shows the owning key's name beside the recipient, the bounce type (hard/soft pill), source email id (linked to the email detail page when present), and expiry. Two new unscoped service methods back it (`listAllSuppressions`, `deleteSuppressionByIdUnscoped`) matching the unscoped pattern used by emails/domains/etc. **`/dashboard/send`** gains a "Sending as" dropdown of active keys (default-first-active matches pre-#89 behaviour but is now visible and overridable); the POST handler validates the chosen key is still active rather than silently falling back. New Suppressions icon in the sidebar nav. 6 new integration tests cover the cross-key delete flow and ILIKE substring matching. Closes #89.
- **Gmail-style chip input for CC / BCC on the dashboard (#85).** The Send Email form's CC and BCC fields used to be `type="email"` inputs that browser-rejected anything containing a comma — operators couldn't add multiple recipients through the UI even though the backend already accepted comma-separated values. Replaced with a chip / tag input: type an address and press comma, space, Enter, or Tab to commit it as a removable chip. Backspace on an empty input pops the last chip back into the text field (matches Gmail's affordance for fixing typos). Pasting a comma- or whitespace-separated list splits and validates each address in one go. The component (`src/pages/components/email-chip-input.tsx`) renders markup + a single shared script block that binds all `[data-chip-input]` widgets on the page, so CC and BCC reuse the same wiring. Hidden inputs preserve the existing `name="cc"` / `name="bcc"` contract, so no backend changes were needed. Works correctly with the multi-MX delivery from #87 — chips can span domains and all recipients actually receive the email. Closes #85.
- **Bounced status filter in dashboard.** The emails list page now shows a "Bounced" filter tab alongside All / Queued / Sending / Sent / Failed. The `StatusBadge` component renders bounced emails with an orange pill. Closes #83.

### Fixed

- **Multi-domain CC/BCC delivery — Phase 2: per-group retry without duplicates (#97).** Phase 1 (#87) made cross-domain CC/BCC actually deliver, but mixed-outcome rows (Gmail accepts, Outlook 4xx-retries) were marked `sent` and never retried — retrying would have re-sent to Gmail and produced duplicate emails. This release adds the schema + queue plumbing to retry only the groups that need it. **Schema**: new `emails.delivery_state` JSONB column (nullable; legacy rows pre-migration stay null). **Mailer**: `sendMail` now accepts `existingState` and skips every group already in `sent` status — the mailer-level unit tests pin this contract with 22 cases (skip-on-retry, hard-5xx terminal, soft-4xx retryable, DNS-failure synthetic-key handling, all-sent no-op pass). **Queue**: aggregates the returned state into row-level status (any `retry` + attempts < cap → row queued; else terminal status from `sent` / `bounced` / `failed`). Per-recipient `email.bounced` webhooks fire only for groups that transitioned to `failed` via hard 5xx **this attempt** (state diff vs prior); `email.sent` fires once at the first attempt that lands any group, no duplicates across retries. **Identity**: canonical `Message-ID:` is generated by the queue on first attempt, persisted on the row, and reused on retries so bounce / complaint feedback joins on a stable id. Legacy single-MX `handleSendFailure` path removed — per-group state subsumes it. Closes #97.
- **Multi-domain CC/BCC delivery — Phase 1 (#87).** Outbound sends used to resolve the MX once (for `to`) and submit the message there; any CC/BCC recipients on different domains were sent to the wrong MX and silently dropped. The mailer now parses `to/cc/bcc` into a flat recipient list, groups by destination MX, and opens **one SMTP session per MX** with `envelope.to` overridden to that group's recipients — same DKIM-signed message body, same canonical `Message-ID:` across all groups, but each MX only sees RCPT TO for its own addresses. The `To:` / `Cc:` headers carry the full original list so cross-domain CC is visible to every recipient. New utility `src/utils/recipients.ts` (parse + group-by-MX) with 15 unit tests; mailer test suite extended with 9 multi-MX cases (envelope splitting, BCC-in-envelope-only, partial-failure surfacing, full-failure rethrow, DNS resolution failure as partial). `createEmail`'s suppression gate now covers CC/BCC, not just `to` — previously suppressed CC/BCC addresses were dropped by accident; with multi-MX delivery they'd actually receive mail without the extended check. When some MX groups succeed and others fail, the email row is marked `sent` with a partial-failure summary in `lastError`, and per-recipient `email.bounced` webhooks fire for the failed groups' inline 5xx rejections (carrying a new `recipient` field alongside the existing `to`). Phase 1 does **not** retry mixed-outcome rows (would re-send to already-delivered groups); per-group retry state is the Phase 2 follow-up tracked in #97. Closes #87.
- **Per-MX outbound connection throttling.** The queue used to open up to 5 concurrent SMTP sessions per poll cycle with no consideration of destination MX, so a batch of recipients on the same provider (Outlook, Yahoo) would hit the same receiving server in parallel and get rejected with `421 Too many concurrent SMTP connections` — burning IP-reputation budget on a self-inflicted issue. A new module-level semaphore (`src/utils/mx-throttle.ts`) serializes SMTP sessions per destination MX. Default concurrency is `1` (configurable via `MAIL_MX_CONCURRENCY`, recommended max `3`). The semaphore holds across poll cycles, so back-to-back batches that share a destination still serialize. Sends to different MXs are unaffected and continue in parallel. Closes #91.
- **Inbound SMTP receiver is now loudly opt-in.** Previously `SMTP_ENABLED=false` (the default) silently disabled the receiver while `docker-compose.yml` still bound host port 25 — operators following the README ended up with MX records pointing at a port nothing was listening on, with no log line to explain why. The inbound port line in `docker-compose.yml` is now commented out by default with the enable instructions inline, and the app logs `Inbound SMTP receiver disabled — set SMTP_ENABLED=true …` at startup whenever inbound is off. `.env.example` and `docs/inbound.md` carry a first-boot checklist that calls out the three knobs (env, compose, DNS) that have to agree. Closes #93.
- **Docker port mappings now read from `.env`.** `PORT` and `SMTP_PORT` in `docker-compose.yml` are parameterised (`${PORT:-3000}`, `${SMTP_PORT:-25}`) so operators no longer need to edit two files when changing ports. Closes #92.

- **Trivy image scan failing on stale OS packages.** The `apt-get upgrade` layer in the Dockerfile was cached by GHA Docker layer caching, so Debian security patches (e.g. `libcap2`, `libsystemd0`) released after the last uncached build were never picked up. Added an `ARG APT_CACHE_BUST` set to `github.run_id` so every CI run builds a fresh apt layer. Install + prod-deps stages remain cached.

## [0.5.0] - 2026-05-10

> **Theme: deliverability + reliability + observability.** Bounce handling becomes end-to-end — DSN parsing (#24), per-API-key suppression list (#25), and auto-suppress on inline SMTP 5xx (#68) close the "stop sending to dead recipients" loop that protects IP reputation. DMARC aggregate reports are parsed and surfaced in the dashboard (#41). Webhook delivery becomes durable with persistence + replay (#30) so consumer outages can't drop events. Email tombstones (#34) preserve audit trails past trash purge so late complaints / bounces can be traced. The queue's race condition under concurrent workers is fixed (#20) — multi-replica deploys are now safe. DKIM private keys are encrypted at rest (#23). A new integration test tier (#70) lifted overall coverage from 62% to 90%+.
>
> **Breaking change — DKIM encryption.** Operators upgrading from 0.4.0 must set `DKIM_ENCRYPTION_KEY=$(openssl rand -base64 32)` in `.env` *before* pulling this version. Boot fails loudly otherwise. Existing rows are auto-encrypted on first boot. See #23 / `SECURITY.md` for rotation.

### Changed

- Consolidate the duplicate `### Added` sections under `[Unreleased]` (cosmetic, keeps Keep-a-Changelog format consistent). (#70)

### Added

- **Email tombstones — post-purge audit trail (#34).** Hard-deleted emails (whether by the periodic trash purge sweep, the per-row `permanent` API, or the bulk `empty trash`) now leave behind a forensic snapshot in a new `email_tombstones` table — `id` (matches the original `msg_…`), `apiKeyId`, `messageId`, `fromAddress`, `toAddress`, `subject`, `status`, `sentAt`, `deletedAt`, `purgedAt`. **Body / html / text are deliberately not preserved** — the whole point is to drop sensitive payload past the trash retention window while keeping enough identifiers to answer "did we send the message that just bounced / generated this complaint?" weeks later. All five hard-delete code paths in the codebase route through one `deleteEmailsWithTombstones` helper that wraps the snapshot INSERT + the DELETE in a single transaction. Tombstones have **no foreign keys** — they survive the api_key being revoked + cascade-deleted, which is exactly the audit-trail use case. Tombstones themselves are aged out by a new sweep on the existing 6h trash purge cadence, default `TOMBSTONE_RETENTION_DAYS=90`. New REST endpoints `GET /api/v1/emails/tombstones?messageId=` (paginated, with-and-without angle-bracket-wrap matching) and `GET /api/v1/emails/tombstones/:id`. Matching dashboard at `/dashboard/emails/tombstones` with a Message-ID search box. Outbound only — inbound tombstones are out of scope. (#34)
- **Persisted webhook delivery queue with replay (#30).** The webhook dispatcher used to retry in-memory (3 attempts: 1s/2s/4s) — a server restart mid-retry would silently drop the event and a consumer outage longer than ~7s would burn through every retry before recovery. The retry loop is now durable: every dispatch INSERTs a row into the new `webhook_deliveries` table at `status='pending'`, and a worker poll loop ([`webhook-delivery-worker.service.ts`](src/modules/webhooks/services/webhook-delivery-worker.service.ts), 5s tick) atomically claims due rows via `FOR UPDATE SKIP LOCKED` (same pattern as #20 — concurrency-safe from day 1), POSTs each one with a freshly-signed timestamp, and updates the row to `delivered` on 2xx, reschedules on failure per the new schedule (**1m / 5m / 15m / 1h / 6h** = 5 attempts over ~7h), or terminates at `failed` after the cap. Three new endpoints surface the queue: `GET /api/v1/webhooks/:id/deliveries` (paginated, optional `?status=pending|delivered|failed`), `GET /api/v1/webhooks/deliveries/:deliveryId` (full attempt detail with body bytes for signature debugging), and `POST /api/v1/webhooks/deliveries/:deliveryId/replay` (resets a row to `pending` so the worker re-tries it). Matching dashboard pages at `/dashboard/webhooks/:id/deliveries` and `/dashboard/webhooks/deliveries/:deliveryId` with a Replay button. New `WEBHOOK_DELIVERY_RETENTION_DAYS` env var (default 30) controls when delivered rows are reaped by an hourly cleanup task; failed rows are kept indefinitely for forensics. CASCADE on `webhooks` delete reaps deliveries automatically. See [docs/webhooks.md](docs/webhooks.md). (#30)

### Tests

- **SMTP receiver + queue concurrency coverage.** Backfill of the gating-now-shipped acceptance criteria from #35: 15 unit tests in [test/unit/inbound-malformed-input.test.ts](test/unit/inbound-malformed-input.test.ts) feeding adversarial inputs (binary garbage, truncated MIME, control characters, BOM, conflicting headers, 500KB single-line input) through `parseBounce` and `simpleParser` to lock down "malformed RFC 822 doesn't crash the receiver"; 4 integration tests in [test/integration/inbound-bounce-flow.integration.test.ts](test/integration/inbound-bounce-flow.integration.test.ts) exercising the full DSN end-to-end chain (`parseBounce → handleParsedBounce`) against real Postgres + a captured `fetch` mock — covers hard-bounce → suppression row + email row marked bounced + signed `email.bounced` webhook payload, the soft-bounce time-windowed variant, the soft → hard escalation rule from #24, and the dropped-no-original safety case. Concurrent-workers exactly-once was already covered by [test/integration/queue-claim.integration.test.ts](test/integration/queue-claim.integration.test.ts) from #20. The 50MB-stream-rejection bullet remains partial: the protocol-level cap is enforced by the smtp-server library's SIZE extension (advertised via `new SMTPServer({ size: MAX_MESSAGE_BYTES })`); the in-handler chunk guard is belt-and-suspenders that would require a real SMTPServer boot or a closure-extraction refactor to test cleanly — deferred. (#35)

### Fixed

- **Queue race condition under concurrent workers.** The poll loop's `queued → sending` transition was a `SELECT` followed by a separate per-row `UPDATE` (`queue.service.ts`), so two workers running it at the same time could pick up the same rows and double-send the same email. The transition is now a single atomic statement: `UPDATE emails SET status='sending', attempts = attempts + 1 WHERE id IN (SELECT id … FOR UPDATE SKIP LOCKED) RETURNING *`. `FOR UPDATE SKIP LOCKED` makes a concurrent caller skip rows another transaction has locked rather than waiting on them or grabbing duplicates, so two workers always see disjoint result sets. We're single-worker today so this wasn't manifesting in production, but it was the blocker for horizontal scaling — running a second BunMail instance behind a load balancer is now safe. New integration test ([test/integration/queue-claim.integration.test.ts](test/integration/queue-claim.integration.test.ts)) seeds 30 queued rows, fires 6 concurrent claim calls, asserts each row is claimed by exactly one caller. (#20)

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
