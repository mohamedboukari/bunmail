# BunMail API Reference

Base URL: `http://localhost:3000`

## OpenAPI Specification

BunMail exposes an auto-generated OpenAPI 3.0 spec:

- **Interactive docs (Scalar):** `GET /api/docs`
- **Raw JSON spec:** `GET /api/docs/json`

## Authentication

All endpoints (except `/health` and the public unsubscribe pages, `/u/:token`) require a Bearer token in the `Authorization` header:

```
Authorization: Bearer bm_live_<your-api-key>
```

API keys are managed via the `/api/v1/api-keys` endpoints. The first key is created using the seed script (`bun run src/db/seed.ts`).

Changes made through the API (API keys created, updated or revoked; domains added, updated, verified or deleted; webhooks created or deleted; suppressions added or removed) are recorded in the audit log (#221) with the calling key as the actor, its name, the client IP and the user agent. Admins and the owner read it on the dashboard; see [docs/audit-log.md](audit-log.md).

> **Sending over SMTP instead of REST?** Besides this HTTP API, BunMail can run an SMTP **submission** server (#120) so apps that only speak SMTP send *through* BunMail: the same `bm_live_…` key is used as the SMTP password. It has no REST endpoints of its own; see [docs/smtp-submission.md](smtp-submission.md).

## Rate Limiting

- **Limit:** 100 requests per 60-second fixed window per API key by default (`API_RATE_LIMIT_MAX` / `API_RATE_LIMIT_WINDOW`)
- **Scope:** Per API key ID (not per IP)
- **Response on exceed:** `429 Too Many Requests` with `Retry-After` header (seconds)

---

## Pagination

Every list endpoint takes the same query params:

| Param   | Type   | Default | Range         |
|---------|--------|---------|---------------|
| `page`  | number | 1       | 1 to 1,000,000 |
| `limit` | number | 20      | 1 to 100      |

A value outside the range, or one that isn't a number, returns **422** (#172). Responses carry `pagination: { page, limit, total }`. The page cap keeps the underlying `OFFSET` well inside PostgreSQL's integer range.

## Endpoints

### Health Check

#### `GET /health`

Returns server health status. No authentication required.

**Response:**

```json
{
  "status": "ok",
  "timestamp": "2026-03-15T12:00:00.000Z"
}
```

---

### Unsubscribe (public, #249)

#### `GET /u/:token` / `POST /u/:token`

The per-recipient one-click link BunMail puts in `List-Unsubscribe` (see [emails.md](emails.md#list-unsubscribe)). No Bearer token: the token in the path is the credential. HTML responses, not JSON.

- `GET`: confirmation page. Never suppresses (link scanners and prefetchers fetch GETs).
- `POST`: body `List-Unsubscribe=One-Click` (RFC 8058, form-encoded or multipart, sent by mailbox providers) or `confirm=unsubscribe` (the confirmation button). Adds a permanent `unsubscribe` suppression for the recipient under the sending key and fires `email.unsubscribed` the first time. `200` also when already suppressed. Any other body: `400`.
- Invalid, unknown or purged token: `404` with a neutral page, nothing written. Over 30 requests a minute from one client IP: `429` with `Retry-After`.

See [suppressions.md](suppressions.md#one-click-unsubscribe).

---

### Emails

All email endpoints are prefixed with `/api/v1/emails`.

#### `POST /api/v1/emails/send`

Queue a new email for delivery. Supports direct content or template-based sending.

**Request Body:**

| Field        | Type   | Required | Description                                  |
|--------------|--------|----------|----------------------------------------------|
| `from`       | string | Yes      | Sender email address                         |
| `to`         | string | Yes      | Recipient email address                      |
| `subject`    | string | *        | Subject line (required when not using template) |
| `html`       | string | No       | HTML body (max 5 MB)                         |
| `text`       | string | No       | Plain text body (max 5 MB)                   |
| `cc`         | string | No       | Comma-separated CC recipients                |
| `bcc`        | string | No       | Comma-separated BCC recipients               |
| `replyTo`    | string | No       | Comma-separated Reply-To address(es): replies go here instead of `from` (#169). Header only; doesn't change the envelope sender. Returned as `replyTo` on email responses (`null` when unset). |
| `templateId` | string | No       | Template ID (overrides subject/html/text)    |
| `variables`  | object | No       | Key-value pairs for template rendering (max 100 entries, values max 100 KB; the rendered body is capped at 5 MB and the subject at 500 characters, else `422 TEMPLATE_OUTPUT_TOO_LARGE`) |
| `headers`    | object | No       | Custom headers, name to value (#177), e.g. `{"X-Correlation-Id": "abc", "In-Reply-To": "<parent@example.com>"}`. Rules below. Returned as `headers` on email responses (`null` when unset). |

Oversize bodies return `422 Unprocessable Entity` from the validation layer.

**Custom headers** (`headers`, #177): application headers (`X-*`) and threading headers (`In-Reply-To`, `References`). Header injection is blocked, and BunMail's own headers cannot be overridden:

- **Name:** RFC 5322 field name, printable ASCII without spaces or `:`, 1 to 64 characters.
- **Value:** no CR, LF, NUL or other control character (tab is allowed), at most 998 characters.
- **At most 20 headers**, at most **8 KB** of names plus values in total.
- **Case-insensitive:** `X-Foo` and `x-foo` together are a duplicate and refused.
- **Reserved** (any case): `From`, `Sender`, `To`, `Cc`, `Bcc`, `Reply-To`, `Subject`, `Date`, `Message-ID`, `Return-Path`, `Received`, `DKIM-Signature`, `Authentication-Results`, `Received-SPF`, `MIME-Version`, `List-Unsubscribe`, `List-Unsubscribe-Post`, `List-Id`, `Feedback-ID`, `Precedence`, `Auto-Submitted`, and names starting with `Content-`, `ARC-` or `X-BunMail-`. Use the dedicated fields (`from`, `cc`, `replyTo`, ...) and the domain's unsubscribe settings instead.

A name or value with bad syntax, or more than 20 headers, fails validation (`422 VALIDATION_ERROR`); a reserved name, a duplicate or more than 8 KB is `422 INVALID_CUSTOM_HEADER`. Either way nothing is queued, and the error names the header (when its name is valid) but never echoes the value. Nodemailer may normalize a name's case on the wire (`X-Correlation-Id` is sent as `X-Correlation-ID`).

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "msg_a1b2c3d4e5f6...",
    "from": "hello@example.com",
    "to": "user@example.com",
    "subject": "Welcome!",
    "status": "queued",
    "source": "api",
    "attempts": 0,
    "nextAttemptAt": "2026-03-15T12:00:00.000Z",
    "createdAt": "2026-03-15T12:00:00.000Z"
  },
  "warnings": ["spf_unverified", "dmarc_unverified"]
}
```

`warnings` (#245) lists why the email may fail authentication at the receiver, from the sender domain's stored DNS verification flags: `dkim_unverified`, `spf_unverified`, `dmarc_unverified` (that record of the registered domain is not verified), or, in development only, `domain_unregistered` (sent unsigned). It is `[]` when the domain is registered and all three records are verified. The email is queued either way, unless `REQUIRE_VERIFIED_DOMAIN=true`, which refuses a domain whose DKIM record is still unverified after one inline DNS re-check (a failure is remembered for 5 minutes per domain) with `422 SENDER_DOMAIN_UNVERIFIED`.

**Errors specific to this endpoint:** `422 SENDER_DOMAIN_NOT_REGISTERED` (production, or `REQUIRE_VERIFIED_DOMAIN=true`: register the domain first), `422 SENDER_DOMAIN_UNVERIFIED` (`REQUIRE_VERIFIED_DOMAIN=true`: publish the domain's DKIM TXT record), `404 TEMPLATE_NOT_FOUND` (`templateId` is not a template of this key), `422 SUBJECT_REQUIRED` (no inline subject and no template), `422 BODY_REQUIRED` (neither html nor text, inline or from the template, #250), `422 INVALID_CUSTOM_HEADER` (a custom header is reserved, duplicated, or over the 8 KB total, #177), plus `RECIPIENT_SUPPRESSED`, `UNAUTHORIZED_SENDER` and `TEMPLATE_OUTPUT_TOO_LARGE` below.

`nextAttemptAt` is set while `status` is `queued`: the earliest time the next delivery attempt can run. After a temporary failure (for example greylisting) it moves out with the retry backoff; it is `null` once the email is sending or done.

The `source` field is the ingress channel the email arrived through: `api` (this REST endpoint) or `smtp` (the SMTP submission server, #120).

---

#### `GET /api/v1/emails`

List emails for the authenticated API key with pagination.

**Query Parameters:**

| Param    | Type   | Default | Description                                  |
|----------|--------|---------|----------------------------------------------|
| `page`   | number | 1       | Page number (1-based, max 1,000,000)         |
| `limit`  | number | 20      | Items per page (1-100)                       |
| `status` | string | none    | Filter: `queued`, `sending`, `sent`, `failed`, `bounced` |
| `source` | string | none    | Filter by ingress channel: `api` or `smtp` (#137) |

---

#### `GET /api/v1/emails/:id`

Get a single email by ID. Scoped to the authenticated API key. Trashed emails are excluded: fetch them via `GET /api/v1/emails/trash`. The response includes `headers`, the custom headers set on the send (`null` when none, #177); list responses carry it too.

---

#### `DELETE /api/v1/emails/:id`

Move an email to trash (soft-delete). The email is automatically purged after `TRASH_RETENTION_DAYS` days unless restored. Returns `404` if not found or not owned by the calling key.

---

#### `POST /api/v1/emails/bulk-delete`

Bulk soft-delete. POST (not DELETE) because some HTTP clients/proxies strip request bodies on DELETE.

Request body:

```json
{ "ids": ["msg_a", "msg_b", "msg_c"] }
```

Response: `{ "success": true, "deleted": 3 }`. Up to 100 ids per call.

---

#### `GET /api/v1/emails/trash`

List emails currently in trash (newest-trashed first), scoped to the authenticated API key. Same pagination params as `GET /api/v1/emails`.

---

#### `POST /api/v1/emails/:id/restore`

Restore a trashed email: clears the deletion marker so it reappears in normal lists. `404` if the email isn't currently in trash.

---

#### `DELETE /api/v1/emails/:id/permanent`

Permanently delete a trashed email immediately. Only works on rows already in trash (protects against bypassing the soft-delete workflow). Irreversible.

---

#### `POST /api/v1/emails/trash/empty`

Permanently delete every trashed email for the calling API key. Returns `{ "success": true, "deleted": <count> }`.

---

#### `GET /api/v1/emails/tombstones`

List the post-purge audit snapshots (#34) of the calling key's hard-deleted emails: identifiers only (`id`, `messageId`, `fromAddress`, `toAddress`, `subject`, `status`, `sentAt`, `deletedAt`, `purgedAt`), never the body. Optional `?messageId=` (wrapped or unwrapped form) to trace a complaint or late bounce. Paginated; kept for `TOMBSTONE_RETENTION_DAYS` (default 90). See [docs/emails.md](emails.md#tombstones-34).

---

#### `GET /api/v1/emails/tombstones/:id`

A single tombstone by the original email id (`msg_...`). `404` when none exists for the calling key.

---

### Domains

All domain endpoints are prefixed with `/api/v1/domains`.

#### `POST /api/v1/domains`

Register a new sender domain. Automatically generates a 2048-bit RSA keypair for DKIM signing.

**Request Body:**

| Field               | Type   | Required | Description                                                                                      |
|---------------------|--------|----------|--------------------------------------------------------------------------------------------------|
| `name`              | string | Yes      | Domain name (e.g. "example.com")                                                                 |
| `unsubscribeEmail`  | string | No       | Mailbox emitted in `List-Unsubscribe: <mailto:...>`. Defaults to `unsubscribe@<name>` if omitted. |
| `unsubscribeUrl`    | string | No       | RFC 8058 one-click endpoint; must start with `https://`. When set, mail also carries `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. Single-recipient mail carries BunMail's own per-recipient `/u/<token>` link instead when `APP_BASE_URL` is `https://` (#249). |
| `notifyEmail`       | string | No       | Address notified when inbound mail is received for this domain (#106). Use an external mailbox. Editable later from the dashboard; empty clears it. |

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "dom_a1b2c3d4e5f6...",
    "name": "example.com",
    "dkimSelector": "bunmail",
    "dkimDnsRecord": "v=DKIM1; k=rsa; p=MIIBIjAN...",
    "spfVerified": false,
    "dkimVerified": false,
    "dmarcVerified": false,
    "verifiedAt": null,
    "unsubscribeEmail": null,
    "unsubscribeUrl": null,
    "createdAt": "2026-03-15T12:00:00.000Z"
  }
}
```

The `unsubscribeEmail` / `unsubscribeUrl` fields shape the `List-Unsubscribe` header BunMail adds to every outbound message sent from this domain. See [docs/emails.md](emails.md#list-unsubscribe) for the resolution rules.

---


The name is stored lowercase (DNS names are case-insensitive), and every lookup by name ignores case, also for domains registered before that. Registering a name that already exists in any case returns `409 DOMAIN_ALREADY_REGISTERED`.

#### `GET /api/v1/domains`

List all registered sender domains.

---

#### `GET /api/v1/domains/:id`

Get a single domain by ID.

---

#### `POST /api/v1/domains/:id/verify`

Trigger DNS verification for SPF, DKIM, and DMARC records.

**Response:**

```json
{
  "success": true,
  "data": { "...updated domain..." },
  "verification": {
    "spf": true,
    "dkim": false,
    "dmarc": true,
    "spfReason": "SPF passes for 203.0.113.10"
  }
}
```

`spf` is true only when the domain publishes exactly one SPF record that gives `pass` for every sending IP of this server (`MAIL_PUBLIC_IP`, or the A/AAAA records of `MAIL_HOSTNAME`), evaluated per RFC 7208 (#247). `spfReason` says why it passed or failed (no record, two records, a placeholder, more than 10 lookups, `fail`/`softfail` for an IP, a temporary DNS failure).

---

#### `PATCH /api/v1/domains/:id`

Edit the domain's `List-Unsubscribe` overrides (#243). Omitted fields stay unchanged; `null` clears one (back to `unsubscribe@<name>`, or no one-click URL).

| Field              | Type           | Required | Description |
|--------------------|----------------|----------|-------------|
| `unsubscribeEmail` | string \| null | No       | Mailbox for `List-Unsubscribe: <mailto:...>` |
| `unsubscribeUrl`   | string \| null | No       | One-click endpoint, `https://` only |

Returns the updated domain, or `404` if it doesn't exist.

---

#### `DELETE /api/v1/domains/:id`

Delete a domain (hard delete).

---

### Templates

All template endpoints are prefixed with `/api/v1/templates`.

#### `POST /api/v1/templates`

Create a new email template.

**Request Body:**

| Field       | Type     | Required | Description                              |
|-------------|----------|----------|------------------------------------------|
| `name`      | string   | Yes      | Human-readable name                      |
| `subject`   | string   | Yes      | Subject template (supports `{{vars}}`)   |
| `html`      | string   | No       | HTML body template (max 5 MB)            |
| `text`      | string   | No       | Plain text body template (max 5 MB)      |
| `variables` | string[] | No       | Variable names (max 100, each `^\w+$`, max 100 chars) |

---

#### `GET /api/v1/templates`

List templates for the authenticated API key.

---

#### `GET /api/v1/templates/:id`

Get a template by ID.

---

#### `PUT /api/v1/templates/:id`

Update a template. Only provided fields are changed.

---

#### `DELETE /api/v1/templates/:id`

Delete a template.

---

### Webhooks

All webhook endpoints are prefixed with `/api/v1/webhooks`.

#### `POST /api/v1/webhooks`

Register a new webhook endpoint.

**Request Body:**

| Field    | Type     | Required | Description                                        |
|----------|----------|----------|----------------------------------------------------|
| `url`    | string   | Yes      | HTTPS endpoint URL                                 |
| `events` | string[] | Yes      | Events to subscribe to (min 1)                     |

Allowed events: `email.queued`, `email.sent`, `email.failed`, `email.bounced`, `email.complained`, `email.received`, `email.unsubscribed` (#249)

Events are delivered only for the requesting key's own emails. `email.received` (inbound mail) is admin-only: a restricted key subscribing to it gets `403` with `code: "INBOUND_EVENTS_REQUIRE_ADMIN"`.

**Response includes `secret`**: shown once, used for HMAC signature verification.

---

#### `GET /api/v1/webhooks`

List webhooks for the authenticated API key. Secrets are not included.

---

#### `DELETE /api/v1/webhooks/:id`

Delete a webhook. Its delivery history is deleted with it.

---

#### `GET /api/v1/webhooks/:id/deliveries`

List the delivery attempts of one of the calling key's webhooks (#30), newest first. Optional `?status=pending|delivered|failed`. Paginated; `404` for a webhook of another key.

---

#### `GET /api/v1/webhooks/deliveries/:deliveryId`

A single delivery with its payload and the last response (status and a 2 KB body preview).

---

#### `POST /api/v1/webhooks/deliveries/:deliveryId/replay`

Replay a delivery: it goes back to `pending` with its attempts reset, and the worker sends it on its next tick. See [docs/webhooks.md](webhooks.md#delivery-behavior).

---

### Inbound

All inbound endpoints are prefixed with `/api/v1/inbound`.

#### `GET /api/v1/inbound`

List received emails (paginated, newest first).

**Query Parameters:**

| Param   | Type   | Default | Description           |
|---------|--------|---------|-----------------------|
| `page`  | number | 1       | Page number (max 1,000,000) |
| `limit` | number | 20      | Items per page (1-100)|

---

#### `GET /api/v1/inbound/:id`

Get a received email by ID. Trashed inbound emails are excluded: fetch them via `GET /api/v1/inbound/trash`.

---

#### `DELETE /api/v1/inbound/:id`

Move an inbound email to trash (soft-delete). Auto-purged after `TRASH_RETENTION_DAYS` days unless restored.

---

#### `POST /api/v1/inbound/bulk-delete`

Bulk soft-delete inbound emails by IDs. Body: `{ "ids": ["inb_a", "inb_b"] }`. Up to 100 per call.

---

#### `GET /api/v1/inbound/trash`

List trashed inbound emails (newest-trashed first). Same pagination params as `GET /api/v1/inbound`.

---

#### `POST /api/v1/inbound/:id/restore`

Restore a trashed inbound email.

---

#### `DELETE /api/v1/inbound/:id/permanent`

Permanently delete a trashed inbound email immediately. Irreversible.

---

#### `POST /api/v1/inbound/trash/empty`

Permanently delete every trashed inbound email. Returns `{ "success": true, "deleted": <count> }`.

---

### DMARC Reports

DMARC aggregate (`rua`) reports parsed from inbound XML attachments. See [docs/dmarc-reports.md](dmarc-reports.md) for the ingest pipeline.

> **Admin-only.** Reports cover every registered domain (sending IPs, volumes, authentication results), so a restricted key gets `403 ADMIN_REQUIRED`, like `/api/v1/domains` and `/api/v1/inbound`.

#### `GET /api/v1/dmarc-reports`

List parsed reports (paginated, newest report-end-date first).

**Query Parameters:**

| Param    | Type   | Default | Description                       |
|----------|--------|---------|-----------------------------------|
| `page`   | number | 1       | Page number (max 1,000,000)       |
| `limit`  | number | 20      | Items per page (1-100)            |
| `domain` | string | none    | Filter by reporting policy domain |

Each row carries the report-level metadata (`orgName`, `orgEmail`, `domain`, `dateBegin`, `dateEnd`, `policyP`, `policyPct`, `receivedAt`). Per-source-IP records are returned only by the detail endpoint.

---

#### `GET /api/v1/dmarc-reports/:id`

Get a single report with its per-source-IP records and computed alignment totals (`messages`, `dkimAligned`, `spfAligned`, `bothAligned`).

---

### API Keys

All API key endpoints are prefixed with `/api/v1/api-keys`.

> **Admin-only (#130).** Every route here requires an **admin** key; a restricted key gets `403 ADMIN_REQUIRED`. The same gate applies to `/api/v1/domains`, `/api/v1/inbound` and `/api/v1/dmarc-reports`. `is_admin` is shown in responses but is **not settable via the API**, only from the dashboard. See [docs/api-keys.md](api-keys.md#admin-vs-restricted-keys-130).

> **Ownership (#219).** Keys, templates, webhooks and domains created through the API belong to the dashboard user who owns the calling key (its `createdByUserId`; `null` = the owner). Key responses carry `createdByUserId` and `disabledReason` (`revoked`, `creator_deactivated`, `creator_removed`, or `null` while active). A key disabled because its user was deactivated or removed, or whose user is deactivated, is rejected with `401` like a revoked one. `POST /api/v1/api-keys` with a calling key whose user is deactivated or gone is refused with `403` and `code: "API_KEY_CREATOR_INACTIVE"`.

#### `POST /api/v1/api-keys`

Create a new API key. The raw key is returned **once**: store it securely.

**Request Body:**

| Field            | Type     | Required | Description                        |
|------------------|----------|----------|------------------------------------|
| `name`           | string   | Yes      | Human-readable label (1-100 chars) |
| `allowedSenders` | string[] | No       | Allowlist of `From` addresses this key may send from (#126). Omit or `[]` = unrestricted. Each must be a valid email; max 100. |

The response includes `allowedSenders`, and `createdByUserId` (the calling key's, #219).

---

#### `GET /api/v1/api-keys`

List all API keys (active and revoked). Key hashes are never exposed.

---

#### `PATCH /api/v1/api-keys/:id`

Update a key's `name` and/or `allowedSenders` (#126). Both optional, only provided fields change. `allowedSenders` **replaces** the whole list (add an address by including it, remove one by omitting it; `[]` clears it back to unrestricted). Returns the serialized key, or `404` if not found.

**Request Body:**

| Field            | Type     | Required | Description                    |
|------------------|----------|----------|--------------------------------|
| `name`           | string   | No       | New label (1-100 chars)        |
| `allowedSenders` | string[] | No       | New allowed-senders list       |

---

#### `DELETE /api/v1/api-keys/:id`

Revoke an API key (soft delete). The key stops working everywhere at once: REST calls, sending over an already-open SMTP submission session, and its webhooks (no further events, queued deliveries are failed).

---

### Suppressions

Per-API-key suppression list: addresses we refuse to send to. See [`docs/suppressions.md`](suppressions.md) for scoping rules, the bounce-handling roadmap, and the schema.

All endpoints are prefixed with `/api/v1/suppressions`.

#### `POST /api/v1/suppressions`

Manually add an address. Idempotent: re-suppressing an existing `(api_key, email)` upserts the row.

**Body:**

```json
{
  "email": "user@example.com",
  "reason": "manual",
  "expiresAt": null
}
```

| Field | Type | Notes |
|---|---|---|
| `email` | string | Required. Validated against the `email` format. |
| `reason` | `"bounce" \| "complaint" \| "manual" \| "unsubscribe"` | Defaults to `"manual"`. |
| `expiresAt` | ISO-8601 datetime or `null` | Optional. `null` (default) = permanent. |

**Response:** the serialized suppression row.

#### `GET /api/v1/suppressions`

Paginated list, scoped to the calling API key.

**Query params:** `page` (default `1`), `limit` (default `20`, max `100`), `email` (optional exact-match filter).

#### `GET /api/v1/suppressions/:id`

Returns a single suppression. 404 if it doesn't exist or belongs to a different key.

#### `DELETE /api/v1/suppressions/:id`

Hard-deletes the suppression. The recipient becomes eligible for sends from this API key immediately.

#### Send-time rejection

When `POST /api/v1/emails/send` is called with a recipient on the suppression list, the response is:

```http
HTTP/1.1 422 Unprocessable Entity

{
  "success": false,
  "error": "Recipient is on the suppression list. Remove the suppression first if this is intentional.",
  "code": "RECIPIENT_SUPPRESSED",
  "suppressionId": "sup_a1b2c3..."
}
```

No row is inserted into `emails`, no queue entry is created.

### SMTP Submission

Usage stats + quota status for the SMTP **submission** server (#120/#123): the AUTH-required SMTP listener that lets apps send *through* BunMail. The server itself has no HTTP routes; this is the one read-only REST surface. Full setup: [`docs/smtp-submission.md`](smtp-submission.md).

#### `GET /api/v1/smtp-submission/stats`

Per-day accepted/rejected counts for messages the calling API key sent via SMTP submission, plus the key's daily-quota status. Scoped to the calling key.

**Query Parameters:**

| Param  | Type   | Default | Description                                      |
|--------|--------|---------|--------------------------------------------------|
| `days` | number | 30      | Trailing UTC-day window (inclusive of today), 1 to 365 |

**Response:**

```json
{
  "success": true,
  "data": {
    "window": { "days": 30 },
    "quota": { "daily": 1000, "usedToday": 42, "remaining": 958 },
    "totals": { "accepted": 1234, "rejected": 7 },
    "daily": [{ "day": "2026-07-19", "accepted": 42, "rejected": 0 }]
  }
}
```

`quota.daily` and `quota.remaining` are `null` when quotas are disabled (`SMTP_SUBMISSION_DAILY_QUOTA=0`). Days with no activity are omitted from `daily`.

## Error Response Format

All error responses follow this shape:

```json
{
  "success": false,
  "error": "Human-readable error message"
}
```

Some responses carry additional structured fields: e.g. suppression-list rejection is `422` with `code: "RECIPIENT_SUPPRESSED"` + `suppressionId` (pivot to `DELETE /api/v1/suppressions/:id`); a sender-authorization rejection (#126) is `403` with `code: "UNAUTHORIZED_SENDER"` + `sender` (the `From` that was rejected: add it to the key's `allowedSenders` via `PATCH /api/v1/api-keys/:id` if intended).

| Status | Meaning                                         |
|--------|-------------------------------------------------|
| 400    | Malformed request body, e.g. invalid JSON (`INVALID_BODY`) |
| 401    | Missing or invalid token, or the sending key was revoked (`API_KEY_REVOKED`) |
| 403    | Authenticated but not permitted: `From` not in the key's allowed-senders list (`UNAUTHORIZED_SENDER`), or a restricted key calling an admin-only endpoint (`ADMIN_REQUIRED`, #130), or a restricted key subscribing a webhook to `email.received` (`INBOUND_EVENTS_REQUIRE_ADMIN`), or creating an API key with a key whose dashboard user is deactivated or removed (`API_KEY_CREATOR_INACTIVE`, #219) |
| 404    | Resource not found, or a send's `templateId` is not a template of the calling key (`TEMPLATE_NOT_FOUND`, #245) |
| 413    | Request body larger than 12 MB (rejected before it is read) |
| 422    | Validation error: `VALIDATION_ERROR` with `details: [{ path, message }]` (the submitted values are never echoed), a webhook URL rejected by the SSRF guard (`WEBHOOK_URL_BLOCKED`, #128), a rendered template over its size limit (`TEMPLATE_OUTPUT_TOO_LARGE`), or a send refused on its sender or subject (#245): `SENDER_DOMAIN_NOT_REGISTERED`, `SENDER_DOMAIN_UNVERIFIED` (`REQUIRE_VERIFIED_DOMAIN=true`) or `SUBJECT_REQUIRED`, or on a custom header (`INVALID_CUSTOM_HEADER`, #177) |
| 409    | `DOMAIN_ALREADY_REGISTERED`: `POST /api/v1/domains` with a name already registered, compared case-insensitively |
| 429    | Rate limit exceeded                             |
