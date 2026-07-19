# API Keys Module

Manages API key lifecycle — creation, listing, and revocation. API keys authenticate all REST API requests via Bearer tokens.

## Auth Flow

```
Client                     Server
  |                          |
  |  Authorization: Bearer   |
  |  bm_live_abc123...       |
  | ———————————————————————> |
  |                          | 1. Extract token from header
  |                          | 2. SHA-256 hash the token
  |                          | 3. SELECT from api_keys WHERE key_hash = <hash>
  |                          | 4. Check is_active = true
  |                          | 5. Update last_used_at (fire-and-forget)
  |                          | 6. Inject apiKeyId into request context
  |  200 OK (or 401)         |
  | <——————————————————————— |
```

- The raw key is **never stored** — only its SHA-256 hash lives in the database.
- The key prefix (first 12 chars) is stored for identification (e.g. `bm_live_a1b2`).
- The first API key is created via the seed script: `bun run src/db/seed.ts`.

## Rate Limiting

- **Algorithm:** Fixed-window counter per API key ID
- **Limit:** 100 requests per 60 seconds
- **Storage:** In-memory `Map` (resets on server restart)
- **Response:** `429 Too Many Requests` with `Retry-After` header

## Schema

**Table:** `api_keys`

| Column        | Type           | Constraints          | Description                               |
|---------------|----------------|----------------------|-------------------------------------------|
| `id`          | varchar(36)    | PK                   | Prefixed ID (`key_<24 hex>`)              |
| `name`        | varchar(100)   | NOT NULL             | Human-readable label                      |
| `key_hash`    | varchar(255)   | NOT NULL, UNIQUE     | SHA-256 hash of raw key                   |
| `key_prefix`  | varchar(12)    | NOT NULL             | First 12 chars of raw key                 |
| `is_active`   | boolean        | NOT NULL, default true | Soft-delete flag                        |
| `allowed_senders` | jsonb      | NOT NULL, default `[]` | Allowlist of `From` addresses this key may send from (#126). Empty = unrestricted. |
| `last_used_at`| timestamp      | nullable             | Updated on each successful auth           |
| `created_at`  | timestamp      | NOT NULL, default now | Creation timestamp                       |

## Module Layout

```
src/modules/api-keys/
├── api-keys.plugin.ts              ← Routes: POST /, GET /, DELETE /:id
├── models/
│   └── api-key.schema.ts           ← Drizzle pgTable definition
├── dtos/
│   └── create-api-key.dto.ts       ← Elysia t.Object validation
├── services/
│   └── api-key.service.ts          ← Business logic (CRUD + hash lookup)
├── serializations/
│   └── api-key.serialization.ts    ← Response mapper (hides keyHash)
└── types/
    └── api-key.types.ts            ← ApiKey, CreateApiKeyInput
```

## Service Methods

### `createApiKey(input: CreateApiKeyInput): Promise<{ apiKey: ApiKey; rawKey: string }>`

Creates a new API key. Generates `bm_live_<32 hex>`, hashes with SHA-256, stores the hash, and returns the raw key (shown once). `input.allowedSenders` (optional) sets the sender allowlist (normalised lower-case/deduped; defaults to `[]` = unrestricted).

### `updateApiKey(id, input: UpdateApiKeyInput): Promise<ApiKey | undefined>`

Updates a key's `name` and/or `allowedSenders` (#126). `allowedSenders` uses **replace** semantics — the caller sends the full desired list (add = include an address, remove = omit it). Returns the updated row, or `undefined` if the key doesn't exist.

### `listApiKeys(): Promise<ApiKey[]>`

Returns all API keys (active and revoked). The serializer strips `keyHash` before sending to the client.

### `revokeApiKey(id: string): Promise<ApiKey | undefined>`

Sets `is_active` to false for the given key ID. Returns the updated row or undefined if not found.

### `findByHash(hash: string): Promise<ApiKey | undefined>`

Looks up an API key by its SHA-256 hash. Used internally by the auth middleware.

### `findById(id: string): Promise<ApiKey | undefined>`

Looks up an API key by ID. Used by the `createEmail` allowed-senders gate (#126) and by `updateApiKey`.

## Allowed senders (anti-spoofing, #126)

By default a key can send `From:` any address on any registered domain. Because BunMail DKIM-signs outbound mail, that means a key handed to a developer could send convincingly as `ceo@company.com`. To prevent this, give the key an **allowed-senders** allowlist:

- Set `allowedSenders: ["noreply@company.com", "orders@company.com"]` on `POST /api/v1/api-keys`, or in the dashboard's chip editor.
- When non-empty, any send whose `From` isn't on the list is rejected — **HTTP 403 `UNAUTHORIZED_SENDER`** (REST) or **SMTP 550** (submission) — before anything is queued. Matching is case-insensitive.
- Empty list = unrestricted (default; existing keys unchanged).
- Enforced at the `createEmail` gate, so it applies to both the REST send API and the SMTP submission server.
- Edit the list any time with `PATCH /api/v1/api-keys/:id` or the dashboard editor.

## Related Files

- `src/utils/crypto.ts` — `hashApiKey()` and `generateApiKey()` functions
- `src/middleware/auth.ts` — Bearer token validation middleware
- `src/middleware/rate-limit.ts` — Per-key rate limiting middleware
- `src/db/seed.ts` — Creates the initial development API key
