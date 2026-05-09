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

Table: `webhook_deliveries` (#30) — persisted retry queue.

| Column                | Type           | Constraints                                       |
|-----------------------|----------------|---------------------------------------------------|
| id                    | varchar(36)    | PK, prefixed `wdl_`                               |
| webhook_id            | varchar(36)    | FK → webhooks, NOT NULL, `ON DELETE CASCADE`      |
| event                 | varchar(50)    | NOT NULL — the event vocabulary value            |
| payload               | text           | NOT NULL — the JSON body bytes that get signed   |
| status                | varchar(20)    | NOT NULL, default `pending` (pending\|delivered\|failed) |
| attempts              | integer        | NOT NULL, default 0                               |
| last_error            | text           | nullable — last attempt's error / response status text |
| last_response_status  | integer        | nullable — HTTP status of most recent attempt    |
| next_attempt_at       | timestamptz    | NOT NULL, default `now()` — worker claim hot path |
| delivered_at          | timestamptz    | nullable — set when status flips to `delivered`  |
| last_response_body    | jsonb          | nullable — `{ bodyPreview }` from the last attempt |
| created_at            | timestamptz    | NOT NULL, default `now()`                         |
| updated_at            | timestamptz    | NOT NULL, default `now()`                         |

Indexes:
- `webhook_deliveries_due_pending_idx` — partial index on `next_attempt_at` filtered to `status='pending'` (worker hot path stays small even with millions of `delivered` rows accumulated).
- `webhook_deliveries_per_webhook_idx` on `(webhook_id, created_at)` — dashboard inspection page.

## Event Types

| Event              | Fired when                                                     |
|--------------------|----------------------------------------------------------------|
| `email.queued`     | An email is inserted into the queue                            |
| `email.sent`       | An email is successfully delivered                             |
| `email.failed`     | An email permanently fails (3 attempts)                        |
| `email.bounced`    | The recipient's MX accepted the SMTP transaction but later returned a Delivery Status Notification — DSN parsed by the bounce module, original `emails` row marked `bounced`, recipient auto-suppressed (#24). See [docs/bounces.md](bounces.md). |
| `email.complained` | A recipient marked the message as spam. Reserved for future Feedback Loop (FBL) processing — wiring TBD. |
| `email.received`   | An inbound email is accepted by the SMTP receiver              |

## Webhook Payload

`email.sent`:

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

`email.bounced`:

```json
{
  "event": "email.bounced",
  "timestamp": "2026-05-07T22:14:00.000Z",
  "data": {
    "emailId": "msg_abc123...",
    "to": "user@example.com",
    "bounceType": "hard",
    "status": "5.1.1",
    "diagnostic": "550 5.1.1 The email account that you tried to reach does not exist",
    "suppressionId": "sup_d4e5f6..."
  }
}
```

The `suppressionId` lets receivers cross-reference the auto-created suppression row. `bounceType` is `"hard"` (5.x.x) or `"soft"` (4.x.x). A second soft bounce for the same recipient within 24h escalates to `"hard"` — the webhook will fire with `bounceType: "hard"` even though the inbound DSN's status code was a 4.x.x.

## Signature Verification

Every webhook delivery carries three headers:

| Header | Value |
|---|---|
| `X-BunMail-Signature` | HMAC-SHA256 of `<timestamp>.<raw-body>` using the webhook's signing secret, hex-encoded |
| `X-BunMail-Timestamp` | Unix-seconds timestamp the signature was computed at (one signed block per delivery attempt — see [Replay protection](#replay-protection)) |
| `X-BunMail-Event` | The event type (e.g. `email.sent`) — for routing only, not authenticated |

To verify a delivery, recompute the HMAC over `<header-timestamp>.<raw-body>` and compare against the `X-BunMail-Signature` header in constant time. **Use the raw request body** — JSON re-serialization changes whitespace and breaks the signature.

After verifying the signature, **also check the timestamp is fresh** (within ±5 minutes by default). Without that check, an attacker who captures one valid delivery can replay it indefinitely.

### Verification example (Node.js)

```javascript
const crypto = require("crypto");

const TOLERANCE_SECONDS = 5 * 60; // 5 minutes — same as Stripe's default

function verifyWebhook(rawBody, headers, secret) {
  const signature = headers["x-bunmail-signature"];
  const timestamp = headers["x-bunmail-timestamp"];

  if (!signature || !timestamp) {
    throw new Error("missing X-BunMail-Signature / X-BunMail-Timestamp");
  }

  // Freshness — protects against replay
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > TOLERANCE_SECONDS) {
    throw new Error("webhook timestamp outside tolerance window");
  }

  // Signature — protects against tampering and forgery
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  const a = Buffer.from(signature, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error("webhook signature mismatch");
  }
}
```

In Express:

```javascript
// `express.raw()` is required so `req.body` is a Buffer, not parsed JSON
app.post(
  "/webhooks/bunmail",
  express.raw({ type: "application/json" }),
  (req, res) => {
    try {
      verifyWebhook(req.body.toString(), req.headers, process.env.WEBHOOK_SECRET);
    } catch (err) {
      return res.status(401).send(err.message);
    }
    const event = JSON.parse(req.body.toString());
    // ... handle the event ...
    res.status(200).end();
  }
);
```

### Verification example (Python)

```python
import hmac
import hashlib
import time

TOLERANCE_SECONDS = 5 * 60  # 5 minutes

def verify_webhook(raw_body: bytes, headers: dict, secret: str) -> None:
    signature = headers.get("x-bunmail-signature")
    timestamp = headers.get("x-bunmail-timestamp")
    if not signature or not timestamp:
        raise ValueError("missing X-BunMail-Signature / X-BunMail-Timestamp")

    # Freshness — protects against replay
    if abs(int(time.time()) - int(timestamp)) > TOLERANCE_SECONDS:
        raise ValueError("webhook timestamp outside tolerance window")

    # Signature — protects against tampering and forgery
    signed = f"{timestamp}.".encode() + raw_body
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()

    if not hmac.compare_digest(signature, expected):
        raise ValueError("webhook signature mismatch")
```

In Flask:

```python
from flask import Flask, request, abort
import os, json

app = Flask(__name__)

@app.post("/webhooks/bunmail")
def bunmail_webhook():
    try:
        verify_webhook(
            request.get_data(),         # raw bytes — do not use request.json
            {k.lower(): v for k, v in request.headers.items()},
            os.environ["WEBHOOK_SECRET"],
        )
    except ValueError as err:
        abort(401, str(err))

    event = json.loads(request.get_data())
    # ... handle the event ...
    return "", 200
```

### Replay protection

Each retry attempt is signed with a **fresh timestamp**, so a long retry chain doesn't ship a stale signature. This means:

- A captured delivery can only be replayed for ~5 minutes (within the tolerance window).
- If your endpoint is briefly unreachable and BunMail retries, each retry has its own valid timestamp window.
- Idempotency on your side should still match on the event ID inside `data` (e.g. `data.emailId`) — the timestamp is *not* a stable identifier.

### Migration note (signing format change in 0.4.0)

Before this version, the signature was computed over the body alone (`HMAC(secret, body)`). It is now computed over `<timestamp>.<body>`. Existing consumers will see signature mismatches until they pick up the verification snippet above. There is no compatibility window — rotate together.

## Delivery Behavior

As of #30, webhook delivery is **persisted, not in-memory**. Every dispatch writes a row to the `webhook_deliveries` table; a worker poll loop (5s tick) drains the queue, retries on a multi-hour schedule, and surfaces inspection + replay via the dashboard and REST API.

| | |
|---|---|
| **Retry schedule** | 1m → 5m → 15m → 1h → 6h (5 attempts total over ~7h) |
| **Timeout** | 10 seconds per request |
| **Fire-and-forget enqueue** | `dispatchEvent` returns synchronously after INSERTing rows; the actual POST happens on the worker tick |
| **Concurrency-safe** | Worker claim uses `FOR UPDATE SKIP LOCKED`; multiple replicas safe by construction |
| **Crash recovery** | None needed — claim advances `next_attempt_at` by 30s during the in-flight attempt; if the worker crashes, the row becomes claimable again automatically |
| **Headers** | `Content-Type: application/json`, `X-BunMail-Signature`, `X-BunMail-Timestamp`, `X-BunMail-Event` |
| **Signing** | Re-computed per attempt with a fresh timestamp so a 6-hour-old retry still passes the consumer's freshness window |

### Delivery row lifecycle

```
pending  ── worker claim ──→  POST attempted
                              ├── 2xx response  →  delivered (terminal)
                              ├── non-2xx / network / timeout
                              │   ├── attempts < 5  →  pending (rescheduled)
                              │   └── attempts == 5 →  failed (terminal)

failed   ── operator replay ─→ pending (attempts reset to 0)
```

Operators replay a `failed` row via `POST /api/v1/webhooks/deliveries/:deliveryId/replay` or the **Replay** button on the dashboard's delivery detail page. Replay flips `status` back to `pending`, resets `attempts` to 0, and sets `next_attempt_at = now()` so the worker picks it up on the next tick.

### Retention

`delivered` rows are deleted by an hourly cleanup task once they're older than `WEBHOOK_DELIVERY_RETENTION_DAYS` (default 30). `failed` rows are kept **indefinitely** — operators want them for forensic "did event X ever land?" queries months after the fact. Override the retention window in `.env`:

```bash
WEBHOOK_DELIVERY_RETENTION_DAYS=90
```

CASCADE on the parent `webhooks` row means deleting a webhook also reaps every one of its deliveries — so a deleted webhook leaves no orphan history.

## Service Methods

### webhook.service.ts

#### `createWebhook(input, apiKeyId): Promise<{ webhook, secret }>`
Creates a webhook with a random 32-byte hex signing secret. The secret is returned once at creation.

#### `listWebhooks(apiKeyId): Promise<Webhook[]>`
Lists webhooks scoped to the requesting API key.

#### `deleteWebhook(id, apiKeyId): Promise<Webhook | undefined>`
Deletes a webhook, scoped to the requesting API key. CASCADE removes its deliveries.

#### `findWebhookById(id, apiKeyId): Promise<Webhook | undefined>`
Single-webhook lookup scoped to an API key. Used by the deliveries endpoint to disambiguate "no deliveries yet" from "wrong id" before returning a 404.

#### `findWebhooksForEvent(event): Promise<Webhook[]>`
Returns all active webhooks subscribed to a given event type.

### webhook-dispatch.service.ts

#### `dispatchEvent(event, data): void`
Finds all subscribed webhooks and **enqueues** one `webhook_deliveries` row per webhook. Synchronous from the caller's perspective; actual HTTP delivery happens on the worker tick.

#### `signPayload(timestamp, body, secret): string`
HMAC-SHA256 over `<timestamp>.<body>`. Re-exported and called by the worker once per attempt.

### webhook-delivery.service.ts (#30)

#### `enqueueDelivery({ webhookId, envelope }): Promise<{ id }>`
INSERTs one `pending` row at `next_attempt_at = now()`.

#### `claimDueDeliveries(n, now?): Promise<Array<...>>`
Atomically claims up to `n` due rows with `FOR UPDATE SKIP LOCKED`. Inactive webhooks' rows are flipped to `failed` rather than delivered.

#### `recordAttempt({ deliveryId, outcome, priorAttempts, now? }): Promise<void>`
Persists the result of one HTTP attempt — `delivered` on 2xx, reschedule per the backoff table on failure, `failed` once the cap is hit.

#### `replayDelivery({ deliveryId, apiKeyId, now? }): Promise<WebhookDelivery | undefined>`
Operator-driven retry: flips a row back to `pending`, resets `attempts` to 0, sets `next_attempt_at` to now.

#### `purgeOldDeliveries({ olderThan }): Promise<{ deleted }>`
Deletes `delivered` rows older than the cutoff. Called hourly by the worker.

### webhook-delivery-worker.service.ts (#30)

#### `start() / stop()`
Idempotent worker control. Wired into the app's main `start()` / SIGINT path.

#### `runPollCycle(): Promise<{ claimed }>`
Single tick — exposed for tests so they can drive the worker deterministically without arming `setInterval`.

## API Endpoints

All routes require Bearer token auth and are rate-limited.

| Method | Path                                                | Description                            |
|--------|-----------------------------------------------------|----------------------------------------|
| POST   | /api/v1/webhooks                                    | Register webhook                       |
| GET    | /api/v1/webhooks                                    | List webhooks                          |
| DELETE | /api/v1/webhooks/:id                                | Delete webhook (cascades to deliveries)|
| GET    | /api/v1/webhooks/:id/deliveries                     | List deliveries for a webhook (`?status=pending\|delivered\|failed`) |
| GET    | /api/v1/webhooks/deliveries/:deliveryId             | Single delivery + payload + last response |
| POST   | /api/v1/webhooks/deliveries/:deliveryId/replay      | Replay a delivery — resets to `pending` |
