# BunMail API Reference

Base URL: `http://localhost:3000`

## OpenAPI Specification

BunMail exposes an auto-generated OpenAPI 3.0 spec:

- **Interactive docs (Scalar):** `GET /api/docs`
- **Raw JSON spec:** `GET /api/docs/json`

## Authentication

All endpoints (except `/health` and the public unsubscribe pages, `/u/:token`) require a Bearer token in the `Authorization` header:

```
Authorization: Bearer bm_live_<your-api-key>
```

API keys are managed via the `/api/v1/api-keys` endpoints. The first key is created using the seed script (`bun run src/db/seed.ts`).

Changes made through the API (API keys created, updated or revoked; domains added, updated, verified or deleted, and DKIM key rotations started, completed or cancelled; webhooks created or deleted; suppressions added or removed) are recorded in the audit log (#221) with the calling key as the actor, its name, the client IP and the user agent. Admins and the owner read it on the dashboard; see [docs/audit-log.md](audit-log.md).

> **Sending over SMTP instead of REST?** Besides this HTTP API, BunMail can run an SMTP **submission** server (#120) so apps that only speak SMTP send *through* BunMail: the same `bm_live_…` key is used as the SMTP password. It has no REST endpoints of its own; see [docs/smtp-submission.md](smtp-submission.md).

## Rate Limiting

- **Limit:** 100 requests per 60-second fixed window per API key by default (`API_RATE_LIMIT_MAX` / `API_RATE_LIMIT_WINDOW`)
- **Scope:** Per API key ID (not per IP)
- **Response on exceed:** `429 Too Many Requests` with `Retry-After` header (seconds)

---

## Pagination

Every list endpoint takes the same query params:

| Param   | Type   | Default | Range         |
|---------|--------|---------|---------------|
| `page`  | number | 1       | 1 to 1,000,000 |
| `limit` | number | 20      | 1 to 100      |

A value outside the range, or one that isn't a number, returns **422** (#172). Responses carry `pagination: { page, limit, total }`. The page cap keeps the underlying `OFFSET` well inside PostgreSQL's integer range.

`GET /api/v1/webhooks` and `GET /api/v1/templates` (paginated since #258) default `limit` to **100**, the maximum, so a client that never pages still gets the same first 100 rows as before; both are ordered oldest first.

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

### Unsubscribe (public, #249)

#### `GET /u/:token` / `POST /u/:token`

The per-recipient one-click link BunMail puts in `List-Unsubscribe` (see [emails.md](emails.md#list-unsubscribe)). No Bearer token: the token in the path is the credential. HTML responses, not JSON.

- `GET`: confirmation page. Never suppresses (link scanners and prefetchers fetch GETs).
- `POST`: body `List-Unsubscribe=One-Click` (RFC 8058, form-encoded or multipart, sent by mailbox providers) or `confirm=unsubscribe` (the confirmation button). Adds a permanent `unsubscribe` suppression for the recipient under the sending key and fires `email.unsubscribed` the first time. `200` also when already suppressed. Any other body: `400`.
- Invalid, unknown or purged token: `404` with a neutral page, nothing written. Over 30 requests a minute from one client IP: `429` with `Retry-After`.

See [suppressions.md](suppressions.md#one-click-unsubscribe).

---

### Emails

All email endpoints are prefixed with `/api/v1/emails`.

#### `POST /api/v1/emails/send`

Queue a new email for delivery. Supports direct content or template-based sending.

**Request Body:**

| Field        | Type   | Required | Description                                  |
|--------------|--------|----------|----------------------------------------------|
| `from`       | string | Yes      | Sender email address                         |
| `fromName`   | string | No       | Sender display name (#250), sent as `From: "<fromName>" <from>`. Rules below. Returned as `fromName` on email responses (`null` when unset). |
| `to`         | string | Yes      | Recipient email address                      |
| `subject`    | string | *        | Subject line (required when not using template) |
| `html`       | string | No       | HTML body (max 5 MB)                         |
| `text`       | string | No       | Plain text body (max 5 MB)                   |
| `cc`         | string | No       | Comma-separated CC recipients                |
| `bcc`        | string | No       | Comma-separated BCC recipients               |
| `replyTo`    | string | No       | Comma-separated Reply-To address(es): replies go here instead of `from` (#169). Header only; doesn't change the envelope sender. Returned as `replyTo` on email responses (`null` when unset). |
| `templateId` | string | No       | Template ID (overrides subject/html/text)    |
| `variables`  | object | No       | Key-value pairs for template rendering (max 100 entries, values max 100 KB; the rendered body is capped at 5 MB and the subject at 500 characters, else `422 TEMPLATE_OUTPUT_TOO_LARGE`) |
| `headers`    | object | No       | Custom headers, name to value (#177), e.g. `{"X-Correlation-Id": "abc", "In-Reply-To": "<parent@example.com>"}`. Rules below. Returned as `headers` on email responses (`null` when unset). |
| `category`   | string | No       | `transactional` or `marketing` (#250). Rules below. Returned as `category` on email responses (`null` when unset). |

Oversize bodies return `422 Unprocessable Entity` from the validation layer.

**Template variables** are HTML-escaped where they land in the HTML body (`{{name}}`); `{{{name}}}` inserts a value as raw HTML. Subjects and text bodies take the value as is (#250, see [templates.md](templates.md)).

**Attachments are not supported**: there is no attachments field (SMTP submission refuses a message with an attachment, see [smtp-submission.md](smtp-submission.md#what-gets-relayed)).

**Display name** (`fromName`, #250): 1 to 100 characters after trimming (the trimmed value is stored), in any script; Nodemailer RFC 2047-encodes a non-ASCII name. Refused, so a name cannot pose as an address or reorder what the client shows: control characters (CR, LF, NUL and tab included), the Unicode line and paragraph separators, the bidi controls U+202A to U+202E and U+2066 to U+2069, and any of `@`, `<`, `>`, `"`. A refused name is `422 VALIDATION_ERROR` with `details[].path` `/fromName`; the value is never echoed and nothing is queued. `from` stays the bare address everywhere else: the allowed-senders check, the DKIM domain and the envelope sender.

**Body composition** (#250): when the email has HTML and no text (after the template, if any, is rendered), a `text/plain` part is derived from the HTML at send time, so the message goes out as `multipart/alternative`; HTML without an `<html>` element is wrapped in a minimal HTML5 document at send time. Neither is stored: `html` and `text` in responses are what you sent. See [emails.md](emails.md#body-composition-250).

**Category** (`category`, #250):

- `transactional`: sent without `List-Unsubscribe` and `List-Unsubscribe-Post`. For receipts, password resets, alerts.
- `marketing`: must carry the per-recipient one-click unsubscribe link (#249), so it needs exactly one recipient (no `cc`, no `bcc`) and an `https://` `APP_BASE_URL` without a query. Otherwise `422 MARKETING_REQUIRES_ONE_CLICK`, and nothing is queued.
- Unset: as before, `List-Unsubscribe` as the domain settings and the recipient count allow. Any other value is `422 VALIDATION_ERROR`.

**Custom headers** (`headers`, #177): application headers (`X-*`) and threading headers (`In-Reply-To`, `References`). Header injection is blocked, and BunMail's own headers cannot be overridden:

- **Name:** RFC 5322 field name, printable ASCII without spaces or `:`, 1 to 64 characters.
- **Value:** no CR, LF, NUL or other control character (tab is allowed), at most 998 characters.
- **At most 20 headers**, at most **8 KB** of names plus values in total.
- **Case-insensitive:** `X-Foo` and `x-foo` together are a duplicate and refused.
- **Reserved** (any case): `From`, `Sender`, `To`, `Cc`, `Bcc`, `Reply-To`, `Subject`, `Date`, `Message-ID`, `Return-Path`, `Received`, `DKIM-Signature`, `Authentication-Results`, `Received-SPF`, `MIME-Version`, `List-Unsubscribe`, `List-Unsubscribe-Post`, `List-Id`, `Feedback-ID`, `Precedence`, `Auto-Submitted`, and names starting with `Content-`, `ARC-` or `X-BunMail-`. Use the dedicated fields (`from`, `cc`, `replyTo`, ...) and the domain's unsubscribe settings instead.

A name or value with bad syntax, or more than 20 headers, fails validation (`422 VALIDATION_ERROR`); a reserved name, a duplicate or more than 8 KB is `422 INVALID_CUSTOM_HEADER`. Either way nothing is queued, and the error names the header (when its name is valid) but never echoes the value. Nodemailer may normalize a name's case on the wire (`X-Correlation-Id` is sent as `X-Correlation-ID`).

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "msg_a1b2c3d4e5f6...",
    "from": "hello@example.com",
    "fromName": "Acme Support",
    "to": "user@example.com",
    "subject": "Welcome!",
    "status": "queued",
    "source": "api",
    "category": "transactional",
    "attempts": 0,
    "nextAttemptAt": "2026-03-15T12:00:00.000Z",
    "createdAt": "2026-03-15T12:00:00.000Z",
    "deliveryState": []
  },
  "warnings": ["spf_unverified", "dmarc_unverified"]
}
```

`warnings` (#245) lists why the email may fail authentication at the receiver, from the sender domain's stored DNS verification flags: `dkim_unverified`, `spf_unverified`, `dmarc_unverified` (that record of the registered domain is not verified), or, in development only, `domain_unregistered` (sent unsigned). It is `[]` when the domain is registered and all three records are verified. The email is queued either way, unless `REQUIRE_VERIFIED_DOMAIN=true`, which refuses a domain whose DKIM record is still unverified after one inline DNS re-check (a failure is remembered for 5 minutes per domain) with `422 SENDER_DOMAIN_UNVERIFIED`.

**Errors specific to this endpoint:** `422 SENDER_DOMAIN_NOT_REGISTERED` (production, or `REQUIRE_VERIFIED_DOMAIN=true`: register the domain first), `422 SENDER_DOMAIN_UNVERIFIED` (`REQUIRE_VERIFIED_DOMAIN=true`: publish the domain's DKIM TXT record), `404 TEMPLATE_NOT_FOUND` (`templateId` is not a template of this key), `422 SUBJECT_REQUIRED` (no inline subject and no template), `422 BODY_REQUIRED` (neither html nor text, inline or from the template, #250), `422 INVALID_CUSTOM_HEADER` (a custom header is reserved, duplicated, or over the 8 KB total, #177), `422 IDEMPOTENCY_KEY_REUSED` (the `Idempotency-Key` was used with another body, #188), `422 MARKETING_REQUIRES_ONE_CLICK` (`category: "marketing"` with more than one recipient or without an https `APP_BASE_URL`, #250), plus `RECIPIENT_SUPPRESSED`, `UNAUTHORIZED_SENDER` and `TEMPLATE_OUTPUT_TOO_LARGE` below.

**Idempotency keys** (#188). Send an optional `Idempotency-Key` request header (the convention of [draft-ietf-httpapi-idempotency-key-header](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/), as Stripe and Resend use it) to make a send safe to retry after a timeout or a 5xx:

- **Value:** 1 to 255 printable ASCII characters (`0x21` to `0x7E`, so no spaces), for example a UUID or `order-1042-shipped`. Anything else, including an empty or repeated header, is `422 VALIDATION_ERROR` with `details[].path` `/idempotency-key`, and nothing is queued.
- **First request** with a key: sent as usual; the response is unchanged and is stored with the key.
- **Retry** with the same key and the same body: nothing is created or queued; the answer is the first response (same status, same email `id`, same `status` and `warnings` as they were then) plus the response header `Idempotent-Replayed: true`. Bodies are compared as canonical JSON, so member order does not matter, but any changed value does.
- **Same key, different body:** `422 IDEMPOTENCY_KEY_REUSED`, nothing is sent. Use a new key for a new message.
- **Scope:** keys belong to the calling API key; two keys never collide or see each other's responses.
- **Lifetime:** a key is remembered for `IDEMPOTENCY_KEY_TTL_HOURS` (default 24, 1 to 168) from its first use; after that it is reusable and a request with it sends again. The purge worker deletes expired keys.
- **Failed requests store nothing:** a send refused for any reason (validation, suppression, unauthorized sender, rate limit, unregistered domain, a server error) leaves no trace, so retrying with the same key after fixing the cause sends the email.
- **Concurrent duplicates:** parallel requests with the same key create exactly one email; one gets the fresh response, the others wait for it to commit and get the replay. None fails with a 500.
- **Replays keep working after the email is gone:** the stored response is a snapshot of the email as it was queued (not its delivery status now; read that with `GET /api/v1/emails/:id`). It holds no message content: a replay fills `subject`, `html`, `text` and `headers` from the email while it exists and is not in trash; after the email is trashed or purged, the replay returns the original ids and status with those four fields `null`. `fromName` and `category` are kept in the snapshot: they label the send, they are not message content (#250).
- **Rate limit:** a replay is still a request and counts toward the per-key rate limit.
- **REST only:** the SMTP submission server has no idempotency keys.

`nextAttemptAt` is set while `status` is `queued`: the earliest time the next delivery attempt can run. After a temporary failure (for example greylisting) it moves out with the retry backoff; it is `null` once the email is sending or done.

The `source` field is the ingress channel the email arrived through: `api` (this REST endpoint) or `smtp` (the SMTP submission server, #120).

**`deliveryState`** (#250) is on every email in a response: one entry per recipient domain, or per recipient when signed return paths (#236) or a partial `RCPT TO` rejection (#250) split the domain's group. It is `[]` until the first delivery attempt (so on the send response, and on a replayed send, which returns the snapshot as queued). Entries are sorted by `mx`, then by first recipient.

```json
"deliveryState": [
  {
    "mx": "gmail-smtp-in.l.google.com",
    "recipients": ["alice@gmail.com"],
    "status": "sent",
    "attempts": 1,
    "failureKind": null,
    "failureCode": null,
    "lastError": null,
    "tls": "starttls",
    "mtaSts": "enforce",
    "updatedAt": "2026-03-15T12:00:03.120Z"
  },
  {
    "mx": "mx.example.org",
    "recipients": ["bob@example.org"],
    "status": "retry",
    "attempts": 2,
    "failureKind": "soft",
    "failureCode": "4.7.0",
    "lastError": "421 4.7.0 Try again later",
    "tls": "plaintext",
    "mtaSts": null,
    "updatedAt": "2026-03-15T12:05:10.004Z"
  }
]
```

| Field | Description |
|-------|-------------|
| `mx` | MX host of the latest outcome: the one that accepted or answered, or the last one tried (the mailer fails over across MX hosts, #250); `null` while no MX host was reached (the recipient domain did not resolve, or no host could be connected to). |
| `recipients` | The addresses this entry delivers to. |
| `status` | `sent` (accepted), `retry` (temporary failure, retried on the backoff) or `failed` (terminal). |
| `attempts` | Attempts this entry has used. |
| `failureKind` | How the last failure's SMTP reply was classified: `hard`, `policy` (the receiver refused the sender, #246) or `soft`; `null` when there was no SMTP reply (connection, DNS or TLS failure) or no failure. |
| `failureCode` | The enhanced status code of that reply, e.g. `5.1.1`; `null` without one. |
| `lastError` | The last failure's message, as stored (the same text the email's `lastError` summarises). |
| `tls` | The latest SMTP session's encryption: `starttls`, `plaintext` (the MX did not offer STARTTLS, or refused it), or `null` (no session got ready, or an entry from before #250). STARTTLS needs TLS 1.2 or later; it is opportunistic and certificates are not verified, unless the recipient domain's MTA-STS policy is in enforce mode. |
| `mtaSts` | The recipient domain's MTA-STS policy mode on the latest attempt (#250): `enforce` (only the MX hosts the policy names, STARTTLS required, certificate verified; a TLS failure or no matching MX host is `retry`, never a bounce), `testing` (delivered as without a policy), or `null` (no policy, mode `none`, or an entry from before). See [emails.md](emails.md#mta-sts-250). |
| `updatedAt` | When the latest outcome happened; `null` on entries from before #250 that were never delivered. |

---

#### `GET /api/v1/emails`

List emails for the authenticated API key with pagination.

**Query Parameters:**

| Param    | Type   | Default | Description                                  |
|----------|--------|---------|----------------------------------------------|
| `page`   | number | 1       | Page number (1-based, max 1,000,000)         |
| `limit`  | number | 20      | Items per page (1-100)                       |
| `status` | string | none    | Filter: `queued`, `sending`, `sent`, `failed`, `bounced` |
| `source` | string | none    | Filter by ingress channel: `api` or `smtp` (#137) |

---

#### `GET /api/v1/emails/:id`

Get a single email by ID. Scoped to the authenticated API key. Trashed emails are excluded: fetch them via `GET /api/v1/emails/trash`. The response includes `headers`, the custom headers set on the send (`null` when none, #177), and `deliveryState`, the per-MX delivery outcomes with their TLS record (#250, see above); list responses carry both too.

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

Restore a trashed email: clears the deletion marker so it reappears in normal lists. `404` if the email isn't currently in trash.

---

#### `DELETE /api/v1/emails/:id/permanent`

Permanently delete a trashed email immediately. Only works on rows already in trash (protects against bypassing the soft-delete workflow). Irreversible.

---

#### `POST /api/v1/emails/trash/empty`

Permanently delete every trashed email for the calling API key. Returns `{ "success": true, "deleted": <count> }`.

---

#### `GET /api/v1/emails/tombstones`

List the post-purge audit snapshots (#34) of the calling key's hard-deleted emails: identifiers only (`id`, `messageId`, `fromAddress`, `toAddress`, `subject`, `status`, `sentAt`, `deletedAt`, `purgedAt`), never the body. Optional `?messageId=` (wrapped or unwrapped form) to trace a complaint or late bounce. Paginated; kept for `TOMBSTONE_RETENTION_DAYS` (default 90). See [docs/emails.md](emails.md#tombstones-34).

---

#### `GET /api/v1/emails/tombstones/:id`

A single tombstone by the original email id (`msg_...`). `404` when none exists for the calling key.

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
| `unsubscribeUrl`    | string | No       | RFC 8058 one-click endpoint; must start with `https://`. When set, mail also carries `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. Single-recipient mail carries BunMail's own per-recipient `/u/<token>` link instead when `APP_BASE_URL` is `https://` (#249). |
| `notifyEmail`       | string | No       | Address notified when inbound mail is received for this domain (#106). Use an external mailbox. Editable later from the dashboard; empty clears it. |
| `dkimSelector`      | string | No       | DKIM selector of the domain's key (#250): one lowercase DNS label, 1 to 63 characters, `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`. Defaults to `bunmail`. Anything else is `422`. |

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "dom_a1b2c3d4e5f6...",
    "name": "example.com",
    "dkimSelector": "bunmail",
    "dkimDnsRecord": "v=DKIM1; k=rsa; p=MIIBIjAN...",
    "dkimPending": null,
    "dkimPrevious": null,
    "spfVerified": false,
    "dkimVerified": false,
    "dmarcVerified": false,
    "verifiedAt": null,
    "lastCheckedAt": null,
    "lastCheckResult": null,
    "unsubscribeEmail": null,
    "unsubscribeUrl": null,
    "notifyEmail": null,
    "dnsRecords": [
      {
        "type": "TXT",
        "host": "example.com",
        "value": "v=spf1 a:mail.example.com -all",
        "purpose": "SPF: authorizes this server to send for the domain",
        "optional": false,
        "note": "Already have an SPF record (...)? Add the a:mail.example.com term to it instead: ..."
      },
      { "type": "TXT", "host": "bunmail._domainkey.example.com", "value": "\"v=DKIM1; k=rsa; p=MIIBIjAN...\" \"...\"", "purpose": "...", "optional": false, "note": "..." },
      { "type": "TXT", "host": "_dmarc.example.com", "value": "v=DMARC1; p=none; rua=mailto:dmarc@example.com", "purpose": "...", "optional": false, "note": "..." },
      { "type": "A", "host": "mail.example.com", "value": "203.0.113.10", "purpose": "...", "optional": false, "note": "..." },
      { "type": "PTR", "host": "203.0.113.10", "value": "mail.example.com", "purpose": "...", "optional": false, "note": "..." },
      { "type": "MX", "host": "example.com", "value": "10 mail.example.com", "purpose": "...", "optional": true, "note": "..." }
    ],
    "dmarc": {
      "status": "missing",
      "ok": false,
      "reason": "No DMARC record at _dmarc.example.com",
      "warnings": [],
      "problems": [],
      "recordDomain": null,
      "inherited": false,
      "policy": null,
      "subdomainPolicy": null,
      "effectivePolicy": null,
      "pct": null,
      "adkim": null,
      "aspf": null,
      "rua": []
    },
    "mx": { "status": "elsewhere", "hosts": ["aspmx.l.google.com"] },
    "createdAt": "2026-03-15T12:00:00.000Z"
  }
}
```

The `unsubscribeEmail` / `unsubscribeUrl` fields shape the `List-Unsubscribe` header BunMail adds to every outbound message sent from this domain. See [docs/emails.md](emails.md#list-unsubscribe) for the resolution rules.

Every domain response also carries (#250):

- `dnsRecords`: the records to publish, each `{ type, host, value, purpose, optional, note?, pending? }`: SPF, DKIM (pre-split into quoted strings of at most 255 characters; `dkimDnsRecord` keeps the unsplit value), the pending key's DKIM record while a key rotation is pending (`pending: true`), a starting DMARC record, the A/AAAA and PTR records of `MAIL_HOSTNAME`, and an `optional` MX. See [docs/domains.md](domains.md#dns-records-to-publish-dnsrecords-250).
- `dmarc`: the current DMARC check. `status` is `pass`, `missing`, `multiple` (two or more records), `invalid` (no valid `p=`) or `error` (DNS failure); `ok` is true only for `pass`. `inherited` is true when the organizational domain's record applies, `effectivePolicy` is the policy receivers apply (`sp` when inherited and set, else `p`), `warnings` flag weak settings (`p=none`, `pct` below 100, no `rua`) and `problems` the invalid tag values. See [docs/domains.md](domains.md#dmarc-rules-250).
- `dkimPending` and `dkimPrevious` (DKIM key rotation): see [Key rotation](#post-apiv1domainsiddkimrotate) below. Both are `null` when no rotation is pending and none was completed. No private key, active or pending, is ever returned.
- `verifiedAt`: when SPF, DKIM and DMARC all passed; kept while they keep passing (or a lookup fails), `null` when not verified or after the domain flipped to failing (two definitive failures in a row). Before #250 it was set by every verify, whatever the result.
- `lastCheckedAt` and `lastCheckResult`: when the DNS checks last ran (by verify or the daily re-verification loop) and what each found: `{ spf, dkim, dmarc, checkedAt }`, each `{ status, reason }` with `status` `pass`, `fail` (record missing or wrong) or `unknown` (the lookup failed; it changes nothing). Both `null` before the first check. See [docs/domains.md](domains.md#scheduled-re-verification-250).
- `mx`: `{ status, hosts }`, where the domain's MX points: `here` (`MAIL_HOSTNAME`), `elsewhere`, `none` or `error`. Informational: nothing requires the MX to point at BunMail.

`dmarc` and `mx` come from live DNS on `GET` (list and single) and on verify, cached for an hour (five minutes after an error). Each domain's DMARC and MX lookups run in parallel under one 5 s deadline, after which a status is `error`; a DNS failure never fails the request. The list looks up at most 8 domains at once. Create (`POST`), update (`PATCH`) and `DELETE` never wait on DNS: they return `dmarc` and `mx` as `null` (not checked yet), so a new domain shows `null` until the next `GET` or verify. The example above is a `GET` response.

---


The name is stored lowercase (DNS names are case-insensitive), and every lookup by name ignores case, also for domains registered before that. Registering a name that already exists in any case returns `409 DOMAIN_ALREADY_REGISTERED`.

#### `GET /api/v1/domains`

List all registered sender domains.

---

#### `GET /api/v1/domains/:id`

Get a single domain by ID.

---

#### `POST /api/v1/domains/:id/verify`

Trigger DNS verification for SPF, DKIM, and DMARC records. The result is stored with the same rules as the re-verification loop (#250): a failed lookup is `unknown` and changes nothing, a verified record stays verified until the second failure in a row, and `verifiedAt` is set only when all three pass.

**Response:**

```json
{
  "success": true,
  "data": { "...updated domain..." },
  "verification": {
    "spf": true,
    "dkim": false,
    "dmarc": true,
    "spfReason": "SPF passes for 203.0.113.10",
    "dkimReason": "No TXT record at bunmail._domainkey.example.com",
    "dmarcReason": "DMARC policy quarantine at _dmarc.example.com",
    "checks": {
      "spf": { "status": "pass", "reason": "SPF passes for 203.0.113.10" },
      "dkim": { "status": "fail", "reason": "No TXT record at bunmail._domainkey.example.com" },
      "dmarc": { "status": "pass", "reason": "DMARC policy quarantine at _dmarc.example.com" },
      "checkedAt": "2026-10-19T12:00:00.000Z"
    }
  }
}
```

`spf` is true only when the domain publishes exactly one SPF record that gives `pass` for every sending IP of this server (`MAIL_PUBLIC_IP`, or the A/AAAA records of `MAIL_HOSTNAME`), evaluated per RFC 7208 (#247). `spfReason` says why it passed or failed (no record, two records, a placeholder, more than 10 lookups, `fail`/`softfail` for an IP, a temporary DNS failure).

`dmarc` is true only when exactly one `v=DMARC1` record with a valid `p=` applies, at `_dmarc.<domain>` or inherited from the organizational domain; `p=none` passes (#250). `dmarcReason` says why. The domain's `dmarc` field carries the parsed record.

---

#### `PATCH /api/v1/domains/:id`

Edit the domain's `List-Unsubscribe` overrides (#243). Omitted fields stay unchanged; `null` clears one (back to `unsubscribe@<name>`, or no one-click URL).

| Field              | Type           | Required | Description |
|--------------------|----------------|----------|-------------|
| `unsubscribeEmail` | string \| null | No       | Mailbox for `List-Unsubscribe: <mailto:...>` |
| `unsubscribeUrl`   | string \| null | No       | One-click endpoint, `https://` only |

Returns the updated domain, or `404` if it doesn't exist.

---

#### `DELETE /api/v1/domains/:id`

Delete a domain (hard delete).

---

#### `POST /api/v1/domains/:id/dkim/rotate`

Start a DKIM key rotation (#250). Generates a new 2048-bit RSA key under a dated selector `bm<YYYYMMDD>` (UTC; `-2`, `-3`, ... when that name is the current or previous selector) and stores it as pending. **Mail stays signed with the current key** until the rotation is completed.

**Response:**

```json
{
  "success": true,
  "data": {
    "...domain...": "...",
    "dkimSelector": "bunmail",
    "dkimPending": {
      "selector": "bm20261019",
      "host": "bm20261019._domainkey.example.com",
      "dnsRecord": "v=DKIM1; k=rsa; p=MIIBIjAN...",
      "createdAt": "2026-10-19T09:00:00.000Z"
    }
  },
  "dnsRecord": {
    "type": "TXT",
    "host": "bm20261019._domainkey.example.com",
    "value": "\"v=DKIM1; k=rsa; p=MIIBIjAN...\" \"...\"",
    "purpose": "DKIM (pending rotation): the next key, published before the switch",
    "optional": false,
    "pending": true,
    "note": "..."
  }
}
```

`dnsRecord` is the TXT record to publish **next to** the current one, split into quoted strings of at most 255 characters; it is also in `data.dnsRecords`. `409 DKIM_ROTATION_PENDING` when a rotation is already pending; `404` for an unknown domain.

---

#### `POST /api/v1/domains/:id/dkim/rotate/complete`

Switch to the pending key (#250). BunMail looks up `<pending selector>._domainkey.<domain>` and compares it with the pending public key, as verify does. When it matches, one transaction makes the pending key the active one (`dkimSelector` becomes the pending selector, `dkimVerified` becomes `true`) and returns the old selector as `dkimPrevious`:

```json
"dkimPrevious": {
  "selector": "bunmail",
  "host": "bunmail._domainkey.example.com",
  "dnsRecord": "v=DKIM1; k=rsa; p=MIIBIjAN...",
  "rotatedAt": "2026-10-19T09:30:00.000Z",
  "advice": "Keep its DNS record published for at least 7 days after the switch, then remove it."
}
```

`dkimPrevious` is informational: BunMail never signs with it (its private key is dropped at the switch). Otherwise nothing changes and the answer is `409` with a `code`:

- `DKIM_PENDING_NOT_PUBLISHED`: the record is missing, carries another key, or the lookup failed; `error` says which.
- `DKIM_NO_PENDING_ROTATION`: no rotation is pending.
- `DKIM_PENDING_KEY_UNREADABLE`: the pending private key does not decrypt with `DKIM_ENCRYPTION_KEY`; cancel and start again.

`POST /api/v1/domains/:id/verify` never completes a rotation on its own.

---

#### `DELETE /api/v1/domains/:id/dkim/rotate`

Cancel the pending rotation (#250): the pending key is dropped, the active key is untouched. `409 DKIM_NO_PENDING_ROTATION` when none is pending; `404` for an unknown domain.

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
| `html`      | string   | No       | HTML body template (max 5 MB)            |
| `text`      | string   | No       | Plain text body template (max 5 MB)      |
| `variables` | string[] | No       | Variable names (max 100, each `^\w+$`, max 100 chars) |

---

#### `GET /api/v1/templates`

List templates for the authenticated API key, oldest first. Paginated (#258): optional `page` and `limit` (default and maximum `100`, see [Pagination](#pagination)); the response carries `pagination: { page, limit, total }`.

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

Allowed events: `email.queued`, `email.sent`, `email.failed`, `email.bounced`, `email.complained`, `email.received`, `email.unsubscribed` (#249), `domain.verification_failed`, `domain.verified` (#250)

Events are delivered only for the requesting key's own emails. `email.received` (inbound mail) and the domain events are admin-only: a restricted key subscribing to one gets `403` with `code: "INBOUND_EVENTS_REQUIRE_ADMIN"`.

A key may have at most `WEBHOOKS_MAX_PER_API_KEY` webhooks (default 10, #258). One more gets `422` with `code: "WEBHOOK_LIMIT_REACHED"`; webhooks that already exceed the cap are kept.

**Response includes `secret`**: shown once, used for HMAC signature verification.

---

#### `GET /api/v1/webhooks`

List webhooks for the authenticated API key, oldest first. Secrets are not included. Paginated (#258): optional `page` and `limit` (default and maximum `100`, see [Pagination](#pagination)); the response carries `pagination: { page, limit, total }`.

---

#### `DELETE /api/v1/webhooks/:id`

Delete a webhook. Its delivery history is deleted with it.

---

#### `GET /api/v1/webhooks/:id/deliveries`

List the delivery attempts of one of the calling key's webhooks (#30), newest first. Optional `?status=pending|delivered|failed`. Paginated; `404` for a webhook of another key.

---

#### `GET /api/v1/webhooks/deliveries/:deliveryId`

A single delivery with its payload and the last response (status and a 2 KB body preview).

---

#### `POST /api/v1/webhooks/deliveries/:deliveryId/replay`

Replay a delivery: it goes back to `pending` with its attempts reset, and the worker sends it on its next tick. See [docs/webhooks.md](webhooks.md#delivery-behavior).

At most 5 replays per delivery per hour (#258): one more gets `429` with a `Retry-After` header (seconds) and `code: "REPLAY_LIMIT_REACHED"`.

---

### Inbound

All inbound endpoints are prefixed with `/api/v1/inbound`.

#### `GET /api/v1/inbound`

List received emails (paginated, newest first).

**Query Parameters:**

| Param   | Type   | Default | Description           |
|---------|--------|---------|-----------------------|
| `page`  | number | 1       | Page number (max 1,000,000) |
| `limit` | number | 20      | Items per page (1-100)|

---

#### `GET /api/v1/inbound/:id`

Get a received email by ID. Trashed inbound emails are excluded: fetch them via `GET /api/v1/inbound/trash`.

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

> **Admin-only.** Reports cover every registered domain (sending IPs, volumes, authentication results), so a restricted key gets `403 ADMIN_REQUIRED`, like `/api/v1/domains` and `/api/v1/inbound`.

#### `GET /api/v1/dmarc-reports`

List parsed reports (paginated, newest report-end-date first).

**Query Parameters:**

| Param    | Type   | Default | Description                       |
|----------|--------|---------|-----------------------------------|
| `page`   | number | 1       | Page number (max 1,000,000)       |
| `limit`  | number | 20      | Items per page (1-100)            |
| `domain` | string | none    | Filter by reporting policy domain |

Each row carries the report-level metadata (`orgName`, `orgEmail`, `domain`, `dateBegin`, `dateEnd`, `policyP`, `policyPct`, `receivedAt`). Per-source-IP records are returned only by the detail endpoint.

---

#### `GET /api/v1/dmarc-reports/:id`

Get a single report with its per-source-IP records and computed alignment totals (`messages`, `dkimAligned`, `spfAligned`, `bothAligned`).

---

### API Keys

All API key endpoints are prefixed with `/api/v1/api-keys`.

> **Admin-only (#130).** Every route here requires an **admin** key; a restricted key gets `403 ADMIN_REQUIRED`. The same gate applies to `/api/v1/domains`, `/api/v1/inbound` and `/api/v1/dmarc-reports`. `is_admin` is shown in responses but is **not settable via the API**, only from the dashboard. See [docs/api-keys.md](api-keys.md#admin-vs-restricted-keys-130).

> **Ownership (#219).** Keys, templates, webhooks and domains created through the API belong to the dashboard user who owns the calling key (its `createdByUserId`; `null` = the owner). Key responses carry `createdByUserId` and `disabledReason` (`revoked`, `creator_deactivated`, `creator_removed`, or `null` while active). A key disabled because its user was deactivated or removed, or whose user is deactivated, is rejected with `401` like a revoked one. `POST /api/v1/api-keys` with a calling key whose user is deactivated or gone is refused with `403` and `code: "API_KEY_CREATOR_INACTIVE"`.

#### `POST /api/v1/api-keys`

Create a new API key. The raw key is returned **once**: store it securely.

**Request Body:**

| Field            | Type     | Required | Description                        |
|------------------|----------|----------|------------------------------------|
| `name`           | string   | Yes      | Human-readable label (1-100 chars) |
| `allowedSenders` | string[] | No       | Allowlist of `From` addresses this key may send from (#126). Omit or `[]` = unrestricted. Each must be a valid email; max 100. |

The response includes `allowedSenders`, and `createdByUserId` (the calling key's, #219).

---

#### `GET /api/v1/api-keys`

List all API keys (active and revoked). Key hashes are never exposed.

---

#### `PATCH /api/v1/api-keys/:id`

Update a key's `name` and/or `allowedSenders` (#126). Both optional, only provided fields change. `allowedSenders` **replaces** the whole list (add an address by including it, remove one by omitting it; `[]` clears it back to unrestricted). Returns the serialized key, or `404` if not found.

**Request Body:**

| Field            | Type     | Required | Description                    |
|------------------|----------|----------|--------------------------------|
| `name`           | string   | No       | New label (1-100 chars)        |
| `allowedSenders` | string[] | No       | New allowed-senders list       |

---

#### `DELETE /api/v1/api-keys/:id`

Revoke an API key (soft delete). The key stops working everywhere at once: REST calls, sending over an already-open SMTP submission session, and its webhooks (no further events, queued deliveries are failed).

---

### Suppressions

Per-API-key suppression list: addresses we refuse to send to. See [`docs/suppressions.md`](suppressions.md) for scoping rules, the bounce-handling roadmap, and the schema.

All endpoints are prefixed with `/api/v1/suppressions`.

#### `POST /api/v1/suppressions`

Manually add an address. Idempotent: re-suppressing an existing `(api_key, email)` upserts the row, except over a permanent `complaint` (#191): that row is left as it is and returned (`reason: "complaint"` in the response). Delete it first to replace it.

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

No row is inserted into `emails`, no queue entry is created. With `SUPPRESSIONS_SHARED_HARD=true` (#250) the same response is returned for an address another API key holds an automatic permanent hard bounce or complaint for, with `"suppressionId": null`: that row is not the caller's, so it is never named. See [suppressions.md](suppressions.md#shared-hard-suppressions-suppressions_shared_hard-250).

### SMTP Submission

Usage stats + quota status for the SMTP **submission** server (#120/#123): the AUTH-required SMTP listener that lets apps send *through* BunMail. The server itself has no HTTP routes; this is the one read-only REST surface. Full setup: [`docs/smtp-submission.md`](smtp-submission.md).

#### `GET /api/v1/smtp-submission/stats`

Per-day accepted/rejected counts for messages the calling API key sent via SMTP submission, plus the key's daily-quota status. Scoped to the calling key.

**Query Parameters:**

| Param  | Type   | Default | Description                                      |
|--------|--------|---------|--------------------------------------------------|
| `days` | number | 30      | Trailing UTC-day window (inclusive of today), 1 to 365 |

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

Some responses carry additional structured fields: e.g. suppression-list rejection is `422` with `code: "RECIPIENT_SUPPRESSED"` + `suppressionId` (pivot to `DELETE /api/v1/suppressions/:id`; `null` for a shared suppression of another key, #250); a sender-authorization rejection (#126) is `403` with `code: "UNAUTHORIZED_SENDER"` + `sender` (the `From` that was rejected: add it to the key's `allowedSenders` via `PATCH /api/v1/api-keys/:id` if intended).

| Status | Meaning                                         |
|--------|-------------------------------------------------|
| 400    | Malformed request body, e.g. invalid JSON (`INVALID_BODY`) |
| 401    | Missing or invalid token, or the sending key was revoked (`API_KEY_REVOKED`) |
| 403    | Authenticated but not permitted: `From` not in the key's allowed-senders list (`UNAUTHORIZED_SENDER`), or a restricted key calling an admin-only endpoint (`ADMIN_REQUIRED`, #130), or a restricted key subscribing a webhook to `email.received`, `domain.verified` or `domain.verification_failed` (`INBOUND_EVENTS_REQUIRE_ADMIN`), or creating an API key with a key whose dashboard user is deactivated or removed (`API_KEY_CREATOR_INACTIVE`, #219) |
| 404    | Resource not found, or a send's `templateId` is not a template of the calling key (`TEMPLATE_NOT_FOUND`, #245) |
| 413    | Request body larger than 12 MB (rejected before it is read) |
| 422    | Validation error: `VALIDATION_ERROR` with `details: [{ path, message }]` (the submitted values are never echoed), a webhook URL rejected by the SSRF guard (`WEBHOOK_URL_BLOCKED`, #128), a rendered template over its size limit (`TEMPLATE_OUTPUT_TOO_LARGE`), or a send refused on its sender, subject or body (#245, #250): `SENDER_DOMAIN_NOT_REGISTERED`, `SENDER_DOMAIN_UNVERIFIED` (`REQUIRE_VERIFIED_DOMAIN=true`), `SUBJECT_REQUIRED` or `BODY_REQUIRED`, or a suppressed recipient (`RECIPIENT_SUPPRESSED`), or on a custom header (`INVALID_CUSTOM_HEADER`, #177), or an `Idempotency-Key` reused with another body (`IDEMPOTENCY_KEY_REUSED`, #188), or a `marketing` send that cannot carry the one-click unsubscribe link (`MARKETING_REQUIRES_ONE_CLICK`, #250), or a webhook create past `WEBHOOKS_MAX_PER_API_KEY` (`WEBHOOK_LIMIT_REACHED`, #258), or a DKIM selector that is not one lowercase DNS label (`VALIDATION_ERROR` on `POST /api/v1/domains`; `INVALID_DKIM_SELECTOR` from the service, #250) |
| 409    | `DOMAIN_ALREADY_REGISTERED`: `POST /api/v1/domains` with a name already registered, compared case-insensitively; a DKIM key rotation step refused on the domain's state (#250): `DKIM_ROTATION_PENDING`, `DKIM_NO_PENDING_ROTATION`, `DKIM_PENDING_NOT_PUBLISHED`, `DKIM_PENDING_KEY_UNREADABLE` |
| 429    | Rate limit exceeded, or a delivery replayed 5 times this hour (`REPLAY_LIMIT_REACHED`, #258); both send `Retry-After` |
