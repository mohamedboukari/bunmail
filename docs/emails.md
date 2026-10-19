# Emails Module

Handles email queuing, delivery, and retrieval. Emails are queued via the REST API and delivered asynchronously using Nodemailer's direct SMTP mode with DKIM signing.

## Schema

**Table:** `emails`

| Column          | Type           | Constraints             | Description                                 |
|-----------------|----------------|-------------------------|---------------------------------------------|
| `id`            | varchar(36)    | PK                      | Prefixed ID (`msg_<24 hex>`)                |
| `api_key_id`    | varchar(36)    | NOT NULL, FK → api_keys | Which API key queued this email              |
| `domain_id`     | varchar(36)    | nullable, FK → domains  | Sender domain (auto-linked for DKIM signing) |
| `from_address`  | varchar(255)   | NOT NULL                | Sender email address                        |
| `to_address`    | varchar(255)   | NOT NULL                | Recipient email address                     |
| `cc`            | text           | nullable                | Comma-separated CC recipients               |
| `bcc`           | text           | nullable                | Comma-separated BCC recipients              |
| `reply_to`      | text           | nullable                | Comma-separated Reply-To address(es) (#169). Sets the `Reply-To:` header on every MX group's message; the envelope sender is unaffected (`from_address`, or its signed return path with inbound SMTP on, #236). |
| `headers`       | jsonb          | nullable                | Custom headers set on the send (#177), name to value, stored as a jsonb object. Null when none. See [Custom Headers](#custom-headers). |
| `subject`       | varchar(500)   | NOT NULL                | Email subject line                          |
| `html`          | text           | nullable                | HTML body                                   |
| `text_content`  | text           | nullable                | Plain text body                             |
| `status`        | varchar(20)    | NOT NULL, default queued | `queued` → `sending` → `sent` / `failed`. `sent` rows can later transition to `bounced` when a DSN comes back (#24). |
| `source`        | varchar(10)    | NOT NULL, default `api` | Ingress channel: `api` (REST `POST /api/v1/emails/send`) or `smtp` (SMTP submission server, #120). Existing rows backfill to `api` (#137). |
| `attempts`      | integer        | NOT NULL, default 0     | Number of delivery attempts                 |
| `next_attempt_at` | timestamptz  | NOT NULL, default now   | Earliest time the queue may try the email; pushed out by the retry backoff (#180) |
| `locked_by`     | varchar(64)    | nullable                | Worker holding the row while `sending` (#180) |
| `lease_until`   | timestamptz    | nullable                | Claim expiry while `sending`; renewed by the worker, reclaimable once passed (#180) |
| `last_error`    | text           | nullable                | Error message from last failed attempt      |
| `message_id`    | varchar(255)   | nullable                | SMTP message ID (set after successful send) |
| `sent_at`       | timestamp      | nullable                | When the email was successfully delivered   |
| `created_at`    | timestamp      | NOT NULL, default now   | When the email was queued                   |
| `updated_at`    | timestamp      | NOT NULL, default now   | Last modification timestamp                 |
| `deleted_at`    | timestamp      | nullable                | Soft-delete marker, when set, the email is in trash and excluded from normal lists. Auto-purged after `TRASH_RETENTION_DAYS`. |

**Foreign keys:**

- `domain_id → domains.id`: `ON DELETE SET NULL`. Deleting a domain detaches its emails instead of blocking, preserving the email history while removing the domain.

**Indexes:**

- `idx_emails_status_created` (`(status, created_at)`) queue processor uses this
- `idx_emails_api_key_id`, `(api_key_id)`, fast filtering by API key
- `idx_emails_api_key_deleted` (`(api_key_id, deleted_at)`) trash list / purge queries
- `idx_emails_due_per_key` (`(api_key_id, next_attempt_at, created_at)` WHERE `status = 'queued' AND deleted_at IS NULL`) fair queue claim of each key's due rows (#258, replaces `idx_emails_due` of #180)
- `idx_emails_lease` (`(lease_until)` WHERE `status = 'sending'`) reclaim of expired leases (#180)
- `idx_emails_message_id` (`(message_id)`) Message-ID lookups: linking an inbound reply to the email it answers (#192), and the bounce and complaint joins

**Table:** `idempotency_keys` (#188)

One row per (API key, `Idempotency-Key`) used on `POST /api/v1/emails/send` within `IDEMPOTENCY_KEY_TTL_HOURS`. See [Idempotency Keys](#idempotency-keys).

| Column            | Type         | Constraints                          | Description |
|-------------------|--------------|--------------------------------------|-------------|
| `id`              | varchar(36)  | PK                                   | Prefixed ID (`idk_<24 hex>`) |
| `api_key_id`      | varchar(36)  | NOT NULL, FK → api_keys (CASCADE)    | The key the idempotency key belongs to |
| `key`             | text         | NOT NULL                             | The `Idempotency-Key` header value (1 to 255 printable ASCII characters) |
| `request_hash`    | text         | NOT NULL                             | SHA-256 hex of the canonical JSON of the validated body (object keys sorted) |
| `email_id`        | varchar(36)  | nullable, FK → emails (SET NULL)     | The email the first request created; null once that email is purged |
| `response_status` | integer      | nullable                             | HTTP status of the first response (null only inside the creating transaction) |
| `response_body`   | jsonb        | nullable                             | Body of the first response without message content (no `subject`, `html`, `text`, `headers`); null only inside the creating transaction |
| `created_at`      | timestamptz  | NOT NULL, default now                | First use of the key |
| `expires_at`      | timestamptz  | NOT NULL                             | `created_at` plus the TTL; the key is reusable after it |

Indexes: `idempotency_keys_api_key_key_unique` (unique `(api_key_id, key)`, the claim target), `idempotency_keys_expires_at_idx` (the purge), `idempotency_keys_email_id_idx` (backs the `email_id` foreign key on email deletes).

## Module Layout

```
src/modules/emails/
├── emails.plugin.ts                ← Routes: send, list, get, trash/restore/permanent/empty
├── errors.ts                       ← Typed send rejections, each with HTTP status + code (#245, #177)
├── models/
│   ├── email.schema.ts             ← Drizzle pgTable + indexes
│   └── idempotency-key.schema.ts   ← Idempotency keys of the send API (#188)
├── dtos/
│   ├── send-email.dto.ts           ← Send email validation (direct + template), Idempotency-Key header
│   └── list-emails.dto.ts          ← List query param validation
├── services/
│   ├── email.service.ts            ← CRUD + trash/restore + template resolution + domain linking
│   ├── idempotency.service.ts      ← Idempotency keys: request hash, claim, complete, expiry purge (#188)
│   ├── sender-domain.service.ts    ← Sender-domain gate, warnings, REQUIRE_VERIFIED_DOMAIN re-check (#245)
│   ├── custom-headers.ts           ← Pure custom-header rules shared by REST, SMTP submission and the mailer (#177)
│   ├── mailer.service.ts           ← Nodemailer direct SMTP + DKIM signing
│   ├── mx-route.ts                 ← MX resolution per recipient domain, implicit MX, failover across hosts (#250)
│   ├── mx-address.ts               ← Checked addresses of an MX host: refuses private and special ones
│   ├── mx-transport.ts             ← One MX session: pooled transport, owned socket, deadline, STARTTLS recorder (#250)
│   ├── mta-sts.ts                  ← Outbound MTA-STS: TXT and policy parsing, pinned policy fetch, per-domain cache (#250)
│   ├── list-unsubscribe.ts         ← Per-email List-Unsubscribe: one-click token or static domain settings (#249)
│   ├── queue.service.ts            ← Async queue processor with retries + webhook dispatch
│   ├── stats.service.ts            ← Dashboard stats aggregation
│   └── delivery-rates.ts           ← Pure success and bounce rate math (#250)
├── serializations/
│   ├── email.serialization.ts      ← Response mapper (hides apiKeyId, domainId)
│   └── delivery-state.serialization.ts ← Public per-MX delivery state, also used by the detail page (#250)
└── types/
    └── email.types.ts               ← Email, SendEmailInput, ListEmailsFilters, SendWarning, CreatedEmail, IdempotentSendResult
```

## Sending Modes

### Direct content

Provide `subject`, `html`, and/or `text` inline:

```json
{
  "from": "hello@example.com",
  "to": "user@example.com",
  "subject": "Hello!",
  "html": "<h1>Hello</h1>"
}
```

### Template-based

Provide `templateId` and `variables`: subject/body are rendered from the template:

```json
{
  "from": "hello@example.com",
  "to": "user@example.com",
  "templateId": "tpl_abc123...",
  "variables": { "name": "Alice" }
}
```

## Domain Linking

When an email is created, the sender's domain (from `from` address) is looked up in the `domains` table (`checkSenderDomain` in `sender-domain.service.ts`, #245):

- If found, `domain_id` is set and DKIM signing uses the domain's private key
- In **production** mode (`BUNMAIL_ENV=production`), the domain must be registered or the send is rejected with `422 SENDER_DOMAIN_NOT_REGISTERED` (SMTP `550`)
- In **development** mode, unregistered domains are allowed (`domain_id` stays null) with the warning `domain_unregistered`

**Warnings.** For a registered domain, each stored verification flag that is false adds a warning: `dkim_unverified`, `spf_unverified`, `dmarc_unverified` (in that order; `[]` when all are verified). The flags are a snapshot from the last **Verify** run (see #250). `POST /api/v1/emails/send` returns them as a top-level `warnings` array next to `data`, the dashboard send flash names them in plain words, and every send with warnings logs `Email queued from a sender domain with unverified DNS records` at `warn` (`id`, `apiKeyId`, `source`, `domain`, `warnings`): the only trace for SMTP submission, which has no channel for them. The email is queued either way.

**`REQUIRE_VERIFIED_DOMAIN=true`** (default `false`) makes DKIM a requirement:

- A registered domain whose stored `dkim_verified` is false is re-verified inline with `verifyDomain` (which stores the new SPF/DKIM/DMARC flags). If DKIM now passes, the send goes ahead with warnings from the fresh flags.
- If it still fails, or the check throws, the send is rejected with `422 SENDER_DOMAIN_UNVERIFIED` (SMTP `550`), and the failure is remembered in process for 5 minutes per domain (`UNVERIFIED_RECHECK_MS`): sends in that window are refused without another DNS lookup, and concurrent sends share one lookup. The stored flag is read first, so running **Verify** after fixing the record takes effect at once. Each replica keeps its own memory.
- An unregistered domain is rejected in every environment.
- SPF and DMARC never block: they only warn.

**Other typed rejections** (`errors.ts`, mapped by the global `onError` from each class's `status` and `code`, SMTP `550`): `404 TEMPLATE_NOT_FOUND` when `templateId` is not a template of the calling key, `422 SUBJECT_REQUIRED` when neither the request nor the template gives a subject, `422 INVALID_CUSTOM_HEADER` when a custom header breaks a rule (see [Custom Headers](#custom-headers)). Messages never echo submitted content other than the sender domain name or a valid custom header name.

## Custom Headers

`POST /api/v1/emails/send` takes an optional `headers` object, name to value (#177): application headers such as `X-Correlation-Id` or `X-Entity-Ref-ID`, and the threading headers `In-Reply-To` and `References`. They are a header-injection surface, so one set of rules (`services/custom-headers.ts`) is applied by `createEmail` (every ingress), and again by the mailer before sending:

| Rule | Limit |
|---|---|
| Name | RFC 5322 field name: printable ASCII except `:` (`\x21` to `\x39` and `\x3b` to `\x7e`), 1 to 64 characters |
| Value | No CR, LF, NUL or other control character (C0 except HTAB, DEL, C1, U+2028, U+2029); at most 998 characters |
| Count | At most 20 headers |
| Total size | At most 8 KB (8192 bytes, UTF-8) of names plus values |
| Duplicates | Names compare case-insensitively; a second spelling of the same name is refused |
| Reserved (any case) | `From`, `Sender`, `To`, `Cc`, `Bcc`, `Reply-To`, `Subject`, `Date`, `Message-ID`, `Return-Path`, `Received`, `DKIM-Signature`, `Authentication-Results`, `Received-SPF`, `MIME-Version`, `List-Unsubscribe`, `List-Unsubscribe-Post`, `List-Id`, `Feedback-ID`, `Precedence`, `Auto-Submitted`, and any name starting with `Content-`, `ARC-` or `X-BunMail-` |

- **Refusal:** name/value syntax and the count are checked by the DTO first (`422 VALIDATION_ERROR`); reserved names, duplicates and the total size by `createEmail` (`422 INVALID_CUSTOM_HEADER`, SMTP `550`). Nothing is queued. The message names the header when its name is valid, never the value.
- **Storage:** `emails.headers` (jsonb object, the caller's spelling of each name). Returned as `headers` on email responses (`null` when none). Retries resend the same set.
- **Sending:** the queue passes the stored set to `sendMail`, which re-applies the rules (dropping, with a `warn` naming the header, anything a row written another way might hold) and hands the rest to Nodemailer's `headers` option before BunMail's own `List-Unsubscribe` pair, so a custom header can never replace `Message-ID`, `From`, `List-Unsubscribe` or any other header BunMail sets. Nodemailer may normalize the case of a name (`X-Correlation-Id` is written `X-Correlation-ID`) and MIME-encodes non-ASCII values.
- **DKIM:** `In-Reply-To` and `References` are in the signed header list (`DKIM_SIGNED_HEADERS`); `X-*` headers are not signed.
- **SMTP submission** relays `In-Reply-To`, `References` and `X-*` from the submitted message through the same rules, dropping (not refusing) any that fail: see [smtp-submission.md](smtp-submission.md).
- **Logs** carry header names, counts and the rule broken, never values.

## Idempotency Keys

`POST /api/v1/emails/send` takes an optional `Idempotency-Key` header (#188): a retry with the same key and body within `IDEMPOTENCY_KEY_TTL_HOURS` (default 24, 1 to 168) creates nothing and answers with the first response plus `Idempotent-Replayed: true`; the same key with another body is `422 IDEMPOTENCY_KEY_REUSED`. Client-facing rules are in [api.md](api.md#post-apiv1emailssend).

**Why a table and not a column on `emails`:** the issue proposed an `idempotency_key` column with a unique index on `(api_key_id, idempotency_key)`. That index cannot express the TTL (an expired key must become reusable while its email stays), and a key would follow its email through trash and purge. A separate table keeps the key's lifetime independent of the email's, and stores the response snapshot a replay needs after the email is gone.

**Flow** (`createEmailIdempotent` in `email.service.ts`, storage in `idempotency.service.ts`):

1. Hash the validated body: SHA-256 of its canonical JSON (object keys sorted at every depth), so the same JSON with members in another order matches.
2. A live row for `(api_key_id, key)` (`expires_at > now()`) answers at once: replay when the hash matches, `IdempotencyKeyReusedError` when not. This runs before the send is checked, so a replay returns the original result even if, for example, the recipient was suppressed since.
3. Otherwise run every send check (`prepareEmail`: custom headers, suppression, key and allowed senders, template, subject, body, sender domain) outside any transaction. A refused send stores nothing, so the client can fix the cause and retry with the same key.
4. In one transaction: claim the key first (`INSERT ... ON CONFLICT (api_key_id, key) DO UPDATE ... WHERE expires_at <= now() RETURNING id`, which inserts it or takes over an expired row), insert the email, then fill `email_id`, `response_status` and `response_body` (the response without message content) on the claimed row. A committed row is therefore always complete: there is no in-progress state.
5. If the claim returns nothing, a live row exists and is committed (the unique index made this transaction wait until the other one committed; had it rolled back, the claim would have succeeded). Read it and replay or refuse as in step 2.

Concurrent requests with the same key create exactly one email: one claims, the others wait on the unique index (or on the expired row's lock) and replay once it commits. Inside the transaction every query runs on the transaction's connection, so waiting requests holding pool connections cannot starve the one they wait for.

**What is not idempotent:** SMTP submission (no natural header; REST only), and the per-key rate limit (a replay is a request and counts). `reserveAccepted` (#190) only applies to SMTP submission, so replays reserve no quota.

**Retention:** the purge worker deletes expired rows in batches (`purgeExpiredIdempotencyKeys`, 5000 rows per batch, every 6 hours with the trash purge). Correctness never depends on it: an expired row is treated as absent and taken over in place.

**No message content in the snapshot:** `response_body` is the first response with `subject`, `html`, `text` and `headers` removed from `data` (`withoutContent`); ids, addresses, status, timestamps and warnings stay, so the storage overhead is small. A replay fills the four fields back (`findReplayContent`: one read by the email's primary key, scoped to the same API key, `deleted_at IS NULL`), or sets them `null` once the email is trashed or purged. The replay keeps the response shape either way, and deleting an email removes its content everywhere.

## Feedback-ID and Auto-Submitted (#250)

- **`Feedback-ID`** on every queued email: `<source>:<key>:<sender domain>:bunmail`, where `source` is `api` or `smtp` and `key` is 12 hex characters of a hash (`Bun.hash`) of the sending API key id (stable per tenant, no internal identifier exposed). Gmail's feedback loop aggregates complaints by it; it is deliberately low-cardinality (no per-message id). It is DKIM-signed. BunMail's own mail uses `system:system:<domain>:bunmail`.
- **`Auto-Submitted: auto-generated`** and **`X-Auto-Response-Suppress: All`** on BunMail's own automatic mail (inbound notifications, invitations, new-device sign-in alerts), so out-of-office and other auto-responders do not reply to it.
- Both are built by BunMail from typed values, never from caller text; callers cannot set either header (reserved, #177).

## List-Unsubscribe

Every outbound message carries an RFC 2369 `List-Unsubscribe` header, built per email by `listUnsubscribeOptions` (`services/list-unsubscribe.ts`) on every send attempt.

**Per-recipient one-click (#249).** When the email has exactly one recipient (one `to` address, **no cc and no bcc**) and `APP_BASE_URL` is an `https://` URL, the header names that recipient with a token (see [suppressions.md](suppressions.md#one-click-unsubscribe)):

| Inbound SMTP (`SMTP_ENABLED`) | Domain `unsubscribe_email` | Header(s) emitted |
|---|---|---|
| on | any | `List-Unsubscribe: <mailto:unsub+{token}@{from-domain}>, <{APP_BASE_URL}/u/{token}>`<br>`List-Unsubscribe-Post: List-Unsubscribe=One-Click` |
| off | set | `List-Unsubscribe: <mailto:{unsubscribe_email}>, <{APP_BASE_URL}/u/{token}>`<br>`List-Unsubscribe-Post: List-Unsubscribe=One-Click` |
| off | `NULL` | `List-Unsubscribe: <{APP_BASE_URL}/u/{token}>`<br>`List-Unsubscribe-Post: List-Unsubscribe=One-Click` |

- The per-recipient URL **takes precedence over the domain's `unsubscribe_url`**: RFC 8058's POST body is only `List-Unsubscribe=One-Click`, so a static URL cannot tell who clicked. A POST to `/u/{token}` (or a message to `unsub+{token}@...`) becomes a permanent `unsubscribe` suppression for the sending key and fires `email.unsubscribed`.
- **Why not with cc or bcc?** Every recipient of a message gets the same header, so a token there would let a cc or bcc recipient unsubscribe the `to` address. Such messages keep the static header below.
- The token is deterministic, so retries carry the same header.
- The `unsub+` mailto only works when the sending domain's MX points at this BunMail's inbound receiver; with `SMTP_ENABLED=true` and the MX elsewhere, that mailbox goes to your other mail host instead. Set `unsubscribe_email` and leave `SMTP_ENABLED` off in that case.

**Static (every other case: cc or bcc, more than one `to`, no `https://` `APP_BASE_URL`):**

| Domain config (in `domains` table) | Header(s) emitted |
|---|---|
| `unsubscribe_email = NULL`, `unsubscribe_url = NULL` | `List-Unsubscribe: <mailto:unsubscribe@{from-domain}>` |
| `unsubscribe_email = "optout@x.com"` | `List-Unsubscribe: <mailto:optout@x.com>` |
| `unsubscribe_url = "https://x.com/u/abc"` | `List-Unsubscribe: <mailto:unsubscribe@{from-domain}>, <https://x.com/u/abc>`<br>`List-Unsubscribe-Post: List-Unsubscribe=One-Click` |
| Both set | Both forms in the same `List-Unsubscribe`, plus the `One-Click` POST header |

**Why always-on?** Gmail and Yahoo's Feb-2024 sender requirements treat the presence of `List-Unsubscribe` as a positive ranking signal, including on transactional mail. The mailto-only form is sufficient for transactional senders. Bulk / promotional senders (Gmail's "high volume" threshold, more than 5k a day to Gmail) need RFC 8058 one-click that is **honored within 2 days**: send each such message to one recipient and set an `https://` `APP_BASE_URL`, so it carries the per-recipient link. A static `unsubscribe_url` only meets that requirement if your own handler can identify the recipient from the URL itself.

**Signed:** both `List-Unsubscribe` and `List-Unsubscribe-Post` are covered by the DKIM signature (`DKIM_SIGNED_HEADERS` in `mailer.service.ts`). RFC 8058 requires that for one-click unsubscribe, and nodemailer's default list leaves the Post header out (#241).

**Why per-domain config?** The default `unsubscribe@<domain>` mailbox often doesn't exist; emitting unroutable addresses is worse than a working override. Set `unsubscribeEmail` to a real mailbox you read, and `unsubscribeUrl` to a handler that processes the POST body (Gmail sends `List-Unsubscribe=One-Click` form-encoded).

## Service Methods

### email.service.ts

All read methods exclude trashed rows (`deleted_at IS NULL`) by default. Trash-specific methods explicitly target trashed rows.

**Reads (live)**

#### `createEmail(input, apiKeyId, source?): Promise<CreatedEmail>`
Creates an email record with status `queued` and returns `{ email, warnings }`. Resolves templates if `templateId` is provided. Links the sender's domain for DKIM signing and reports its unverified DNS records (see [Domain Linking](#domain-linking)). Validates and stores custom `headers` (see [Custom Headers](#custom-headers)). Throws an `EmailSendRejectedError` subclass for input it refuses.

#### `createEmailIdempotent(input, apiKeyId, idempotencyKey, buildResponse): Promise<IdempotentSendResult>`
`createEmail` under an `Idempotency-Key` (#188, REST only). `buildResponse` turns the created email into the route's response (`{ status, body }`); it is stored with the key, without message content, in the same transaction. Returns `{ status, body, replayed }`; throws `IdempotencyKeyReusedError` for the same key with another body. See [Idempotency Keys](#idempotency-keys).

#### `getEmailById(id, apiKeyId): Promise<Email | undefined>`
Retrieves a non-trashed email scoped to the requesting API key.

#### `getEmailByIdUnscoped(id): Promise<Email | undefined>`
Dashboard variant: no API-key scope. Excludes trashed.

#### `listEmails(apiKeyId, filters): Promise<{ data, total }>` / `listAllEmails(filters)`
Paginated listing with optional status filter. Trashed rows excluded.

**Trash (scoped)**

#### `trashEmail(id, apiKeyId)` / `trashEmails(ids[], apiKeyId)`
Soft-delete (sets `deleted_at = NOW()`). Single or bulk. Idempotent. Returns the row or count.

#### `listTrashedEmails(apiKeyId, filters)`
Lists trashed rows for the API key, newest-trashed first.

#### `restoreEmail(id, apiKeyId)`
Clears `deleted_at`. Returns 404 if the row isn't currently trashed.

#### `permanentDeleteEmail(id, apiKeyId)`
Hard delete. Only operates on already-trashed rows.

#### `emptyEmailsTrash(apiKeyId)`
Permanently deletes every trashed email for the key. Returns count.

**Trash (unscoped: dashboard only)**

`trashEmailUnscoped`, `trashEmailsUnscoped`, `listTrashedEmailsUnscoped`, `getTrashedEmailByIdUnscoped`, `restoreEmailUnscoped`, `permanentDeleteEmailUnscoped`, `emptyEmailsTrashUnscoped`: same semantics, no API-key filter.

### idempotency.service.ts

#### `hashSendRequest(input): string` / `canonicalJson(value): string`
SHA-256 hex of the canonical JSON of a send body (object keys sorted, `undefined` dropped).

#### `findIdempotencyRecord(executor, apiKeyId, key, { liveOnly })`
The stored row, or undefined; with `liveOnly` an expired row counts as absent.

#### `claimIdempotencyKey(tx, claim): Promise<string | null>` / `completeIdempotencyKey(tx, id, outcome)`
Claim inserts the row or takes over an expired one (null when a live row exists); complete stores the email id and the response.

#### `withoutContent(body)` / `withContent(body, content)` / `findReplayContent(executor, emailId, apiKeyId)`
Strip `subject`, `html`, `text` and `headers` from a response's `data` before it is stored; fill them back on a replay from the live email (scoped to the API key, not trashed), or with `null` when it is gone.

#### `purgeExpiredIdempotencyKeys(batchSize?): Promise<number>`
Deletes expired rows in batches; run by the purge worker (`runIdempotencyKeySweep`).

### sender-domain.service.ts

#### `checkSenderDomain(name, ids, deps?): Promise<{ domainId, warnings }>`
The sender-domain gate used by `createEmail`: registration, the `REQUIRE_VERIFIED_DOMAIN` inline re-verification with its negative cache, and the warnings. `deps` (verifier, clock, cache) is injectable for tests.

### mailer.service.ts

#### `sendMail(options): Promise<{ messageId, deliveryState }>`
Sends an email via direct SMTP. When `dkim` options are provided, signs the message with the domain's RSA private key. `headers` (the row's custom headers, #177) are re-checked and added to every MX group's message. `returnPath: { emailId }` (set by the queue when `SMTP_ENABLED=true` and the sender domain's MX points here, #236) sends each recipient in its own transaction with its signed return path as envelope sender.

Each transaction's outcome records `tls` and `updatedAt` on its delivery-state entry (#250, see [TLS record](#tls-record-250)). The SMTP session to each MX runs in `runMxSession` (`mx-transport.ts`), see [One session per MX](#one-session-per-mx-250).

#### `buildMailOptions(args): Mail.Options`
Pure: builds one transaction's Nodemailer options (headers, envelope, custom headers, `List-Unsubscribe`, DKIM). `envelopeFrom` sets `MAIL FROM` (the signed return path, #236); it defaults to `from`. Tests render it with a stream transport.

### custom-headers.ts

#### `validateCustomHeaders(headers): CustomHeaders`
Strict check for the send API: returns the headers or throws `InvalidCustomHeaderError` for the first that breaks a rule.

#### `filterCustomHeaders(entries): { headers, dropped }`
Applies the same rules but keeps what passes and reports the rest (`{ name, problem }`, `name` null for an invalid name). Used by SMTP submission and the mailer.

#### `isReservedHeaderName(name): boolean`
Reserved name or prefix, case-insensitive.

### list-unsubscribe.ts

#### `listUnsubscribeOptions(email, domain, settings?): UnsubscribeOptions | undefined`
The `List-Unsubscribe` inputs for one email (see [List-Unsubscribe](#list-unsubscribe)): the per-recipient one-click URL (and `unsub+` mailto when inbound SMTP runs) for a single-recipient email when `APP_BASE_URL` is `https://`, else the domain's static settings. Pure apart from reading `config` when no settings are passed.

#### `oneClickBaseUrl(appBaseUrl): string | null`
`APP_BASE_URL` without a trailing slash when it is an `https://` URL with no query or fragment, else `null`.

### queue.service.ts

#### `start(): void`
Starts the queue processor: polls every `QUEUE_POLL_INTERVAL_MS` (default 2 s, +/-10% jitter). Each poll is scheduled after the previous one has claimed its rows, so polls never overlap; the sends run in the background (#176). There is no boot-time recovery step: rows a dead worker left in `sending` are reclaimed by the normal claim once their lease expires (#180).

#### `runQueueCycle(deps?, limits?): Promise<void>`
One poll cycle, waiting for its sends: claims up to `min(batchSize, free slots)` due rows and sends them. The mailer and the limits (`{ batchSize, maxConcurrentSends }`, default from config) are injectable for tests.

#### `stop(): void`
Stops the queue processor gracefully.

#### `processEmail(email, deps): Promise<void>`
1. Arrives already `sending`, with `attempts` incremented and a 15-minute lease (the claim does both); the lease is renewed every minute while sending
2. Looks up DKIM keys for the sender's domain
3. Sends via SMTP with DKIM signing (if keys available)
4. On success: marks `sent`, enqueues `email.sent`
5. On a temporary failure: requeues with `next_attempt_at` from the backoff schedule; once the email is older than `MAIL_RETRY_MAX_AGE_HOURS`, marks `failed` and enqueues `email.failed`
6. Every outcome clears the lease, and is only written if this claim still holds the row (matched on `locked_by` and the claim's `attempts`)
7. The outcome is one transaction (#184): the inline hard-bounce suppressions with their `email.bounced`, the row's status, and `email.sent` / `email.failed`, enqueued as `webhook_deliveries` rows ([webhooks.md](webhooks.md#transactional-outbox-184)). The SMTP send happens before it. A failing transaction is retried twice (100 ms, 500 ms); still failing, the status and suppressions are saved without the events (`Webhook events not recorded for a sent email` at `error`), so a webhook problem never sends the mail twice. Only if that also fails (the database is unavailable) is `Email outcome not saved: transaction rolled back, retried after the lease` logged: the row stays `sending` until its lease expires and is then claimed and sent again. Row events are enqueued only when the claim still held the row

## Status Flow

```
queued ──→ sending ──→ sent ✓        → webhook: email.sent
  ↑           │  │         │
  │           │  │         ↓ (async DSN arrives later)
  │           │  │       bounced ✗  → webhook: email.bounced (source: rfc3464/fallback)
  │           │  │                     set by bounce handler (#24)
  │           │  │
  │           │  └───→ bounced ✗     → webhook: email.bounced (source: inline)
  │           │       (inline 5xx)     set by handleSendFailure (#68)
  │           │                        on attempt 1: stops retrying
  │           │
  └───────────┴───→ queued (retry after backoff, soft 4xx or infra error)

queued ──→ sending ──→ failed ✗ (still failing when MAIL_RETRY_MAX_AGE_HOURS old)
                       → webhook: email.failed (never confirmed unreachable)
```

| Status | Meaning |
|---|---|
| `queued` | Waiting for the queue processor |
| `sending` | Mid-SMTP-transaction |
| `sent` | SMTP transaction succeeded; recipient's MX accepted |
| `bounced` | The recipient is permanently unreachable. Set either when an inline 5xx came back during the SMTP transaction (#68) **or** when a DSN arrived later (#24). Auto-suppression fires in both cases. |
| `failed` | All retries exhausted on a transient (4xx) or infrastructure error, or the recipient domain cannot receive mail (it does not exist, publishes a null MX, or has neither MX nor address records, #250). We never confirmed whether the recipient is reachable. |

See [docs/bounces.md](bounces.md) for both bounce paths.

## Multi-MX Delivery (#87)

Each `emails` row can address recipients across multiple domains (`to` + `cc` + `bcc`). On send, the mailer service:

1. Parses all three fields into a flat recipient list (kind preserved; `to` > `cc` > `bcc` precedence on dedup).
2. **Groups recipients by domain** (#250): one group, and one delivery-state entry, per recipient domain.
3. On every attempt, resolves the MX set of each pending domain, once per domain, in parallel (see [MX resolution and failover](#mx-resolution-and-failover-250)). Domains that resolve to the same hosts in the same order share a session, one transaction each.
4. Generates one canonical `Message-ID:` for the whole email so all recipients see the same identifier (bounce/complaint feedback loops join on this).
5. For each group, submits the **same DKIM-signed message** with `envelope.to` overridden to that group's recipients only, to the first MX host that takes it.

The `To:` / `Cc:` headers on the rendered message always carry the **original full lists** so every recipient sees who else was addressed. BCC addresses appear only in their group's envelope, never in the rendered headers.

### MX resolution and failover (#250)

Each attempt resolves each pending recipient domain again (`resolveMxRoute` in `mx-route.ts`); nothing is cached across attempts, so a temporary DNS failure is never carried over:

| DNS answer | Outcome |
|---|---|
| MX records | Hosts sorted by preference, hosts of equal preference in random order (RFC 5321 5.1). |
| Null MX (`MX 0 .`, RFC 7505, or any empty exchange) | `failed`, `<domain>: domain does not accept mail (null MX)`. |
| No MX records (`ENODATA` or an empty answer) | The **implicit MX**: the domain's own A/AAAA records, as one host of preference 0 (RFC 5321 5.1). With no address records either: `failed`, `<domain>: domain has no MX or address records`. |
| NXDOMAIN (`ENOTFOUND`) | `failed`, `<domain>: domain does not exist`. Bun reports a name without MX records as `ENOTFOUND` too (Node says `ENODATA`), so the A/AAAA records are checked first: a name that does not exist has none, and one that exists without MX records gets its implicit MX. |
| Any other resolver error (`ESERVFAIL`, `ETIMEOUT`, `ECONNREFUSED`, `EAI_AGAIN`, ...), or no answer within 15 s | `retry` on the normal backoff, resolved again on the next attempt. |

A DNS outcome carries no SMTP reply, so it never suppresses a recipient and never counts as a bounce.

**Failover** (`deliverWithFailover`): the hosts are tried in order, and each host's addresses in order, at most **5 hosts** and **2 addresses per host** per attempt. Every address, an implicit MX's included, goes through the MX address check below (a host with any non-public address is skipped), and a host with an IPv4 address is reached over IPv4 only. A transaction moves to the next address or host only after a **connection-level failure** (refused, timed out, reset, a STARTTLS stall, no greeting: no SMTP reply at all) or a **`421`** (greeting or reply). Any other reply from a server that answered (a 4xx or 5xx to `MAIL FROM`, `RCPT TO` or `DATA`) decides the attempt and is classified as below, so a `550` from the primary is never retried on a backup. All sessions of one attempt share the 20-minute session deadline (counted while sessions run, not while waiting for an MX lock). The MX lock is taken per session, keyed by the host connected to, and released before the next host is tried. Each skipped host or address is logged at `debug` with the reason; the entry's outcome is logged as before, with the host it ended on (`mxHost`). When no host could be used, the entry keeps the last failure and is retried.

### One transaction per recipient with signed return paths (#236)

With `SMTP_ENABLED=true` and the sender domain's MX pointing at this server (`MAIL_HOSTNAME` in its MX set; other domains keep the From address), the envelope sender (`MAIL FROM`) is not the From address but each recipient's signed return path, `b+<id>.<index>.<MAC>@<sender domain>`, so a DSN is bound to exactly one email and recipient (see [bounces.md](bounces.md#signed-return-paths-236)). The envelope sender belongs to a whole SMTP transaction, so step 5 changes: each recipient is its own transaction, with only that recipient in `RCPT TO` and its own return path in `MAIL FROM`, and a co-recipient never sees another recipient's return path. The transactions to one MX share one connection (a nodemailer pool of one connection, `maxRequeues: 0` so a dropped connection is reported, not silently resent) and hold the MX's throttle slot once; the 20-minute session deadline covers all of them. The message itself (headers, DKIM signature, custom headers, `List-Unsubscribe`, `Feedback-ID`) is the same in each. A single-recipient email is one transaction, as before. With `SMTP_ENABLED=false` nothing changes: one transaction per recipient domain, envelope sender = From.

### One session per MX (#250)

Every address tried gets one SMTP session (`runMxSession` in `mx-transport.ts`), run under its MX's throttle slot:

- **One pooled connection** (`pool: true`, `maxConnections: 1`, `maxRequeues: 0`), also for a single transaction, so there is one code path. The transactions of the session (one per recipient with signed return paths, else one) go over it in turn, each after `RSET`.
- **BunMail opens the socket.** Nodemailer's `getSocket` hook connects to the checked MX address (60 s connect timeout) and BunMail keeps the socket.
- **One deadline** of 20 minutes for the whole session, and the 60 s STARTTLS stall limit of the TLS record. Either fails the attempt with an error that has no SMTP reply, so the entry is retried.
- **Always closed.** When the session ends (delivered, refused, timed out or stalled), its sockets are destroyed and the pool closed. Closing a Nodemailer transport or pool alone does not end a connection that is still busy, so a receiver that accepts and never answers, or stops mid-session (before or after STARTTLS), would otherwise leave the connection open after the attempt was given up. `test/integration/mx-session.integration.test.ts` checks, against a real receiver, that the server sees no open connection right after each kind of session.

### Per-group delivery state (`emails.delivery_state`, #97)

Every send writes a per-group outcome map into `emails.delivery_state` (JSONB, nullable). Each entry is keyed by recipient domain (#250; entries written before are keyed by destination MX hostname) and records:

```jsonc
{
  "gmail.com": {
    "status": "sent",
    "recipients": ["alice@gmail.com"],
    "attempts": 1,
    "domain": "gmail.com",
    "mxHost": "gmail-smtp-in.l.google.com",
    "deliveredAt": "2026-05-25T00:00:00.000Z",
    "messageId": "<abc@mail.example.com>",
    "tls": "starttls",
    "mtaSts": "enforce",
    "updatedAt": "2026-05-25T00:00:00.000Z"
  },
  "outlook.com": {
    "status": "retry",
    "recipients": ["bob@outlook.com"],
    "attempts": 1,
    "domain": "outlook.com",
    "mxHost": "outlook-com.olc.protection.outlook.com",
    "lastError": "450 4.7.500 Server busy",
    "failureKind": "soft",
    "failureCode": "4.7.500",
    "tls": "plaintext",
    "mtaSts": null,
    "updatedAt": "2026-05-25T00:00:01.000Z"
  }
}
```

`domain` is the entry's recipient domain, resolved again on every attempt; `mxHost` is the MX host of the latest outcome (the one that accepted or answered, or the last one tried), absent while no host was reached.

**Status values:** `sent` (delivered, won't retry), `retry` (soft failure, queue may retry), `failed` (terminal: a hard 5xx that auto-suppressed the recipients, a sender policy block, or the email got too old to retry with this group still pending). A group refused for sender reasons (5.7.x, blocklist, authentication) has `"blocked": true` and its recipients are not suppressed (#246). A failure is classified from the SMTP reply only (#250): Nodemailer's `responseCode`/`response`, or a line that starts with a reply code; a connection, DNS or TLS error has no reply and stays `retry`, so an IP address, port or host name in its message is never read as a status code. The classification is stored on the group (`failureKind`: `hard`, `policy` or `soft`; `failureCode`), and the queue reads it instead of re-parsing `lastError`.

**Retry semantics:** on the next queue pass, the mailer reads `delivery_state` and **skips every group already in `sent` state**. Only `retry`-state groups are re-submitted. A Gmail group that succeeded on attempt 1 never receives a duplicate on attempt 2 even if Outlook 4xx-retries multiple times.

**Per-recipient entries (#236):** with signed return paths, a pending group of several recipients is split into one entry per recipient, keyed `<domain>#<recipient index>` (for example `"gmail.com#2": { "recipients": ["carol@gmail.com"], ... }`). Each keeps its own status, attempts, classification and retries, so one recipient's `550` or `451` does not decide the others'. Single-recipient groups keep their domain as key. A row that is retried after `SMTP_ENABLED` changes is handled either way: a multi-recipient group is split when return paths are on, and a per-recipient entry is still routed by its domain when they are off.

**Per-recipient `RCPT TO` outcomes (#250):** without return paths, one transaction carries all of a group's recipients, and the MX may accept some and refuse others at `RCPT TO`. The group is then split: the accepted recipients stay on the entry as `sent`; each refused recipient gets its own entry, keyed `<group key>#<recipient index>`, with its own reply's `failureKind`, `failureCode` and `lastError`: `retry` for a 4xx (only those recipients go out on the next attempt), `failed` for a 5xx, through the same inline hard-bounce path as a whole-group 5xx (suppression, never weakening a permanent one, #191, and `email.bounced` through the outbox, #184; a 5.7.x sender block is `blocked` and suppresses nobody). When every recipient is refused, the transaction fails as a whole, as before.

**DNS outcomes (#250):** a domain that cannot receive mail (see [MX resolution and failover](#mx-resolution-and-failover-250)) is `failed` under its own key; a temporary DNS failure is `retry`. Rows from before #250 may still hold a synthetic `<dns:<domain>>` entry (already `failed`, never retried), and pending entries keyed by an MX are routed by their recipients' domains (a group of several domains is split, keyed `<old key>|<domain>`).

**`updatedAt`** (#250): when the entry's latest outcome happened (an attempt, a DNS failure, or recipients suppressed before a retry). Absent on entries written before #250.

### TLS record (#250)

Unless the recipient domain's MTA-STS policy is in enforce mode (see [MTA-STS](#mta-sts-250)), outbound STARTTLS is opportunistic: used when the MX offers it, never required, and certificates are not verified (`rejectUnauthorized: false`), since most MX certificates would fail a strict check. DANE is not implemented. The transport sets `tls.minVersion: "TLSv1.2"`, so a peer that only offers TLS 1.0 or 1.1 fails the handshake; the failure has no SMTP reply, so the entry stays `retry`.

Each entry records `tls`, the encryption of the session behind its latest outcome: `starttls`, `plaintext` (the MX did not offer STARTTLS, or answered it with an error), or `null` (no session got ready: a connection, DNS or TLS failure). It is read from Nodemailer's own events, through a logger passed to each MX transport (`createTlsRecorder` in `mx-transport.ts`), never from the server's reply text:

- the STARTTLS upgrade line of the connection (`Connection upgraded with STARTTLS`), per connection id, reset when a new connection starts;
- the transport's `send` line, written once the greeting, EHLO and any STARTTLS restart are done.

A transaction is `starttls` only when both happened: under Bun the TLS callback can fire for a handshake the peer refused, after which the session never answers. Such a session (upgrade reported, never ready) fails after 60 s (`STARTTLS handshake did not complete`) instead of waiting for the 20-minute session cap. Nothing from these events is logged or stored besides the three facts. A real-server test (`test/unit/mx-transport.test.ts`, `smtp-server` under Node) pins the behaviour for STARTTLS, plaintext and a TLS 1.1-only peer.

### MTA-STS (#250)

A recipient domain can publish an MTA-STS policy (RFC 8461) naming the MX hosts that may receive its mail and requiring verified TLS to them. The mailer honours it on outbound mail (`mta-sts.ts`, `discoverMtaStsPolicy`); DANE, TLS-RPT and inbound MTA-STS are not implemented.

**Discovery**, for each pending recipient domain on every attempt, in parallel with its MX resolution:

- TXT `_mta-sts.<domain>`: records not starting with `v=STSv1` are ignored; exactly one remaining record with a valid `id` (1 to 32 letters and digits) announces a policy. None, several, or an invalid one: no policy is announced (RFC 8461 3.1).
- The policy, `https://mta-sts.<domain>/.well-known/mta-sts.txt`: HTTPS with the certificate verified for `mta-sts.<domain>`, no redirects (a `3xx`, like any status but `200`, is a failed fetch), a 10 s timeout over headers and body, at most 64 KB, `Content-Type: text/plain` (parameters allowed), no content encoding, no connection reuse.
- **SSRF:** the policy host is chosen by the recipient domain, so it is resolved once and refused when any address is private, loopback, link-local or otherwise non-public (the MX address rule; `MAIL_ALLOW_PRIVATE_MX=true` lifts it, as for MX hosts). The request goes to the checked address (IPv4 first), never to the name, with `mta-sts.<domain>` as the TLS server name and `Host` header, so Bun verifies the certificate against the name during the handshake.
- **Parsing**, strict: `version: STSv1`; `mode: enforce`, `testing` or `none`; `max_age` of 1 to 10 digits, capped at 31557600 s (about a year); one or more `mx` patterns unless the mode is `none` (a host name, optionally with one leading `*.` label). Lines end in CRLF or LF. A required field that is missing, repeated or invalid, or any invalid `mx` pattern, makes the policy invalid. Unknown keys and lines that are not `key: value` are ignored.

**Cache**, in memory, per recipient domain, at most 10,000 domains (the entry stored longest ago is evicted), keyed with the policy `id`:

- The TXT `id` is unchanged and `max_age` has not passed: the cached policy is used, nothing is fetched.
- The `id` changed or the policy expired: the policy is fetched. When that fails, an unexpired cached policy is kept (RFC 8461 5.1), and the same `id` is not fetched again for 5 minutes, so a dead policy host does not cost every attempt a timeout.
- The TXT record disappears: the cached policy is kept until its `max_age` (RFC 8461 5).
- The TXT lookup fails (`ESERVFAIL`, a timeout, ...): the cached policy is kept; with none cached, the attempt has no policy (opportunistic, as without MTA-STS).
- **Per replica:** each process discovers and caches on its own, and a fresh process (or replica) trusts its first fetch. A domain is first contacted without any knowledge of its policy, which is the trust-on-first-use the RFC accepts.

**Enforce mode:**

- Only the MX hosts matching a policy pattern are candidates (case-insensitive; `*.example.com` matches exactly one leftmost label: `mx1.example.com`, not `a.b.example.com` and not `example.com`), in their preference order, under the usual failover caps. No matching host: the entry is `retry` with `lastError` `<domain>: no MX host matches the MTA-STS policy; will retry`, and nothing is connected to.
- Each candidate gets `requireTLS` (no plaintext fallback), `rejectUnauthorized: true` and the MX host name as `servername`: the certificate must chain to a trusted root and name the MX host. The socket stays BunMail's own and pinned to the checked address.
- A missing STARTTLS, a refused `STARTTLS` (whose `5xx` reply is dropped), or a certificate failure is reported as `MTA-STS: no verified TLS with <mx> (<reason>)`, an error with no SMTP reply: the entry stays `retry`, never bounced or suppressed, and the attempt fails over to the next matching host (TLS failures count as connection-level). The retry window (`MAIL_RETRY_MAX_AGE_HOURS`) gives the RFC's eventual failure.
- Enforced domains never share a session with other domains' unverified ones.

**Testing mode:** delivered as without a policy (all MX hosts, opportunistic TLS). What enforce mode would have refused (no matching MX host, or a session that ended up `plaintext`) is logged at `warn`, `MTA-STS testing policy would fail in enforce mode`, once per domain and policy `id`. **Mode `none`:** as without a policy.

**Recorded:** each entry's `mtaSts` is the mode its latest attempt ran under: `enforce`, `testing`, or `null` (no policy, or `none`).

**Logs:** a failed fetch or TXT lookup at `warn` (`MTA-STS policy fetch failed` with the domain, policy `id` and reason; `MTA-STS TXT lookup failed` with the DNS code), each with whether a cached policy was kept; a fetched policy and skipped hosts at `debug`.

### Exposed in the API and on the detail page (#250)

`deliveryState` on every email response (see [api.md](api.md#post-apiv1emailssend)) is built from this column by `serializeDeliveryState`: one entry per stored key, with `mx` (`mxHost`; `null` while no MX host was reached; on older entries keyed by their MX, `mxHost` or the key, and `null` for a `<dns:...>` entry), `recipients`, `status`, `attempts`, `failureKind`, `failureCode`, `lastError`, `tls`, `mtaSts` and `updatedAt` (falling back to `deliveredAt`), sorted by `mx` then first recipient. The internal key, `domain`, `mxHost`, `blocked`, `messageId` and `deliveredAt` are not exposed. The dashboard's email detail page renders the same entries as the **Delivery by MX** table, with "MTA-STS enforced" (or "MTA-STS testing") under the TLS cell of an entry delivered under a policy.

### Aggregate status semantics

| Per-group outcomes | Email status | Auto-suppression | Retry |
|---|---|---|---|
| All groups `sent` | `sent` | none | none |
| Any group `retry` AND email younger than the retry window | `queued` (retry pass after backoff) | per-recipient on `failed` groups only | yes, only `retry` groups re-submitted |
| Retry window passed with any `retry` left | `failed` (or `bounced` if any hard) | per-recipient on `failed` groups (hard 5xx) | none |
| All groups `failed`, any hard 5xx | `bounced` | per-recipient on each failed group | none |
| All groups `failed`, all transient | `failed` | none | none |
| Mixed: some `sent`, some `failed` | `sent` (partial delivery) | per-recipient on the failed groups (hard 5xx) | none |

The `email.sent` webhook fires **once** when the row first transitions to having any group in `sent`. The `email.bounced` webhook fires per recipient that hits a hard 5xx: duplicate dispatches across retry passes are suppressed by comparing against the prior state.

## Queue Architecture

- **Polling interval:** `QUEUE_POLL_INTERVAL_MS`, default 2 seconds, +/-10% jitter so replicas don't poll in lockstep. A poll is scheduled only after the previous one has claimed its rows: polls never overlap (#176).
- **Batch size:** `QUEUE_BATCH_SIZE`, default 5 emails per poll.
- **Bounded concurrency (#176):** at most `QUEUE_MAX_CONCURRENT_SENDS` (default 10) sends in flight per process. A poll claims only as many rows as there are free slots, and none when all are taken, so a slow or hanging receiver holds its slots instead of making the queue open ever more connections. Sends waiting for a busy MX (per-MX throttle below) hold their slot while they wait.
- **Retry backoff (#180):** a temporary failure (4xx, connection or DNS error) requeues the email with `next_attempt_at` set 5 m, 15 m, 30 m, 1 h, 2 h, then every 4 h after each attempt, until the email is older than `MAIL_RETRY_MAX_AGE_HOURS` (default 48); then it is `failed`. Receivers that defer (greylisting, Yahoo `421 [TSS04]`, Microsoft `451 4.7.500`, Gmail `421 4.7.28`) are retried when they expect it instead of within seconds. While deferred, the API shows `status: "queued"` and `nextAttemptAt`.
- **Leases (#180):** the claim stamps `locked_by` and a 15-minute `lease_until`; the worker renews the lease every minute and clears it with the outcome, which is only written if it still holds the row. If a worker dies, its rows become claimable once the lease expires (the lost attempt counts). This replaces the boot-time reset of every `sending` row, which resent emails another replica was still sending.
- **SMTP timeouts (#250):** connecting and the greeting time out after 60 s (they come before anything is sent, so a dead or tarpitting MX releases its MX lock quickly); socket inactivity stays at nodemailer's 10 minutes, because RFC 5321 has the client wait that long for the reply to the final `.` of DATA and a shorter timeout risks a retry and a duplicate; the whole session is capped at 20 minutes (`sendWithDeadline`: the transport is closed and the attempt is retried, never read as a bounce). The queue's lease is renewed while a send runs, so long sends are safe.
- **Upgrade and shutdown:** a `sending` row with no lease (claimed by a version without leases, e.g. during a rolling deploy) counts as leased until 15 minutes after its last update. On shutdown a process expires its own leases so another worker can take its in-flight rows right away.
- **Re-checks on retry:** each pass checks that the sending API key is still active; a key revoked in the meantime fails the email without sending. Each retry pass also re-checks the suppression list (#262): a recipient suppressed since the email was accepted (bounce or complaint from another email, unsubscribe, manual entry) is dropped from its group, and a group left with nobody becomes `failed` (`All recipients were suppressed before this retry`), so it is never sent. `sentAt` is the time the first MX group was delivered, set as soon as one is, even while other groups are still retrying.
- **Atomic claim:** Each cycle's `queued → sending` transition is one statement guarded by Postgres `FOR UPDATE SKIP LOCKED` (#20). Concurrent workers always see disjoint claims: running multiple BunMail instances against the same DB will not double-send.
- **Fair claim (#258):** each batch is shared across API keys round-robin, so one key's backlog cannot delay another key's mail. For every API key a `LATERAL` subquery takes its first `n` due rows in due order (`next_attempt_at`, then `created_at`) through `idx_emails_due_per_key`, locking them `SKIP LOCKED`; rows with an expired lease are added (at most `n`). The candidates are ranked within their key, and the batch takes the lowest ranks first, oldest first within a rank: with keys A (500 due), B (3) and C (1) and a batch of 5, the claim takes A1, B1, C1, A2, B2. A single key keeps plain FIFO order. The cost is one short index probe per key whatever the backlog (0.4 ms with 50,000 due rows from one key). The lock sits in the per-key subqueries (Postgres refuses `FOR UPDATE` next to a window function), which keeps concurrent workers' claims disjoint; candidates locked but not taken are released when the statement ends.
- **MX address check:** each MX host, and the domain itself for an implicit MX (#250), is resolved by the mailer itself and refused if any address is not publicly routable (`mx-address.ts`, same ranges as the webhook SSRF guard). The transport connects to a checked address (IPv4 preferred) with the MX name as TLS SNI, so a DNS answer cannot change between check and connect. A refused host is skipped for the next one (#250); when none is left, it is a normal failed attempt for that group (retried, then `failed`); nothing is suppressed. A null MX fails the group at once (#250). `MAIL_ALLOW_PRIVATE_MX=true` allows private MX hosts for deliberate internal delivery.
- **Per-MX throttle (#91):** SMTP sessions are throttled per destination MX via a module-level semaphore (`src/utils/mx-throttle.ts`). Default is **one parallel session per MX** (configurable via `MAIL_MX_CONCURRENCY`). Sends to different MXs run in parallel; sends to the same MX serialize. The semaphore holds across poll cycles, so back-to-back batches that share a destination can't pile up either. This is what stops strict receivers (Outlook, Yahoo) from `421`ing parallel sessions from the same source IP. Operators with established IP reputation can raise the cap to 2-3; values above 3 are rarely worth it.
- **Crash recovery:** lease expiry (see Leases above); nothing runs at startup
- **DKIM:** Automatically signs with domain's RSA key when available
- **Webhooks:** Dispatches `email.sent` and `email.failed` events

## Tombstones (#34)

Hard-deleting an email: whether by the periodic trash purge sweep, the per-row `DELETE /:id/permanent` API, or the bulk `POST /trash/empty`: writes a snapshot to the `email_tombstones` table **before** it actually deletes the row. Tombstones preserve only **identifiers**: `id`, `apiKeyId`, `messageId`, `fromAddress`, `toAddress`, `subject`, `status`, `sentAt`, `deletedAt`, `purgedAt`. Body / html / text are deliberately dropped: purging the body is the whole point of trash retention; the tombstone is forensic-only.

### Why

When a complaint, late bounce, or compliance audit arrives weeks later referring to a `Message-ID`, an operator needs to be able to answer "did we send this?". Without tombstones, the row was gone after the trash purge ran and that question was unanswerable. With them, the read API at `GET /api/v1/emails/tombstones?messageId=…` returns the snapshot in milliseconds.

### Lifecycle

```
emails row (sent/bounced/failed)
       │
       ▼  user soft-deletes (deleted_at = now())
emails row (in trash)
       │
       ▼  TRASH_RETENTION_DAYS later: purge sweep, or operator hits "permanent"
       │  ╳── all five hard-delete paths route through `deleteEmailsWithTombstones`
       │     which wraps INSERT INTO email_tombstones + DELETE FROM emails in one tx
       ▼
email_tombstones row (snapshot)  ←─ readable via API + dashboard for TOMBSTONE_RETENTION_DAYS
       │
       ▼  TOMBSTONE_RETENTION_DAYS later: `runTombstoneRetention` sweeps it
(gone forever)
```

### Snapshot semantics: no foreign keys

Tombstones must outlive the `api_keys` row that owned the original email: exactly the audit-trail use case is "you revoked the key, but a complaint about a message it sent six weeks ago just arrived". So `apiKeyId` on the tombstone is a **denormalised text snapshot**, not a FK. CASCADE on api_keys deletion does not touch tombstones.

### Read API

```bash
# Trace a Message-ID (the bounce/complaint hot path).
# Accepts both wrapped and unwrapped forms: operators paste from logs / DSNs.
curl https://your-host/api/v1/emails/tombstones?messageId=abc-123@your-domain \
  -H "Authorization: Bearer $BM_KEY"

# Or by original email id:
curl https://your-host/api/v1/emails/tombstones/msg_abc123... \
  -H "Authorization: Bearer $BM_KEY"
```

Dashboard equivalent: `/dashboard/emails/tombstones` with a Message-ID search box.

### Configuration

```bash
TOMBSTONE_RETENTION_DAYS=90   # default; how long tombstones survive their parent's hard-delete
```

### Out of scope

- **Inbound tombstones.** Inbound emails have a different shape (`fromAddress` / `receivedAt` instead of `toAddress` / `sentAt`); the audit-trail value is real but a separate ticket. Today the inbound trash purge still hard-deletes without a snapshot.
- **Restore from tombstone.** Tombstones don't keep the body: there's nothing to restore. They're read-only forensic data.
