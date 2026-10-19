# Webhooks Module

Sends real-time event notifications to registered HTTP endpoints when email status changes.

## URL requirements & SSRF guard (#128)

Because BunMail fetches webhook URLs server-side (and the response is readable via the delivery API), URLs are validated at **creation** and re-validated **before every delivery attempt**:

- Must be **`https`**. To allow plaintext `http` targets, set `WEBHOOK_ALLOW_INSECURE_HTTP=true` (the private-range block below still applies).
- The host is **DNS-resolved**, and the URL is **rejected if any resolved address is private/loopback/link-local/ULA/CGNAT/metadata**: `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16` (incl. `169.254.169.254`), `100.64/10`, `::1`, `fc00::/7`, `fe80::/10`, `fec0::/10`, `ff00::/8`, the local-use NAT64 prefix `64:ff9b:1::/48`, scoped addresses (with a zone id), and IPv6 addresses that embed one of these IPv4 ranges (IPv4-mapped, IPv4-compatible, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`; dotted or hex-group notation alike).
- **The request goes to the validated address.** At delivery the host is resolved once, and the POST is sent to the address that passed the check, not to the name; if the request URL cannot carry exactly that address, the attempt fails. The receiver still sees its own host name: the `Host` header carries the configured host (and port), and for `https` the host name is sent as SNI and the certificate is verified against it before the request is sent. When a name has both IPv4 and IPv6 addresses, IPv4 is used. Each attempt opens a fresh connection.
- **Redirects are not followed** (`redirect: "manual"`): a 3xx counts as a failed delivery, so it can't bounce into an internal address.

A rejected URL at create time returns **HTTP 422** `{ "code": "WEBHOOK_URL_BLOCKED" }`. A URL that only becomes internal later (DNS rebinding, or a row created before this guard) is caught at delivery time and recorded as a failed attempt.

## Module Layout

```
src/modules/webhooks/
├── webhooks.plugin.ts               ← Elysia plugin (route group)
├── errors.ts                        ← Typed errors (inbound admin-only, webhook cap, replay limit)
├── services/
│   ├── webhook.service.ts           ← CRUD operations, per-key webhook cap
│   ├── webhook-dispatch.service.ts  ← Enqueues one delivery per subscribed webhook
│   ├── webhook-delivery.service.ts  ← Fair claim, attempts, replay, retention purge
│   ├── webhook-delivery-worker.service.ts ← Poll loop and hourly cleanup
│   └── replay-limit.service.ts      ← Replay budget per delivery (in memory)
├── dtos/
│   ├── create-webhook.dto.ts        ← POST body validation
│   ├── list-webhooks.dto.ts         ← GET / pagination (default limit 100)
│   └── list-deliveries.dto.ts       ← GET /:id/deliveries pagination + status
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
| api_key_id  | varchar(36)    | FK → api_keys, NOT NULL, indexed (#173) |
| url         | text           | NOT NULL                     |
| events      | jsonb          | NOT NULL, default `[]`       |
| secret      | varchar(255)   | NOT NULL, encrypted at rest (`v1:` AES-256-GCM with `DKIM_ENCRYPTION_KEY`, #259) |
| is_active   | boolean        | NOT NULL, default `true`     |
| created_at  | timestamp      | NOT NULL, default `now()`    |
| updated_at  | timestamp      | NOT NULL, default `now()`    |
| created_by_user_id | varchar(36) | nullable, FK → users ON DELETE SET NULL, indexed: who created it (#219, attribution only; NULL = the owner) |

Table: `webhook_deliveries` (#30): persisted retry queue.

| Column                | Type           | Constraints                                       |
|-----------------------|----------------|---------------------------------------------------|
| id                    | varchar(36)    | PK, prefixed `wdl_`                               |
| webhook_id            | varchar(36)    | FK → webhooks, NOT NULL, `ON DELETE CASCADE`      |
| event                 | varchar(50)    | NOT NULL: the event vocabulary value            |
| payload               | text           | NOT NULL: the JSON body bytes that get signed   |
| status                | varchar(20)    | NOT NULL, default `pending` (pending\|delivered\|failed) |
| attempts              | integer        | NOT NULL, default 0                               |
| last_error            | text           | nullable: last attempt's error / response status text |
| last_response_status  | integer        | nullable: HTTP status of most recent attempt    |
| next_attempt_at       | timestamptz    | NOT NULL, default `now()`: worker claim hot path |
| delivered_at          | timestamptz    | nullable: set when status flips to `delivered`  |
| last_response_body    | jsonb          | nullable: `{ bodyPreview }` from the last attempt |
| created_at            | timestamptz    | NOT NULL, default `now()`                         |
| updated_at            | timestamptz    | NOT NULL, default `now()`                         |

Indexes:
- `webhook_deliveries_due_per_webhook_idx`: partial index on `(webhook_id, next_attempt_at)` filtered to `status='pending'` (#258, replaces `webhook_deliveries_due_pending_idx`). The fair claim reads each webhook's first due rows through it, so the worker hot path stays one short probe per webhook even with a large backlog or millions of finished rows.
- `webhook_deliveries_per_webhook_idx` on `(webhook_id, created_at)`: dashboard inspection page.

## Event Types

| Event              | Fired when                                                     |
|--------------------|----------------------------------------------------------------|
| `email.queued`     | An email is inserted into the queue                            |
| `email.sent`       | An email is successfully delivered                             |
| `email.failed`     | An email permanently fails (temporary failures are retried with backoff until it is `MAIL_RETRY_MAX_AGE_HOURS` old). `data.blocked: true` when a receiver refused the sender (blocklist, reputation, SPF/DKIM/DMARC), not the recipient (#246) |
| `email.bounced`    | The recipient's MX accepted the SMTP transaction but later returned a Delivery Status Notification: DSN parsed by the bounce module, original `emails` row marked `bounced`, recipient auto-suppressed (#24). See [docs/bounces.md](bounces.md). |
| `email.complained` | A recipient marked the message as spam. Reserved for future Feedback Loop (FBL) processing: wiring TBD. |
| `email.received`   | An inbound email is accepted by the SMTP receiver. Admin keys only (see below) |
| `email.unsubscribed` | A recipient used the per-recipient one-click unsubscribe link or `unsub+` mailto, and a permanent `unsubscribe` suppression was created (#249). Fires once per suppression: repeated requests fire nothing. See [suppressions.md](suppressions.md#one-click-unsubscribe). |

### Who receives an event

Events are scoped to the API key that owns the webhook:

- `email.queued`, `email.sent`, `email.failed`, `email.bounced`, `email.unsubscribed`: delivered only to webhooks owned by the API key that sent the email. Another key's webhooks never see them, even if they subscribe to the same event type.
- `email.received`: inbound mail has no owning key, so it is delivered only to webhooks owned by **admin** keys, matching the admin-only inbound API (#130). A restricted key that tries to subscribe to it gets `403` with `code: "INBOUND_EVENTS_REQUIRE_ADMIN"`.
- Webhooks of a **revoked** key receive nothing, and deliveries already queued for them are marked `failed` instead of sent.
- Before dispatch was scoped, events could reach other keys' webhooks. Migration `0014` deletes any such deliveries left over in `webhook_deliveries` on upgrade.

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

`email.unsubscribed` (#249):

```json
{
  "event": "email.unsubscribed",
  "timestamp": "2026-10-19T09:30:00.000Z",
  "data": {
    "emailId": "msg_abc123...",
    "recipient": "user@example.com",
    "source": "one_click",
    "unsubscribedAt": "2026-10-19T09:30:00.000Z"
  }
}
```

`source` is `"one_click"` (RFC 8058 POST from the mailbox provider), `"link"` (the confirmation page's button) or `"mailto"` (mail to `unsub+<token>@<domain>`). `emailId` is the email whose header was used; `recipient` is lowercased.

The `suppressionId` lets receivers cross-reference the auto-created suppression row. `bounceType` is `"hard"` (5.x.x) or `"soft"` (4.x.x). A second soft bounce for the same recipient within 24h escalates to `"hard"`: the webhook will fire with `bounceType: "hard"` even though the inbound DSN's status code was a 4.x.x.

## Signature Verification

Every webhook delivery carries three headers:

| Header | Value |
|---|---|
| `X-BunMail-Signature` | HMAC-SHA256 of `<timestamp>.<raw-body>` using the webhook's signing secret, hex-encoded |
| `X-BunMail-Timestamp` | Unix-seconds timestamp the signature was computed at (one signed block per delivery attempt, see [Replay protection](#replay-protection)) |
| `X-BunMail-Event` | The event type (e.g. `email.sent`): for routing only, not authenticated |

To verify a delivery, recompute the HMAC over `<header-timestamp>.<raw-body>` and compare against the `X-BunMail-Signature` header in constant time. **Use the raw request body**: JSON re-serialization changes whitespace and breaks the signature.

After verifying the signature, **also check the timestamp is fresh** (within ±5 minutes by default). Without that check, an attacker who captures one valid delivery can replay it indefinitely.

### Verification example (Node.js)

```javascript
const crypto = require("crypto");

const TOLERANCE_SECONDS = 5 * 60; // 5 minutes: same as Stripe's default

function verifyWebhook(rawBody, headers, secret) {
  const signature = headers["x-bunmail-signature"];
  const timestamp = headers["x-bunmail-timestamp"];

  if (!signature || !timestamp) {
    throw new Error("missing X-BunMail-Signature / X-BunMail-Timestamp");
  }

  // Freshness: protects against replay
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > TOLERANCE_SECONDS) {
    throw new Error("webhook timestamp outside tolerance window");
  }

  // Signature: protects against tampering and forgery
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

    # Freshness: protects against replay
    if abs(int(time.time()) - int(timestamp)) > TOLERANCE_SECONDS:
        raise ValueError("webhook timestamp outside tolerance window")

    # Signature: protects against tampering and forgery
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
            request.get_data(),         # raw bytes, do not use request.json
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
- Idempotency on your side should still match on the event ID inside `data` (e.g. `data.emailId`): the timestamp is *not* a stable identifier.

### Migration note (signing format change in 0.4.0)

Before this version, the signature was computed over the body alone (`HMAC(secret, body)`). It is now computed over `<timestamp>.<body>`. Existing consumers will see signature mismatches until they pick up the verification snippet above. There is no compatibility window: rotate together.

## Delivery Behavior

As of #30, webhook delivery is **persisted, not in-memory**. Every dispatch writes a row to the `webhook_deliveries` table; a worker poll loop (5s tick) drains the queue, retries on a multi-hour schedule, and surfaces inspection + replay via the dashboard and REST API.

| | |
|---|---|
| **Retry schedule** | 1m → 5m → 15m → 1h → 6h (5 attempts total over ~7h) |
| **Timeout** | 10 seconds per request |
| **Fire-and-forget enqueue** | `dispatchEvent` returns synchronously after INSERTing rows; the actual POST happens on the worker tick |
| **Concurrency-safe** | Worker claim uses `FOR UPDATE SKIP LOCKED`; multiple replicas safe by construction |
| **Fair across API keys** | Each batch (25 rows) is shared round-robin across the API keys owning the webhooks (#258): every key's oldest due delivery first, then each key's next one. A key whose receiver is down and collecting retries cannot delay other keys' events. A key's webhooks share its turn, and a single key keeps FIFO order by due time |
| **Crash recovery** | Claim advances `next_attempt_at` by 30s during the in-flight attempt and counts the attempt up front; if the worker crashes, the row becomes claimable again automatically, and a row whose attempts keep crashing ends at `failed` once the limit is exceeded instead of being retried forever |
| **Response reading** | The body is never decompressed (`decompress: false`) and at most 8 KB is read (streamed, then cancelled) to build the 2 KB preview, so a huge or compressed response can't exhaust memory. A receiver that compresses anyway gets a placeholder preview such as `[gzip-encoded response body not shown]` |
| **Connection** | Sent to the address the SSRF guard validated for this attempt (see [URL requirements](#url-requirements--ssrf-guard-128)), one fresh connection per attempt; `Host`, SNI and the certificate check use the configured host name |
| **Headers** | `Host` (the configured host), `Content-Type: application/json`, `X-BunMail-Signature`, `X-BunMail-Timestamp`, `X-BunMail-Event`, `Accept-Encoding: identity` |
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

A delivery can be replayed at most **5 times per hour** (#258; a fixed one-hour window from the first replay). One more is refused with `429`, a `Retry-After` header and `code: "REPLAY_LIMIT_REACHED"` over REST, and with a 429 on the delivery page in the dashboard. The budget is counted only after the ownership check, so another key's attempts are plain 404s. Like the API and login limiters it lives in memory, per replica: it resets on restart, and with several replicas each keeps its own count (#185).

### Webhooks per API key

A key may have at most `WEBHOOKS_MAX_PER_API_KEY` webhooks (default 10, a whole number from 1 to 100, #258). Every event fans out to each of the key's subscribed webhooks, so the cap bounds that fan-out. One more is refused over REST with `422` and `code: "WEBHOOK_LIMIT_REACHED"`, and on the dashboard with an error message. The count and the insert run in one transaction holding a lock on the key's row, so parallel creates cannot overshoot. Webhooks that already exceed the cap (created before it existed, or kept after lowering it) are kept and keep receiving events; the key cannot add another until it is below the cap.

### Retention

Finished rows, `delivered` **and** `failed`, are deleted by an hourly cleanup task once their last change (delivery, final failure: `updated_at`) is older than `WEBHOOK_DELIVERY_RETENTION_DAYS` (default 30, a whole number from 1 to 365; anything else refuses to boot). The delete runs in batches of 5,000 (at most 100 batches a pass, the rest at the next one) and logs one line with the count when it removed anything. `pending` rows, including the ones in flight, are never deleted, however old. A replayed row is `pending` again, so its clock restarts when it finishes. Before #258, `failed` rows were kept forever; raise the retention if you need them longer for forensics:

```bash
WEBHOOK_DELIVERY_RETENTION_DAYS=90
```

CASCADE on the parent `webhooks` row means deleting a webhook also reaps every one of its deliveries, so a deleted webhook leaves no orphan history.

## Service Methods

### webhook.service.ts

#### `createWebhook(input, apiKeyId, createdByUserId = null): Promise<{ webhook, secret }>`
Creates a webhook with a random 32-byte hex signing secret. The secret is returned once at creation; only its ciphertext is stored (#259), and the delivery worker decrypts it per attempt. A secret that no longer decrypts (the key changed) fails the attempt without sending. `createdByUserId` (#219) records who created it: the dashboard user, or over REST the calling key's user (null = the owner); attribution only. Throws `InboundEventsRequireAdminError` (`src/modules/webhooks/errors.ts`, mapped to `403 INBOUND_EVENTS_REQUIRE_ADMIN`) when a non-admin key subscribes to `email.received`, and `WebhookLimitReachedError` (`422 WEBHOOK_LIMIT_REACHED`, #258) when the key already has `WEBHOOKS_MAX_PER_API_KEY` webhooks; the count and insert hold a `FOR NO KEY UPDATE` lock on the key's row. Enforced in the service, so the API and the dashboard behave the same.

#### `listWebhooks(apiKeyId, { page, limit }): Promise<{ data: Webhook[]; total }>`
Lists one page of the requesting API key's webhooks, oldest first, with the key's total (#258).

#### `deleteWebhook(id, apiKeyId): Promise<Webhook | undefined>`
Deletes a webhook, scoped to the requesting API key. CASCADE removes its deliveries.

#### `findWebhookById(id, apiKeyId): Promise<Webhook | undefined>`
Single-webhook lookup scoped to an API key. Used by the deliveries endpoint to disambiguate "no deliveries yet" from "wrong id" before returning a 404.

#### `findWebhooksForEvent(event, scope): Promise<{ id: string }[]>`
Returns the ids of active webhooks subscribed to `event`, limited by `scope` (`DispatchScope`): `{ apiKeyId }` for an email's own events (only that key's webhooks), or `{ adminOnly: true }` for `email.received` (only admin keys' webhooks). The owner filter runs in SQL; the event match runs on the parsed `events` array.

### webhook-dispatch.service.ts

#### `dispatchEvent(event, data, scope): void`
Finds the webhooks in `scope` subscribed to the event and **enqueues** one `webhook_deliveries` row per webhook. Synchronous from the caller's perspective; actual HTTP delivery happens on the worker tick.

#### `signPayload(timestamp, body, secret): string`
HMAC-SHA256 over `<timestamp>.<body>`. Re-exported and called by the worker once per attempt.

### webhook-delivery.service.ts (#30)

#### `enqueueDelivery({ webhookId, envelope }): Promise<{ id }>`
INSERTs one `pending` row at `next_attempt_at = now()`.

#### `claimDueDeliveries(n, now?): Promise<Array<...>>`
Atomically claims up to `n` due rows with `FOR UPDATE SKIP LOCKED`, shared round-robin across the API keys owning their webhooks (#258: a `LATERAL` per webhook takes its first `n` due rows, ranked within the owning key, lowest ranks first), and increments their `attempts` (each row's returned `attempts` is the count before this attempt). Inactive webhooks' rows are flipped to `failed` rather than delivered, and so are rows over `MAX_DELIVERY_ATTEMPTS` (attempts that never reached `recordAttempt` because the process died).

#### `recordAttempt({ deliveryId, outcome, priorAttempts, now? }): Promise<void>`
Persists the result of one HTTP attempt: `delivered` on 2xx, reschedule per the backoff table on failure, `failed` once the cap is hit.

#### `replayDelivery({ deliveryId, apiKeyId, now? }): Promise<WebhookDelivery | undefined>`
Operator-driven retry: flips a row back to `pending`, resets `attempts` to 0, sets `next_attempt_at` to now. After the ownership check, counts the replay against `REPLAYS_PER_DELIVERY_PER_HOUR` (5, `replay-limit.service.ts`) and throws `ReplayLimitReachedError` (429, `retryAfterSec`) past it (#258).

#### `purgeOldDeliveries({ olderThan, batchSize? }): Promise<{ deleted }>`
Deletes `delivered` and `failed` rows whose `updated_at` is before the cutoff, in batches (default 5,000, at most 100 per call), never `pending` ones (#258). Called hourly by the worker's `runCleanupCycle`, which runs in its own log context (`job: "webhook-delivery-cleanup"`).

### webhook-delivery-worker.service.ts (#30)

#### `start() / stop()`
Idempotent worker control. Wired into the app's main `start()` / SIGINT path.

#### `runPollCycle(): Promise<{ claimed }>`
Single tick: exposed for tests so they can drive the worker deterministically without arming the poll timer. The worker schedules each tick after the previous one finished (5 s +/-10%), so ticks never overlap (#176).

## API Endpoints

All routes require Bearer token auth and are rate-limited.

| Method | Path                                                | Description                            |
|--------|-----------------------------------------------------|----------------------------------------|
| POST   | /api/v1/webhooks                                    | Register webhook                       |
| GET    | /api/v1/webhooks                                    | List webhooks (`?page`, `?limit`, default 100) |
| DELETE | /api/v1/webhooks/:id                                | Delete webhook (cascades to deliveries)|
| GET    | /api/v1/webhooks/:id/deliveries                     | List deliveries for a webhook (`?status=pending\|delivered\|failed`) |
| GET    | /api/v1/webhooks/deliveries/:deliveryId             | Single delivery + payload + last response |
| POST   | /api/v1/webhooks/deliveries/:deliveryId/replay      | Replay a delivery, resets to `pending` (5 per delivery per hour) |
