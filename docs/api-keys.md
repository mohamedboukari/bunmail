# API Keys Module

Manages API key lifecycle: creation, listing, and revocation. API keys authenticate all REST API requests via Bearer tokens.

## Auth Flow

```
Client                     Server
  |                          |
  |  Authorization: Bearer   |
  |  bm_live_abc123...       |
  |:, > |
  |                          | 1. Extract token from header
  |                          | 2. SHA-256 hash the token
  |                          | 3. SELECT from api_keys WHERE key_hash = <hash>
  |                          | 4. Check is_active = true
  |                          | 5. Update last_used_at (fire-and-forget)
  |                          | 6. Inject apiKeyId into request context
  |  200 OK (or 401)         |
  | <:, |
```

- The raw key is **never stored**, only its SHA-256 hash lives in the database.
- The key prefix (first 12 chars) is stored for identification (e.g. `bm_live_a1b2`).
- The first API key is created via the seed script: `bun run src/db/seed.ts`.

## Rate Limiting

- **Algorithm:** Fixed-window counter per API key ID
- **Limit:** 100 requests per 60 seconds by default, set with `API_RATE_LIMIT_MAX` / `API_RATE_LIMIT_WINDOW`
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
| `is_admin`    | boolean        | NOT NULL, default false | Admin (management-plane) vs restricted / send-only (#130). Operator-set only. |
| `allowed_senders` | jsonb      | NOT NULL, default `[]` | Allowlist of `From` addresses this key may send from (#126). Empty = unrestricted. |
| `last_used_at`| timestamp      | nullable             | Updated on each successful auth           |
| `created_at`  | timestamp      | NOT NULL, default now | Creation timestamp                       |
| `created_by_user_id` | varchar(36) | nullable, FK `users(id)` ON DELETE SET NULL, indexed | The dashboard user the key belongs to (#219). NULL = the owner. |
| `disabled_reason` | varchar(20) | nullable, CHECK `revoked` / `creator_deactivated` / `creator_removed` | Why an inactive key is inactive (#219). NULL on active keys and on keys revoked before #219. |

## Module Layout

```
src/modules/api-keys/
├── api-keys.plugin.ts              ← Routes: POST /, GET /, PATCH /:id, DELETE /:id
├── models/
│   └── api-key.schema.ts           ← Drizzle pgTable definition
├── dtos/
│   └── create-api-key.dto.ts       ← Elysia t.Object validation
├── services/
│   └── api-key.service.ts          ← Business logic (CRUD + hash lookup)
├── serializations/
│   └── api-key.serialization.ts    ← Response mapper (hides keyHash)
└── types/
    └── api-key.types.ts            ← ApiKey, CreateApiKeyInput, KeyActor, API_KEY_DISABLED_REASONS
```

## Service Methods

`KeyActor` (`{ id, role }`, #219) is the signed-in dashboard account. The dashboard passes it to every call below; the REST management plane (admin keys) passes none and sees every key.

### `createApiKey(input: CreateApiKeyInput, actor?: KeyActor): Promise<{ apiKey: ApiKey; rawKey: string }>`

Creates a new API key. Generates `bm_live_<32 hex>`, hashes with SHA-256, stores the hash, and returns the raw key (shown once). `input.allowedSenders` (optional) sets the sender allowlist (normalised lower-case/deduped; defaults to `[]` = unrestricted). With an `actor`, the key belongs to that user and a member's key is always restricted (`input.isAdmin` is ignored). Without one, `input.createdByUserId` is recorded (REST: the calling key's creator).

### `updateApiKey(id, input: UpdateApiKeyInput, actor?: KeyActor): Promise<ApiKey | undefined>`

Updates a key's `name` and/or `allowedSenders` (#126). `allowedSenders` uses **replace** semantics: the caller sends the full desired list (add = include an address, remove = omit it). Returns the updated row, or `undefined` if the key doesn't exist, or (member `actor`) is not the member's own.

### `listApiKeys(actor?: KeyActor): Promise<ApiKey[]>`

Returns all API keys (active and revoked), or a member `actor`'s own keys. The serializer strips `keyHash` before sending to the client.

### `revokeApiKey(id: string, actor?: KeyActor): Promise<ApiKey | undefined>`

Sets `is_active` to false for the given key ID and records `disabled_reason = 'revoked'` (an earlier reason is kept). Returns the updated row, or undefined if not found (or, member `actor`, not its own).

What revocation cuts off: REST calls (`401` from `authMiddleware`), sending through `createEmail` (`InactiveApiKeyError`, which also stops an SMTP submission session that authenticated before the revocation, at its next message), and the key's webhooks: dispatch and the delivery worker skip webhooks whose key is inactive, so deliveries already queued for them end at `failed`. The key's webhooks stay listed; delete them from the dashboard if they are no longer needed.

### `findByHash(hash: string): Promise<ApiKey | undefined>`

Looks up an API key by its SHA-256 hash (SMTP submission AUTH). A key whose creator is deactivated is treated as unknown (#219).

### `findDashboardKeyFor(actor: KeyActor): Promise<ApiKey | undefined>`

The key a dashboard template or webhook create attaches to (#219): the actor's own oldest active key; for admins and the owner, otherwise the oldest active key of anyone.

### `setApiKeyAdmin(id, isAdmin): Promise<SetApiKeyAdminResult>`

Dashboard-only admin toggle. Returns `{ ok: true, apiKey }`, or `{ ok: false, reason: "not_found" | "creator_not_admin" }` when a promotion is refused (see above).

### `findById(id: string): Promise<ApiKey | undefined>`

Looks up an API key by ID. Used by the `createEmail` allowed-senders gate (#126) and by `updateApiKey`.

## Keys belong to users (#219)

Every key records the dashboard user it belongs to in `created_by_user_id`: whoever created it in the dashboard, or, for a key created through `POST /api/v1/api-keys`, the creator of the calling key. NULL means the owner: keys from before accounts existed are assigned to the owner at boot (the owner bootstrap, see [users.md](users.md)).

- **Members** see and manage only their own keys on the API keys page: create (always restricted: the admin checkbox is hidden and ignored server-side), set allowed senders, revoke. Anyone else's key answers "not found", exactly like a key that does not exist; the admin toggle is admin-only (403).
- **Admins and the owner** see every key with its creator, create admin keys and toggle admin.
- **Deactivating** a user disables every active key they created (`disabled_reason = 'creator_deactivated'`); **removing** one disables them (`creator_removed`) before the delete sets `created_by_user_id` to NULL. **Reactivating** a user does not re-enable their keys: they create new ones. The page shows why a key is disabled. A disabled key is rejected like a revoked one (`401` at the auth middleware, `InactiveApiKeyError` in `createEmail`).
- **Demoting** an admin to member makes every admin key it created restricted (`is_admin = false`) in the same transaction; the keys stay active, so their sending keeps working, and a later promotion restores none. Logged as `adminKeysDowngraded` on `Account role changed`.
- On the dashboard **send page** a member picks only from its own active keys; a crafted `apiKeyId` of any other key (an admin's, the owner's, another member's) gets the "Selected API key is not available" error flash and nothing is sent. Admins and the owner pick any active key.
- An **ownership transfer** never moves keys: a key stays attributed to the account that created it (and may hold its secret), so demoting, deactivating or removing the former owner later still reaches its admin keys.
- **Promotion** (`setApiKeyAdmin(id, true)`) is one conditional `UPDATE`: it applies only to a key with no creator or whose creator is an active admin or the owner (`... AND (created_by_user_id IS NULL OR EXISTS (SELECT 1 FROM users WHERE id = api_keys.created_by_user_id AND role IN ('admin','owner') AND disabled_at IS NULL))`), so it cannot race a demotion. A member's key is refused (flash) and gets no **Make admin** button.
- **Creation** with a creator runs in a transaction that reads the creator's row `FOR SHARE` (it conflicts with the account actions' row locks): a missing or deactivated creator is refused (`ApiKeyCreatorInactiveError`, REST `403 API_KEY_CREATOR_INACTIVE`), and `is_admin` is granted only when asked for and the creator's live role is admin or owner.
- The auth middleware and the SMTP submission lookup (`findByHash`) reject a key whose creator exists and is deactivated, even if `is_active` were still true. A key with no creator is unaffected.
- Dashboard template and webhook creates attach to the user's own oldest active key (`findDashboardKeyFor`); admins and the owner fall back to the oldest active key of anyone; a member without a key of its own gets "Create an API key first".

**Upgrade note.** Keys created before #219 are attributed to the owner. After inviting other accounts, **rotate any admin key that was shared** with them: demoting, deactivating or removing an account only reaches the keys that account created, never a shared owner key.

## Admin vs. restricted keys (#130)

API keys come in two tiers:

- **Admin**, may call the **management plane**: `/api/v1/api-keys`, `/api/v1/domains`, `/api/v1/inbound`. Full operator-level API access.
- **Restricted** (the default for API-created keys) is **send-only + own data**: send email, and read/manage its own emails, suppressions, templates, webhooks, and submission stats. Calling a management-plane endpoint returns **HTTP 403** with `{ code: "ADMIN_REQUIRED" }`.

This is what makes the allowed-senders allowlist (#126) actually enforceable: without it, a "restricted" key could simply `PATCH` its own `allowedSenders` back to empty (re-enabling spoofing), read all inbound mail, or mint new keys. Restricting the management plane closes that.

**`is_admin` is operator-only.** It is settable **only from the dashboard** by admins and the owner (#219), a checkbox on the create form and a per-key **Make admin / Make restricted** toggle, plus the seed script. It appears in **no REST request body** (neither `POST` nor `PATCH /api/v1/api-keys/:id`), so an API caller (even an admin key) can never grant admin. `setApiKeyAdmin()` is the only mutation path and is dashboard-only.

**Migration note:** existing keys were backfilled to **admin** (`is_admin = true`) so nothing breaks on upgrade. After deploying, **demote any key you hand to an app or developer** to restricted from the dashboard. New API-created keys default to restricted. The seed/bootstrap key is admin.

## Allowed senders (anti-spoofing, #126)

By default a key can send `From:` any address on any registered domain. Because BunMail DKIM-signs outbound mail, that means a key handed to a developer could send convincingly as `ceo@company.com`. To prevent this, give the key an **allowed-senders** allowlist:

- Set `allowedSenders: ["noreply@company.com", "orders@company.com"]` on `POST /api/v1/api-keys`, or in the dashboard's chip editor.
- When non-empty, any send whose `From` isn't on the list is rejected, **HTTP 403 `UNAUTHORIZED_SENDER`** (REST) or **SMTP 550** (submission), before anything is queued. Matching is case-insensitive.
- Empty list = unrestricted (default; existing keys unchanged).
- Enforced at the `createEmail` gate, so it applies to both the REST send API and the SMTP submission server.
- Edit the list any time with `PATCH /api/v1/api-keys/:id` or the dashboard editor.

## Related Files

- `src/utils/crypto.ts`: `hashApiKey()` and `generateApiKey()` functions
- `src/middleware/auth.ts`: Bearer token validation middleware
- `src/middleware/rate-limit.ts`: Per-key rate limiting middleware
- `src/db/seed.ts`: Creates the initial development API key
