# Suppressions Module

The suppression list is the gate between an API request and the email queue. Addresses on the list are rejected at `POST /api/v1/emails/send` with HTTP 422 and never reach the queue, the SMTP path, or the recipient's mailbox.

The list exists because **repeated sends to bouncing addresses are the fastest way to kill IP reputation**. Receivers (Gmail, Yahoo, Outlook) track sender reputation per-IP and per-domain; once you've sent to a few hundred non-existent mailboxes, your messages start landing in spam — even for legitimate recipients.

## Scoping

Suppressions are **per `api_key_id`**, not global. Different API keys often represent different customer environments (transactional / marketing / dev), so one key's bounces should never gate another's sends. Mirrors what SES, SendGrid, and Resend do.

A consequence: revoking a key cascades to its suppression list (`ON DELETE CASCADE`). If you rotate a key and want its suppressions to carry over, copy them to the new key first via the API.

## Lookup behaviour

The gate normalises the recipient address before the lookup: `Alice@Example.COM` and `alice@example.com` resolve to the same suppression. RFC 5321 says the local part is technically case-sensitive, but every real receiver folds case, and matching that behaviour at the gate avoids surprise bypasses.

A suppression is **active** when:
- the row exists for `(api_key_id, normalised_email)`, AND
- `expires_at IS NULL` (permanent), OR `expires_at > now()` (not yet expired)

Expired rows stay in the table — they're not auto-purged today. If you need cleanup, schedule a background job; for typical usage the table stays small.

## Reasons

| Value | When |
|---|---|
| `bounce` | Auto-set by future bounce processing (#24). The DSN parser will call `addFromBounce()` and persist `bounce_type` + `diagnostic_code` from the SMTP enhanced status code. |
| `complaint` | Reserved for FBL (Feedback Loop) processing — when a recipient marks your message as spam. Not implemented yet. |
| `manual` | Operator/customer added the address themselves (e.g. "I know this address bounces, just block it"). |
| `unsubscribe` | Reserved for future one-click unsubscribe handling per Gmail's Feb-2024 sender requirements. The DB column accepts it today; no endpoint sets it yet. |

The DB column is plain `text` for forward compatibility — a finer split (e.g. `bounce.hard.no_user`) can land later without a migration. The API DTO restricts incoming reasons to the four values above.

## Schema

| Column | Type | Notes |
|---|---|---|
| `id` | `varchar(36)` PK | `sup_<24 hex>` |
| `api_key_id` | `varchar(36)` FK → `api_keys(id)` | `ON DELETE CASCADE` |
| `email` | `varchar(255)` | Stored lower-case, trimmed |
| `reason` | `text` | One of `bounce | complaint | manual | unsubscribe` (validated at API boundary) |
| `bounce_type` | `varchar(20)` | `hard | soft | null` |
| `diagnostic_code` | `text` | SMTP enhanced status code, e.g. `5.1.1` |
| `source_email_id` | `varchar(36)` FK → `emails(id)` | `ON DELETE SET NULL` |
| `expires_at` | `timestamptz` | Null = permanent |
| `created_at` | `timestamptz` | Default `now()` |

Indexes:
- `UNIQUE (api_key_id, email)` — service uses this for `ON CONFLICT DO UPDATE`
- `(api_key_id, email)` — composite btree, serves the gate's hot lookup

## API surface

All endpoints are scoped to the calling key's `apiKeyId` (read from the auth middleware). Full request/response shapes live in [`docs/api.md`](api.md#suppressions).

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/suppressions` | Manual add (idempotent — re-suppressing upserts) |
| `GET` | `/api/v1/suppressions` | Paginated list, optional `?email=` exact-match filter |
| `GET` | `/api/v1/suppressions/:id` | Read one |
| `DELETE` | `/api/v1/suppressions/:id` | Remove (recipient becomes eligible immediately) |

## Behaviour at `POST /api/v1/emails/send`

When the recipient is on the list, the response is:

```http
HTTP/1.1 422 Unprocessable Entity
Content-Type: application/json

{
  "success": false,
  "error": "Recipient is on the suppression list. Remove the suppression first if this is intentional.",
  "code": "RECIPIENT_SUPPRESSED",
  "suppressionId": "sup_a1b2c3..."
}
```

The `suppressionId` lets clients pivot directly to `DELETE /api/v1/suppressions/:id` if the block was a mistake.

The email is **not** inserted into the `emails` table. There's no row to retry, no queue entry, no SMTP attempt — the gate is hard-fail before any side effect.

## Upgrade path: auto-suppression on bounces (#24)

This module ships the storage and the manual-add API. The full acceptance-criteria item from #25 — "auto-suppress on hard bounce / repeated soft bounce" — depends on bounce parsing, which is tracked in #24.

When #24 lands it'll call:

```ts
import { addFromBounce } from "src/modules/suppressions/services/suppression.service.ts";

await addFromBounce(apiKeyId, {
  email: parsedDsn.recipient,
  bounceType: parsedDsn.classify(),  // "hard" | "soft"
  diagnosticCode: parsedDsn.statusCode,
  sourceEmailId: msgId,
  expiresAt: bounceType === "soft" ? addDays(new Date(), 7) : null,
});
```

The current `processEmail` retry path **does not** auto-suppress on `MAX_ATTEMPTS` exhaustion, even though that's tempting — without DSN parsing we can't tell hard bounces from network blips, and crude auto-suppression would block legitimate sends.

## Out of scope (separate tickets)

- One-click unsubscribe endpoint (Gmail Feb-2024 List-Unsubscribe-Post)
- Complaint Feedback Loop (FBL) ingestion
- Bulk import (CSV upload)
- Dashboard UI for managing suppressions
- Auto-purge of expired rows
