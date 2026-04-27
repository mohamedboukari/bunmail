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
| `status` | string | —       | Filter: `queued`, `sending`, `sent`, `failed`|

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

| Field  | Type   | Required | Description                          |
|--------|--------|----------|--------------------------------------|
| `name` | string | Yes      | Domain name (e.g. "example.com")     |

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
    "createdAt": "2026-03-15T12:00:00.000Z"
  }
}
```

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

### API Keys

All API key endpoints are prefixed with `/api/v1/api-keys`.

#### `POST /api/v1/api-keys`

Create a new API key. The raw key is returned **once** — store it securely.

**Request Body:**

| Field  | Type   | Required | Description                        |
|--------|--------|----------|------------------------------------|
| `name` | string | Yes      | Human-readable label (1-100 chars) |

---

#### `GET /api/v1/api-keys`

List all API keys (active and revoked). Key hashes are never exposed.

---

#### `DELETE /api/v1/api-keys/:id`

Revoke an API key (soft delete).

---

## Error Response Format

All error responses follow this shape:

```json
{
  "success": false,
  "error": "Human-readable error message"
}
```

| Status | Meaning                  |
|--------|--------------------------|
| 401    | Missing or invalid token |
| 404    | Resource not found       |
| 422    | Validation error         |
| 429    | Rate limit exceeded      |
