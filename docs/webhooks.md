# Webhooks Module

Sends real-time event notifications to registered HTTP endpoints when email status changes.

## Module Layout

```
src/modules/webhooks/
├── webhooks.plugin.ts               ← Elysia plugin (route group)
├── services/
│   ├── webhook.service.ts           ← CRUD operations
│   └── webhook-dispatch.service.ts  ← Event delivery with retries
├── dtos/
│   └── create-webhook.dto.ts        ← POST body validation
├── models/
│   └── webhook.schema.ts            ← Drizzle pgTable definition
├── serializations/
│   └── webhook.serialization.ts     ← Strips signing secret from responses
└── types/
    └── webhook.types.ts             ← Webhook, CreateWebhookInput, WebhookEventType
```

## Database Schema

Table: `webhooks`

| Column      | Type           | Constraints                  |
|-------------|----------------|------------------------------|
| id          | varchar(36)    | PK, prefixed `whk_`         |
| api_key_id  | varchar(36)    | FK → api_keys, NOT NULL      |
| url         | text           | NOT NULL                     |
| events      | jsonb          | NOT NULL, default `[]`       |
| secret      | varchar(64)    | NOT NULL                     |
| is_active   | boolean        | NOT NULL, default `true`     |
| created_at  | timestamp      | NOT NULL, default `now()`    |
| updated_at  | timestamp      | NOT NULL, default `now()`    |

## Event Types

| Event           | Fired when                          |
|-----------------|-------------------------------------|
| `email.queued`  | An email is inserted into the queue |
| `email.sent`    | An email is successfully delivered  |
| `email.failed`  | An email permanently fails (3 attempts) |
| `email.bounced` | A bounce notification is received   |

## Webhook Payload

```json
{
  "event": "email.sent",
  "timestamp": "2026-03-15T12:00:00.000Z",
  "data": {
    "emailId": "msg_abc123...",
    "from": "hello@example.com",
    "to": "user@example.com",
    "subject": "Welcome!",
    "messageId": "<abc@mx.gmail.com>"
  }
}
```

## Signature Verification

Each webhook delivery includes an `X-BunMail-Signature` header containing an HMAC-SHA256 signature of the JSON payload, signed with the webhook's secret.

**Verification example (Node.js):**

```javascript
const crypto = require("crypto");

function verifySignature(body, secret, signature) {
  const expected = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected),
  );
}
```

## Delivery Behavior

- **Retries:** 3 attempts with exponential backoff (1s, 2s, 4s)
- **Timeout:** 10 seconds per request
- **Fire-and-forget:** Delivery failures are logged but don't block email processing
- **Headers:** `Content-Type: application/json`, `X-BunMail-Signature`, `X-BunMail-Event`

## Service Methods

### webhook.service.ts

#### `createWebhook(input, apiKeyId): Promise<{ webhook, secret }>`
Creates a webhook with a random 32-byte hex signing secret. The secret is returned once at creation.

#### `listWebhooks(apiKeyId): Promise<Webhook[]>`
Lists webhooks scoped to the requesting API key.

#### `deleteWebhook(id, apiKeyId): Promise<Webhook | undefined>`
Deletes a webhook, scoped to the requesting API key.

#### `findWebhooksForEvent(event): Promise<Webhook[]>`
Returns all active webhooks subscribed to a given event type.

### webhook-dispatch.service.ts

#### `dispatchEvent(event, data): void`
Finds all subscribed webhooks and delivers the event payload asynchronously.

## API Endpoints

All routes require Bearer token auth and are rate-limited.

| Method | Path                    | Description       |
|--------|-------------------------|-------------------|
| POST   | /api/v1/webhooks        | Register webhook  |
| GET    | /api/v1/webhooks        | List webhooks     |
| DELETE | /api/v1/webhooks/:id    | Delete webhook    |
