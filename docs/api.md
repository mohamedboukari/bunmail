# BunMail API Reference

Base URL: `http://localhost:3000`

## OpenAPI Specification

BunMail exposes an auto-generated OpenAPI 3.0 spec:

- **Interactive docs (Scalar):** `GET /api/docs`
- **Raw JSON spec:** `GET /api/docs/json`

## Authentication

All endpoints (except `/health`) require a Bearer token in the `Authorization` header:

```
Authorization: Bearer bm_live_<your-api-key>
```

API keys are managed via the `/api/v1/api-keys` endpoints. The first key is created using the seed script (`bun run src/db/seed.ts`).

> **Sending over SMTP instead of REST?** Besides this HTTP API, BunMail can run an SMTP **submission** server (#120) so apps that only speak SMTP send *through* BunMail — the same `bm_live_…` key is used as the SMTP password. It has no REST endpoints of its own; see [docs/smtp-submission.md](smtp-submission.md).

## Rate Limiting

- **Limit:** 100 requests per 60-second sliding window per API key
- **Scope:** Per API key ID (not per IP)
- **Response on exceed:** `429 Too Many Requests` with `Retry-After` header (seconds)

---

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
| `templateId` | string | No       | Template ID (overrides subject/html/text)    |
| `variables`  | object | No       | Key-value pairs for template rendering       |

Oversize bodies return `422 Unprocessable Entity` from the validation layer.

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
    "attempts": 0,
    "createdAt": "2026-03-15T12:00:00.000Z"
  }
}
```

---

#### `GET /api/v1/emails`

List emails for the authenticated API key with pagination.

**Query Parameters:**

| Param    | Type   | Default | Description                                  |
|----------|--------|---------|----------------------------------------------|
| `page`   | number | 1       | Page number (1-based)                        |
| `limit`  | number | 20      | Items per page (1-100)                       |
| `status` | string | —       | Filter: `queued`, `sending`, `sent`, `failed`, `bounced` |

---

#### `GET /api/v1/emails/:id`

Get a single email by ID. Scoped to the authenticated API key. Trashed emails are excluded — fetch them via `GET /api/v1/emails/trash`.

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

Restore a trashed email — clears the deletion marker so it reappears in normal lists. `404` if the email isn't currently in trash.

---

#### `DELETE /api/v1/emails/:id/permanent`

Permanently delete a trashed email immediately. Only works on rows already in trash (protects against bypassing the soft-delete workflow). Irreversible.

---

#### `POST /api/v1/emails/trash/empty`

Permanently delete every trashed email for the calling API key. Returns `{ "success": true, "deleted": <count> }`.

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
| `unsubscribeUrl`    | string | No       | RFC 8058 one-click HTTPS endpoint. When set, mail also carries `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. |
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
    "dmarc": true
  }
}
```

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
| `html`      | string   | No       | HTML body template                       |
| `text`      | string   | No       | Plain text body template                 |
| `variables` | string[] | No       | List of variable names for documentation |

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

Allowed events: `email.queued`, `email.sent`, `email.failed`, `email.bounced`, `email.complained`, `email.received`

**Response includes `secret`** — shown once, used for HMAC signature verification.

---

#### `GET /api/v1/webhooks`

List webhooks for the authenticated API key. Secrets are not included.

---

#### `DELETE /api/v1/webhooks/:id`

Delete a webhook.

---

### Inbound

All inbound endpoints are prefixed with `/api/v1/inbound`.

#### `GET /api/v1/inbound`

List received emails (paginated, newest first).

**Query Parameters:**

| Param   | Type   | Default | Description           |
|---------|--------|---------|-----------------------|
| `page`  | number | 1       | Page number           |
| `limit` | number | 20      | Items per page (1-100)|

---

#### `GET /api/v1/inbound/:id`

Get a received email by ID. Trashed inbound emails are excluded — fetch them via `GET /api/v1/inbound/trash`.

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

#### `GET /api/v1/dmarc-reports`

List parsed reports (paginated, newest report-end-date first).

**Query Parameters:**

| Param    | Type   | Default | Description                       |
|----------|--------|---------|-----------------------------------|
| `page`   | number | 1       | Page number                       |
| `limit`  | number | 20      | Items per page (1-100)            |
| `domain` | string | —       | Filter by reporting policy domain |

Each row carries the report-level metadata (`orgName`, `orgEmail`, `domain`, `dateBegin`, `dateEnd`, `policyP`, `policyPct`, `receivedAt`). Per-source-IP records are returned only by the detail endpoint.

---

#### `GET /api/v1/dmarc-reports/:id`

Get a single report with its per-source-IP records and computed alignment totals (`messages`, `dkimAligned`, `spfAligned`, `bothAligned`).

---

### API Keys

All API key endpoints are prefixed with `/api/v1/api-keys`.

#### `POST /api/v1/api-keys`

Create a new API key. The raw key is returned **once** — store it securely.

**Request Body:**

| Field            | Type     | Required | Description                        |
|------------------|----------|----------|------------------------------------|
| `name`           | string   | Yes      | Human-readable label (1-100 chars) |
| `allowedSenders` | string[] | No       | Allowlist of `From` addresses this key may send from (#126). Omit or `[]` = unrestricted. Each must be a valid email; max 100. |

The response includes `allowedSenders`.

---

#### `GET /api/v1/api-keys`

List all API keys (active and revoked). Key hashes are never exposed.

---

#### `PATCH /api/v1/api-keys/:id`

Update a key's `name` and/or `allowedSenders` (#126). Both optional — only provided fields change. `allowedSenders` **replaces** the whole list (add an address by including it, remove one by omitting it; `[]` clears it back to unrestricted). Returns the serialized key, or `404` if not found.

**Request Body:**

| Field            | Type     | Required | Description                    |
|------------------|----------|----------|--------------------------------|
| `name`           | string   | No       | New label (1-100 chars)        |
| `allowedSenders` | string[] | No       | New allowed-senders list       |

---

#### `DELETE /api/v1/api-keys/:id`

Revoke an API key (soft delete).

---

### Suppressions

Per-API-key suppression list — addresses we refuse to send to. See [`docs/suppressions.md`](suppressions.md) for scoping rules, the bounce-handling roadmap, and the schema.

All endpoints are prefixed with `/api/v1/suppressions`.

#### `POST /api/v1/suppressions`

Manually add an address. Idempotent — re-suppressing an existing `(api_key, email)` upserts the row.

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

Usage stats + quota status for the SMTP **submission** server (#120/#123) — the AUTH-required SMTP listener that lets apps send *through* BunMail. The server itself has no HTTP routes; this is the one read-only REST surface. Full setup: [`docs/smtp-submission.md`](smtp-submission.md).

#### `GET /api/v1/smtp-submission/stats`

Per-day accepted/rejected counts for messages the calling API key sent via SMTP submission, plus the key's daily-quota status. Scoped to the calling key.

**Query Parameters:**

| Param  | Type   | Default | Description                                      |
|--------|--------|---------|--------------------------------------------------|
| `days` | number | 30      | Trailing UTC-day window (inclusive of today), 1–365 |

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

Some responses carry additional structured fields — e.g. suppression-list rejection is `422` with `code: "RECIPIENT_SUPPRESSED"` + `suppressionId` (pivot to `DELETE /api/v1/suppressions/:id`); a sender-authorization rejection (#126) is `403` with `code: "UNAUTHORIZED_SENDER"` + `sender` (the `From` that was rejected — add it to the key's `allowedSenders` via `PATCH /api/v1/api-keys/:id` if intended).

| Status | Meaning                                         |
|--------|-------------------------------------------------|
| 401    | Missing or invalid token                        |
| 403    | Authenticated but not permitted (e.g. `From` not in the key's allowed-senders list) |
| 404    | Resource not found                              |
| 422    | Validation error                                |
| 429    | Rate limit exceeded                             |
