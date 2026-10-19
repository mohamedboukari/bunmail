# Suppressions Module

The suppression list is the gate between an API request and the email queue. Addresses on the list are rejected at `POST /api/v1/emails/send` with HTTP 422 and never reach the queue, the SMTP path, or the recipient's mailbox.

The list exists because **repeated sends to bouncing addresses are the fastest way to kill IP reputation**. Receivers (Gmail, Yahoo, Outlook) track sender reputation per-IP and per-domain; once you've sent to a few hundred non-existent mailboxes, your messages start landing in spam, even for legitimate recipients.

## Scoping

Suppressions are **per `api_key_id`**, not global. Different API keys often represent different customer environments (transactional / marketing / dev), so one key's bounces should never gate another's sends. Mirrors what SES, SendGrid, and Resend do.

A consequence: revoking a key cascades to its suppression list (`ON DELETE CASCADE`). If you rotate a key and want its suppressions to carry over, copy them to the new key first via the API.

## Lookup behaviour

The gate normalises the recipient address before the lookup: `Alice@Example.COM` and `alice@example.com` resolve to the same suppression. RFC 5321 says the local part is technically case-sensitive, but every real receiver folds case, and matching that behaviour at the gate avoids surprise bypasses.

A suppression is **active** when:
- the row exists for `(api_key_id, normalised_email)`, AND
- `expires_at IS NULL` (permanent), OR `expires_at > now()` (not yet expired)

Expired rows stay in the table: they're not auto-purged today. If you need cleanup, schedule a background job; for typical usage the table stays small.

## Reasons

| Value | When |
|---|---|
| `bounce` | Auto-set by the bounce module (#24) when a Delivery Status Notification arrives at the inbound SMTP. The DSN parser calls `addFromBounce()` and persists `bounce_type` + `diagnostic_code` from the SMTP enhanced status code. See [docs/bounces.md](bounces.md). |
| `complaint` | Reserved for FBL (Feedback Loop) processing, when a recipient marks your message as spam. Not implemented yet. |
| `manual` | Operator/customer added the address themselves (e.g. "I know this address bounces, just block it"). |
| `unsubscribe` | Set by the one-click unsubscribe flow (#249): a recipient used the per-recipient `List-Unsubscribe` link or mailto. Permanent; `source_email_id` is the email whose link was used. See [One-click unsubscribe](#one-click-unsubscribe). Can also be set manually. |

The DB column is plain `text` for forward compatibility: a finer split (e.g. `bounce.hard.no_user`) can land later without a migration. The API DTO restricts incoming reasons to the four values above.

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
- `UNIQUE (api_key_id, email)`: service uses this for `ON CONFLICT DO UPDATE`
- `(api_key_id, email)`: composite btree, serves the gate's hot lookup

## API surface

All endpoints are scoped to the calling key's `apiKeyId` (read from the auth middleware). Full request/response shapes live in [`docs/api.md`](api.md#suppressions).

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/suppressions` | Manual add (idempotent: re-suppressing upserts) |
| `GET` | `/api/v1/suppressions` | Paginated list, optional `?email=` exact-match filter |
| `GET` | `/api/v1/suppressions/:id` | Read one |
| `DELETE` | `/api/v1/suppressions/:id` | Remove (recipient becomes eligible immediately) |

## Dashboard surface (admin-scoped, #89)

The API surface is per-key, but auto-suppressions are filed under whichever key happened to be sending when the bounce arrived, which is almost never the same as the operator's Bearer-token key. Without an unscoped view, a stuck auto-suppression meant SSH-ing into Postgres and writing SQL. The dashboard fixes that:

| Path | Purpose |
|---|---|
| `GET /dashboard/suppressions` | List across **all** API keys. Filters: `?email=<substring>` (case-insensitive ILIKE) and `?apiKeyId=<id>`. |
| `POST /dashboard/suppressions/:id/delete` | Hard delete by id, no api-key check (the dashboard session already authenticated). |

The page renders the owning key's name + truncated id beside each row so the operator can see which key trapped the recipient. The `/dashboard/send` page now has an explicit "Sending as" key picker so future auto-suppressions get filed under a key the operator chose, not whichever happened to be first in the list.

Underneath these are two new service methods that mirror the unscoped pattern used elsewhere in the codebase:

```ts
import {
  listAllSuppressions,
  deleteSuppressionByIdUnscoped,
} from "src/modules/suppressions/services/suppression.service.ts";
```

Both ignore `apiKeyId` and trust the dashboard session for authorisation, the same way the unscoped emails/domains/etc. variants do.

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

The email is **not** inserted into the `emails` table. There's no row to retry, no queue entry, no SMTP attempt: the gate is hard-fail before any side effect.

## Auto-suppression on bounces (#24)

The bounce module (#24) closes the loop: when the inbound SMTP receives a Delivery Status Notification, the parser pulls out the recipient and SMTP enhanced status code, the handler links the bounce back to the original `emails` row by `Original-Message-ID`, and `addFromBounce()` persists the suppression under that email's `api_key_id`. See [docs/bounces.md](bounces.md) for the full chain.

Hard bounces (5.x.x) become permanent suppressions. Soft bounces (4.x.x) become 24-hour windowed suppressions; a second soft bounce while the previous one is still active escalates to permanent.

The `processEmail` retry path deliberately **does not** auto-suppress when the retry window runs out: that path can't tell hard bounces from network blips. The bounce module handles the classification authoritatively from the DSN's status code.

## One-click unsubscribe

Unsubscribe requests become suppressions (#249). Outgoing mail with exactly one recipient (no cc, no bcc) carries a per-recipient `List-Unsubscribe` header when `APP_BASE_URL` is `https://` (header rules: [emails.md](emails.md#list-unsubscribe)). Its token names that email, its recipient and the sending key, so any of the three ways in below suppresses exactly that address under exactly that key.

**Token** (`services/unsubscribe-token.ts`): `<email id hex>.<MAC>`, stateless (no table).

- MAC: HMAC-SHA256 over `unsubscribe:v1:<email id>:<lowercased recipient>:<api key id>`, truncated to 128 bits.
- Key: HKDF-SHA256 from `DKIM_ENCRYPTION_KEY` with a fixed label, so there is no new secret to configure. **Rotating `DKIM_ENCRYPTION_KEY` invalidates every unsubscribe link already sent** (SECURITY.md, Rotation).
- Lowercase hex, 57 characters; `unsub+<token>` is 63, inside RFC 5321's 64-character local part. Verification is case-insensitive (an MTA may fold the case of a local part).
- Verification loads the email row by id, recomputes the MAC from the row (recipient and key) and compares in constant time. Malformed, unknown or purged email, an email with cc or bcc, a wrong MAC: all the same "not valid" result. No expiry other than the email row's existence (soft-deleted emails still work until purged).

**Ways in:**

| Path | Source | Behaviour |
|---|---|---|
| `GET /u/:token` | none | Confirmation page ("Stop sending mail to `u***@example.org` from `acme.io`?") with a POST button. **Never suppresses**: link scanners and prefetchers fetch GETs. Invalid token: neutral "not valid" page, `404`. |
| `POST /u/:token` with `List-Unsubscribe=One-Click` | `one_click` | RFC 8058 request from the mailbox provider (form-encoded or multipart). Suppresses, `200`. |
| `POST /u/:token` with `confirm=unsubscribe` | `link` | The confirmation page's button. Suppresses, `200`. Any other body: `400`, nothing written. |
| Mail to `unsub+<token>@<sender domain>` | `mailto` | Inbound SMTP receiver (`SMTP_ENABLED`, MX pointing here). Valid token: accepted, suppressed, never stored as inbound mail, no inbound notification. Invalid token or another domain: refused at `RCPT TO` with `550` (nothing stored, no bounce of ours to a possibly forged sender). |

Both HTTP routes are public (no auth, not under `/api/v1`), rate limited to 30 requests a minute per client IP (IPv6 per /64, resolved like the dashboard login, honouring `DASHBOARD_TRUSTED_PROXY_HOPS`), and answer with `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow` and the page CSP with no script. They never show the token or the full address. The POST has no CSRF or same-origin check on purpose: providers POST from their own servers, cross-origin by design, and a forged POST can do no more than the token allows.

**Effect** (`addFromUnsubscribe`): a permanent suppression, `reason = 'unsubscribe'`, under the email's API key. Idempotent: a permanent suppression already on file (bounce, complaint, manual, earlier unsubscribe) is left as it is and the request still succeeds; a temporary one (soft-bounce window) is turned into the permanent unsubscribe. Only when a row is created or upgraded does `email.unsubscribed` fire to that key's webhooks (`{ emailId, recipient, source, unsubscribedAt }`, see [webhooks.md](webhooks.md)). Each request logs `Unsubscribe request processed` at `info` with `emailId`, `apiKeyId`, the redacted address, `source` and `outcome`.

Files: `services/unsubscribe-token.ts` (mint, parse, verify, `soleRecipient`), `services/unsubscribe.service.ts` (`resolveUnsubscribeToken`, `unsubscribe`), `services/suppression.service.ts` (`addFromUnsubscribe`), the pages in `src/pages/unsubscribe.plugin.tsx` and `src/pages/routes/unsubscribe.tsx`, and the inbound branch in `src/modules/inbound/services/smtp-receiver.service.ts`.

### Service methods

#### `addFromUnsubscribe(input): Promise<Suppression | undefined>`
`{ apiKeyId, email, emailId, source }`, from a verified token only. Returns the row when it was created or upgraded from a temporary entry, `undefined` when a permanent one was already there.

#### `resolveUnsubscribeToken(token, key?): Promise<UnsubscribeTarget | null>`
Verifies a token against its email row: `{ emailId, apiKeyId, recipient, senderDomain }`, or `null` for every failure.

#### `unsubscribe(target, source): Promise<boolean>`
`addFromUnsubscribe`, then `email.unsubscribed` on first creation. `true` when this request created the suppression.

## Out of scope (separate tickets)

- Complaint Feedback Loop (FBL) ingestion
- Bulk import (CSV upload)
- Dashboard UI for managing suppressions
- Auto-purge of expired rows
