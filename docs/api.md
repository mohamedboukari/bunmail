# BunMail API Reference

Base URL: `http://localhost:3000`

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
  "timestamp": "2026-03-03T12:00:00.000Z"
}
```

---

### Emails

All email endpoints are prefixed with `/api/v1/emails`.

#### `POST /api/v1/emails/send`

Queue a new email for delivery. The email is inserted into the database with status `queued` and processed asynchronously by the queue worker.

**Auth:** Required (Bearer token)

**Request Body:**

| Field     | Type   | Required | Description                          |
|-----------|--------|----------|--------------------------------------|
| `from`    | string | Yes      | Sender email address                 |
| `to`      | string | Yes      | Recipient email address              |
| `subject` | string | Yes      | Email subject line                   |
| `html`    | string | No       | HTML body                            |
| `text`    | string | No       | Plain text body (fallback)           |
| `cc`      | string | No       | Comma-separated CC recipients        |
| `bcc`     | string | No       | Comma-separated BCC recipients       |

**Response (201):**

```json
{
  "success": true,
  "data": {
    "id": "msg_a1b2c3d4e5f6...",
    "from": "hello@example.com",
    "to": "user@example.com",
    "cc": null,
    "bcc": null,
    "subject": "Welcome!",
    "html": "<h1>Hello</h1>",
    "text": "Hello",
    "status": "queued",
    "attempts": 0,
    "lastError": null,
    "messageId": null,
    "sentAt": null,
    "createdAt": "2026-03-03T12:00:00.000Z"
  }
}
```

**Errors:**

| Status | Description               |
|--------|---------------------------|
| 401    | Missing or invalid token  |
| 422    | Validation error          |
| 429    | Rate limit exceeded       |

---

#### `GET /api/v1/emails`

List emails for the authenticated API key with pagination.

**Auth:** Required (Bearer token)

**Query Parameters:**

| Param    | Type   | Default | Description                                  |
|----------|--------|---------|----------------------------------------------|
| `page`   | number | 1       | Page number (1-based)                        |
| `limit`  | number | 20      | Items per page (1-100)                       |
| `status` | string | —       | Filter: `queued`, `sending`, `sent`, `failed`|

**Response (200):**

```json
{
  "success": true,
  "data": [ /* array of serialized emails */ ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 42
  }
}
```

---

#### `GET /api/v1/emails/:id`

Get a single email by ID. Scoped to the authenticated API key — users can only view emails they created.

**Auth:** Required (Bearer token)

**Response (200):**

```json
{
  "success": true,
  "data": { /* serialized email */ }
}
```

**Errors:**

| Status | Description                         |
|--------|-------------------------------------|
| 401    | Missing or invalid token            |
| 404    | Email not found (or not owned)      |

---

### API Keys

All API key endpoints are prefixed with `/api/v1/api-keys`.

#### `POST /api/v1/api-keys`

Create a new API key. The raw key is returned **once** — store it securely.

**Auth:** Required (Bearer token)

**Request Body:**

| Field  | Type   | Required | Description                        |
|--------|--------|----------|------------------------------------|
| `name` | string | Yes      | Human-readable label (1-100 chars) |

**Response (200):**

```json
{
  "success": true,
  "data": {
    "id": "key_a1b2c3d4e5f6...",
    "name": "Production Key",
    "keyPrefix": "bm_live_a1b2",
    "isActive": true,
    "lastUsedAt": null,
    "createdAt": "2026-03-03T12:00:00.000Z",
    "key": "bm_live_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"
  }
}
```

> The `key` field is only present in the creation response. It cannot be retrieved again.

---

#### `GET /api/v1/api-keys`

List all API keys (active and revoked). Key hashes are never exposed.

**Auth:** Required (Bearer token)

**Response (200):**

```json
{
  "success": true,
  "data": [
    {
      "id": "key_a1b2c3d4e5f6...",
      "name": "Production Key",
      "keyPrefix": "bm_live_a1b2",
      "isActive": true,
      "lastUsedAt": "2026-03-03T12:00:00.000Z",
      "createdAt": "2026-03-03T12:00:00.000Z"
    }
  ]
}
```

---

#### `DELETE /api/v1/api-keys/:id`

Revoke an API key (soft delete). Sets `is_active` to false — the key stays in the DB for audit but stops working for authentication.

**Auth:** Required (Bearer token)

**Response (200):**

```json
{
  "success": true,
  "data": {
    "id": "key_a1b2c3d4e5f6...",
    "name": "Production Key",
    "keyPrefix": "bm_live_a1b2",
    "isActive": false,
    "lastUsedAt": "2026-03-03T12:00:00.000Z",
    "createdAt": "2026-03-03T12:00:00.000Z"
  }
}
```

**Errors:**

| Status | Description        |
|--------|--------------------|
| 401    | Invalid token      |
| 404    | API key not found  |

---

## Error Response Format

All error responses follow this shape:

```json
{
  "success": false,
  "error": "Human-readable error message"
}
```

---

### Domains

All domain endpoints are prefixed with `/api/v1/domains`.

#### `POST /api/v1/domains`

Register a new sender domain. DKIM key generation and DNS verification will be added in a future release.

**Auth:** Required (Bearer token)

**Request Body:**

| Field  | Type   | Required | Description                          |
|--------|--------|----------|--------------------------------------|
| `name` | string | Yes      | Domain name (e.g. "example.com")     |

**Response (200):**

```json
{
  "success": true,
  "data": {
    "id": "dom_a1b2c3d4e5f6...",
    "name": "example.com",
    "dkimSelector": "bunmail",
    "spfVerified": false,
    "dkimVerified": false,
    "dmarcVerified": false,
    "verifiedAt": null,
    "createdAt": "2026-03-03T12:00:00.000Z"
  }
}
```

---

#### `GET /api/v1/domains`

List all registered sender domains.

**Auth:** Required (Bearer token)

**Response (200):**

```json
{
  "success": true,
  "data": [ /* array of serialized domains */ ]
}
```

---

#### `GET /api/v1/domains/:id`

Get a single domain by ID.

**Auth:** Required (Bearer token)

**Response (200):**

```json
{
  "success": true,
  "data": { /* serialized domain */ }
}
```

**Errors:**

| Status | Description        |
|--------|--------------------|
| 401    | Invalid token      |
| 404    | Domain not found   |

---

#### `DELETE /api/v1/domains/:id`

Delete a domain (hard delete).

**Auth:** Required (Bearer token)

**Response (200):**

```json
{
  "success": true,
  "data": { /* deleted domain */ }
}
```

**Errors:**

| Status | Description        |
|--------|--------------------|
| 401    | Invalid token      |
| 404    | Domain not found   |

---

## Error Response Format

All error responses follow this shape:

```json
{
  "success": false,
  "error": "Human-readable error message"
}
```

## OpenAPI

An OpenAPI 3.1 specification will be added in a future release for programmatic API consumption and client generation.
