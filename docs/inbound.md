# Inbound Module

Receives emails via a built-in SMTP server and stores them in the database.

## Replying from the dashboard (#86)

Inbound email detail pages have a **Reply** button that opens the compose form with a reply skeleton pre-populated:

- **From** = the address that received the inbound (the user's own address), so SPF / DKIM / DMARC alignment is preserved.
- **To** = the original sender.
- **Subject** = original subject prefixed with `Re: ` (idempotent: already-`Re:`-prefixed subjects aren't double-prefixed).
- **HTML body** = original HTML wrapped in a `<blockquote>` with an `On <date>, <sender> wrote:` attribution line.
- **Text body** = original text quoted with `> ` line prefixes + the same attribution.

The reply route is `GET /dashboard/inbound/:id/reply`: a normal navigation, no side effects until the operator clicks Send. The operator can edit any field before sending, including swapping the From domain or rewriting the quoted body.

## Threading (#192)

Replies thread in the recipient's mail client, and replies to BunMail's own mail are linked back to it.

- **Capture on receipt.** The receiver reads the first `Message-ID`, `In-Reply-To` and `References` field of every stored message (from mailparser's raw header lines, unfolded) into `inbound_emails.message_id`, `in_reply_to` and `references`. The values are attacker-controlled, so only syntactically valid msg-ids are kept: `<id-left@id-right>`, printable ASCII without spaces (a dot-atom left part, a dot-atom or `[literal]` right part), at most 250 characters each, brackets included. Comments, junk, quoted or obsolete forms, overlong ids and anything with CR, LF or NUL are dropped; ids are deduplicated and kept in order, space-separated. `in_reply_to` and `references` hold at most 20 ids (for a longer chain, the first id, the thread root, and the newest 19). A field without a valid id stores `null`. Rules: `services/threading.ts` (pure, linear time).
- **Reply headers.** The reply form carries the inbound email's id (a hidden `inboundId` field), never header text. `POST /dashboard/send` computes `In-Reply-To: <original Message-ID>` and `References: <original References> <original Message-ID>` (RFC 5322 section 3.6.4: appended, never replaced; an original without `References` whose `In-Reply-To` holds a single id starts the chain with it). Stored values are parsed again before use. The chain is capped to 20 ids and to 998 characters, dropping the oldest ids after the first. The pair goes through the custom-header rules (#177) like any other `headers`, so it is validated, stored on `emails.headers` and DKIM-signed. An original without a valid `Message-ID` is answered without threading headers (logged at `debug`). The subject keeps the `Re: ` rule above.
- **Rows received before #192** have null columns. On the first reply the ids are recovered from `raw_message` (the header section only, at most 64 KB, through mailparser) and stored on the row; there is no backfill job.
- **Linking a reply to our email.** When a received message's `In-Reply-To` or `References` (most direct first) names the `Message-ID` of an email BunMail sent, the receiver stores that email's id in `inbound_emails.in_reply_to_email_id` (`ON DELETE SET NULL`). The match only counts when the email's sender domain is one of the domains the message was received for (the envelope `RCPT TO` domains, never the `To:` header), so one tenant's inbound mail never links to another tenant's outbound mail. The inbound detail page shows "In reply to: <subject> sent <date>", linking to the email's page (every role that may open the inbound page may open the email page). A failed lookup is logged at `warn` (SQLSTATE only) and the message is stored without a link.
- **Manual check:** confirm threading once in a real client (Gmail or Apple Mail): reply from the dashboard to a received message and check the reply lands in the same conversation. The automated tests check the headers, not a client's grouping.

## Bounce branching

With `SMTP_ENABLED=true`, outbound mail from a domain whose MX points at this BunMail is sent with a signed per-recipient return path, `b+<id>.<index>.<MAC>@<sender domain>` (#236), so DSNs come back to that address. The receiver handles such recipients itself, independent of recipient domain validation (the `b+` local part is reserved):

- **RCPT TO** `b+...@<domain>` (any case): accepted only when the address verifies against the email it names (the MAC over email id, recipient index and recipient, and the domain must be that email's sender domain). Invalid: refused with SMTP `550`, nothing stored. A database error answers `451`.
- **DATA**, before every other branch: a DSN to a verified return path is routed to the bounce handler and applies to exactly the bound email and recipient, whatever its body says. Anything else sent there (auto-replies, vacation notices, ARF reports) is acknowledged and dropped. Either way the message is **not stored**, fires no `email.received` and no inbound notification; if it was also addressed to other mailboxes, only those continue below.
- A DSN sent to any **other** address (not a verified return path) has no effect: logged at `warn`, acknowledged, not stored.

See [docs/bounces.md](bounces.md#signed-return-paths-236) for the address format and the bounce flow.

## Unsubscribe mailbox (#249)

Single-recipient outbound mail carries `List-Unsubscribe: <mailto:unsub+<token>@<sender domain>>` when `SMTP_ENABLED=true` (see [suppressions.md](suppressions.md#one-click-unsubscribe)). The receiver handles such recipients itself, independent of recipient domain validation:

- **RCPT TO** `unsub+<token>@<domain>` (any case): the token is verified against its email row and the domain must be that email's sender domain. Invalid: refused with SMTP `550` (nothing stored; the sending MTA, not BunMail, tells its user, so no backscatter to a forged sender). A database error answers `451` (try again later).
- **DATA**, before the feedback-loop, bounce and DMARC branches: each `unsub+` recipient is suppressed (`source: "mailto"`). A message addressed only to such recipients is acknowledged and **not stored**, fires no `email.received` and no inbound notification. If it was also addressed to other mailboxes, only those continue through normal storage, and the notification goes to them alone. The size cap applies as for any message.

Why bounce branching matters: bounces shouldn't pollute the inbound list (operators get noise about delivery failures from `mailer-daemon@gmail` every time someone mistypes an address), and the suppression-list auto-update only happens when bounces are processed as bounces.

## Feedback-loop branch (#191)

ARF complaint reports (`multipart/report; report-type=feedback-report`, RFC 5965) from mailbox-provider feedback loops are recognised in DATA, after the `unsub+` branch and **before** the bounce parser and the DMARC branch. They go to the feedback handler (`feedback-handler.service.ts`), which links the report to an email BunMail sent by its Message-ID and suppresses the recipient who complained (`complaint`) or, for `opt-out`, unsubscribes them, firing `email.complained` or `email.unsubscribed` to the sending key's webhooks. Whatever the outcome (handled, unlinkable, ignored type, unparseable), the report is acknowledged, **not stored** in `inbound_emails`, fires no `email.received` and no inbound notification. See [feedback-loops.md](feedback-loops.md).

## Module Layout

```
src/modules/inbound/
├── inbound.plugin.ts                ← Elysia plugin: list, get, trash/restore/permanent/empty
├── services/
│   ├── smtp-receiver.service.ts     ← SMTP server (smtp-server + mailparser)
│   ├── arf-parser.service.ts        ← Pure ARF feedback-report parser (#191)
│   ├── feedback-handler.service.ts  ← Feedback report → complaint / opt-out suppression + webhook (#191)
│   ├── dnsbl.service.ts             ← DNSBL lookup + pure skip decision (no DB)
│   ├── inbound-notify.service.ts    ← Inbound arrival notification emails
│   ├── notify-throttle.ts           ← Notification budgets: 5 per address, 30 per domain, per 10 min (#250)
│   ├── threading.ts                 ← Pure msg-id extraction and reply chain rules (#192)
│   ├── reply-threading.service.ts   ← Threading columns, reply headers, reply link (#192)
│   └── inbound.service.ts           ← Reads + trash/restore/permanent/empty (DB layer)
├── models/
│   └── inbound-email.schema.ts      ← Drizzle pgTable definition
├── serializations/
│   └── inbound.serialization.ts     ← Response mapper (strips raw message)
└── types/
    ├── inbound.types.ts             ← InboundEmail type
    └── feedback-report.types.ts     ← Parsed ARF report, action, outcome (#191)
```

## Database Schema

Table: `inbound_emails`

| Column       | Type           | Constraints                |
|--------------|----------------|----------------------------|
| id           | varchar(36)    | PK, prefixed `inb_`       |
| from_address | varchar(255)   | NOT NULL                   |
| to_address   | varchar(255)   | NOT NULL                   |
| subject      | varchar(500)   | nullable                   |
| html         | text           | nullable                   |
| text_content | text           | nullable                   |
| raw_message  | text           | nullable (full RFC 822)    |
| message_id   | text           | nullable, valid msg-id (#192) |
| in_reply_to  | text           | nullable, up to 20 valid msg-ids (#192) |
| references   | text           | nullable, up to 20 valid msg-ids (#192) |
| in_reply_to_email_id | varchar(36) | nullable, FK `emails.id` `ON DELETE SET NULL` (#192) |
| received_at  | timestamp      | NOT NULL, default `now()`  |
| deleted_at   | timestamp      | nullable                   |

`deleted_at` is the soft-delete marker: set when an inbound email is moved to trash. Auto-purged after `TRASH_RETENTION_DAYS`.

**Indexes:** `idx_inbound_received_at`, `idx_inbound_deleted_at`, `idx_inbound_in_reply_to_email_id`. The reply link looks emails up through `idx_emails_message_id` (migration `0031`).

## Configuration

| Env Variable   | Default | Description                                |
|----------------|---------|--------------------------------------------|
| `SMTP_ENABLED` | `false` | Set to `true` to start the SMTP server     |
| `SMTP_PORT`    | `2525`  | Port for the inbound SMTP server           |

In production, set `SMTP_PORT=25` and configure your domain's MX record to point to your server.

### First-boot checklist (Docker Compose)

Inbound is **off by default**: sending-only is the common use case, and an open SMTP receiver is a footgun if it isn't configured deliberately. To turn it on with Docker Compose, three things have to agree:

1. **`.env`**: set `SMTP_ENABLED=true` and `SMTP_PORT=25`.
2. **`docker-compose.override.yml`**: publish the inbound SMTP port, using the inbound example in `docker-compose.override.example.yml` (#205). The base `docker-compose.yml` publishes no SMTP port, so a fresh checkout never binds host port 25 unexpectedly.
3. **DNS**: add an `MX` record for your domain pointing at the host running BunMail.

Then `docker compose up -d --build`. From outside the host, verify with `nc -zv <your-host> 25`: the connection should be accepted. If it isn't, check `docker compose logs app` for the line `Inbound SMTP receiver disabled`: that means step 1 wasn't picked up.

## Spam Protection

Three layers of protection run before any email is processed. All are enabled by default.

### Layer 1: DNSBL IP Check

Checks the connecting IP against a DNS blackhole list (default: [Spamhaus ZEN](https://www.spamhaus.org/zen/)). Blacklisted IPs are rejected with SMTP 554 before they can send data.

| Env Variable         | Default              | Description                     |
|----------------------|----------------------|---------------------------------|
| `SMTP_DNSBL_ENABLED` | `true`              | Enable/disable DNSBL checks     |
| `SMTP_DNSBL_ZONE`    | `zen.spamhaus.org`  | DNSBL zone to query             |

Addresses that aren't publicly routable skip the DNSBL check: private (`10/8`, `172.16/12`, `192.168/16`), loopback (`127/8`), link-local (`169.254/16`), CGNAT (`100.64/10`) and reserved ranges, using the same numeric range checks as the webhook SSRF guard. IPv6 addresses also skip it, since most DNSBL zones don't index them. Every other public IPv4 address is checked.

### Layer 2: Connection Rate Limiting

Per-IP sliding window rate limit on SMTP connections. Exceeding the limit returns SMTP 421 (temporary rejection).

| Env Variable            | Default | Description                       |
|-------------------------|---------|-----------------------------------|
| `SMTP_RATE_LIMIT_ENABLED` | `true` | Enable/disable rate limiting     |
| `SMTP_RATE_LIMIT_MAX`    | `10`   | Max connections per IP per window |
| `SMTP_RATE_LIMIT_WINDOW` | `60`   | Window size in seconds           |

### Layer 3: Recipient Domain Validation

Rejects mail addressed to domains not registered in BunMail's Domains table. This prevents your server from being used as an open relay.

| Env Variable                | Default | Description                             |
|-----------------------------|---------|-----------------------------------------|
| `SMTP_RECIPIENT_VALIDATION` | `true`  | Enable/disable recipient domain checks  |

### Layer 4: Envelope and Stream Hardening

Always-on protections (no env toggles):

- **Message size cap:** 10 MB. Advertised via the `SIZE` ESMTP extension and enforced inside the data stream: oversize messages are rejected with SMTP 552 and the buffered chunks are dropped immediately.
- **Recipient cap:** 50 RCPT TO commands per transaction. Beyond that the server replies SMTP 452 (too many recipients) so the connection can't be used as a fan-out relay.
- **MAIL FROM validation:** rejects addresses that don't match a basic email shape with SMTP 553. The empty envelope sender (`<>`) is allowed because it's how DSN bounces address themselves per RFC 3464.

### Fail-Open Design

All three layers fail open on errors (DNS timeout, DB unreachable). This means legitimate mail is never silently dropped due to transient failures.

## How It Works

1. Client connects → rate limit check (instant) → DNSBL check (DNS lookup)
2. RCPT TO command → `unsub+<token>` addresses (#249) and `b+` return paths (#236) verified, others validated against registered domains
3. DATA command → `unsub+` recipients suppressed (#249), mail to verified return paths handled (DSNs bounce the bound recipient, the rest is dropped, #236), feedback-loop reports handled (#191), DSNs to any other address dropped, then the message is parsed with `mailparser`
4. Sender, recipient, subject, HTML, text, raw message, the validated threading ids and the link to the email it replies to (#192) stored in `inbound_emails`
5. `email.received` webhook event fired to all subscribed webhooks
6. If the recipient domain has a `notify_email` set, a summary notification email is sent (fire-and-forget), see below

Unsubscribe requests, mail to return paths, feedback-loop reports, bounces (DSNs) and DMARC aggregate reports are detected earlier and routed to their own handlers; they are **not** stored in `inbound_emails` and never fire steps 5 to 6.

The `info` line logged for a stored message (`Inbound email received and stored`) carries its id, the redacted sender and recipient and the size in bytes, never the subject or body text (#250); only the subject's length is logged, at `debug`.

## Inbound Notifications (#106)

A domain can opt in to email notifications by setting its `notify_email`
(per domain: from the dashboard's domain detail page, or the `notifyEmail`
field on `POST /api/v1/domains`). When mail is received for that domain,
BunMail sends a short "you have new mail" email to the notify address.

- The notification is sent **from** `<INBOUND_NOTIFY_FROM_LOCAL>@<recipient
  domain>` (default `notifications@<domain>`) and DKIM-signed with that
  domain's own key: same SPF/DKIM as outbound. It carries
  `Auto-Submitted: auto-generated` and `X-Auto-Response-Suppress: All`, so
  auto-responders do not answer it (#250).
- It is sent fire-and-forget after the inbound row is stored, so it never
  delays the SMTP acknowledgement.
- **Loop guard:** mail whose sender domain is itself a registered BunMail
  domain is skipped (a notification that loops back in won't re-notify). Point
  `notify_email` at an external mailbox.
- **Kill switch:** `INBOUND_NOTIFY_ENABLED=false` disables all inbound
  notifications regardless of per-domain settings.

### What a notification contains (#250)

Because the operator's own domain signs it, a notification does not relay
the inbound message's content by default. Plain text only, no HTML part:

- **Subject:** always `New email for <recipient address>`, never the
  inbound subject.
- **Body:** the recipient address, who it is from (the sender address, as
  plain text), when it arrived, its size and, when `APP_BASE_URL` is set,
  the link to view it in the dashboard.
- **`INBOUND_NOTIFY_PREVIEW=true`** (default `false`, strict `true`/`false`)
  adds the original subject and a preview of up to 200 characters to the
  body, never to the subject line. Both are flattened to one line (CR/LF and
  other control characters removed) and every `http://`, `https://` and
  `www.` link is replaced by `[link removed]`. The same link removal applies
  to the sender and recipient addresses shown.

### Automatic mail is not notified (#250)

No notification is sent, and a `debug` line is logged, when the inbound
message is itself automatic: `Auto-Submitted` with any value other than
`no` (RFC 3834), `Precedence: bulk`, `junk` or `list`, an `X-Autoreply` or
`X-Autorespond` header, or a null return path (`MAIL FROM:<>`). The message
is still stored and still fires `email.received`.

### Notification budgets (#250)

Two fixed-window budgets apply (code constants in `notify-throttle.ts`), and
a notification needs both:

- each recipient address gets at most **5 notifications per 10 minutes**;
- each recipient domain gets at most **30 notifications per 10 minutes**,
  whatever the addresses, so a domain that accepts any local part cannot be
  flooded through many addresses with a budget each.

Later mail is stored as usual but not notified individually. The first
message skipped in a window logs `Inbound notifications throttled for this
address` or `Inbound notifications throttled for this domain` at `info`
(once per window per address or per domain). A skipped message is counted
against its address either way, and the next notification for that address
adds "And N more emails since <time>". A message skipped by one budget does
not use up the other. There is no timer that reports a count on its own:
when no more mail arrives for the address, the count is dropped after a day
(the dashboard still lists every message).

The budgets live in memory: they are **per replica** (two replicas allow up
to twice the budgets) and reset on restart.

> **Limitations.** The inbound path does **not** verify SPF/DKIM/DMARC on
> received mail today, so the sender address in a notification is whatever
> the (unauthenticated) message claimed: treat it as untrusted, exactly like
> the inbox itself. It is shown as plain text, links removed, but a mail
> client may still turn an address or a bare domain name into a link. With
> `INBOUND_NOTIFY_PREVIEW=true` the same holds for the subject and preview:
> only `http://`, `https://` and `www.` links are removed, not bare domain
> names. Inbound sender authentication is tracked as a follow-up on #106.

See [docs/domains.md](domains.md#inbound-notifications-106) for the field and endpoints.

## Service Methods

### smtp-receiver.service.ts

#### `start(notifyDeps?): void`
Starts the SMTP server on the configured port. `notifyDeps` (mailer, clock,
notification throttle) default to the production ones; tests inject their own.

#### `stop(): void`
Gracefully shuts down the SMTP server.

### inbound-notify.service.ts (#106, #250)

#### `notifyInboundReceived(input, deps?): Promise<void>`
Sends the notification for every accepted recipient domain with a
`notify_email`, after the automatic-mail check, the loop guard and the
per-recipient throttle. Never throws.

#### `buildInboundNotification(input): { subject, text }`
Pure. Composes the plain-text notification described above.

#### `automaticInboundReason(headerLines, returnPath): reason | null`
Pure. Why a message counts as automatic (`null_return_path`,
`auto_submitted`, `precedence`, `autoreply_header`), or `null`.

#### `plainTextLine(value, maxChars): string`
Pure. One line of untrusted text: control and bidi characters removed,
links replaced by `[link removed]`, cut to `maxChars` code points. Reads a
bounded prefix only.

### notify-throttle.ts (#250)

`NotifyThrottle.check(recipient, now)` decides whether a message is
notified under both budgets (and returns the count skipped earlier for that
address, to report), or which budget is spent; `prune(now)` runs from the
receiver's existing 5-minute sweep. Built on the fixed-window
`checkRateLimit` of `src/middleware/rate-limit-core.ts`.

### threading.ts (#192, pure)

#### `extractMessageIds(value): string[]`
The valid msg-ids of a header field value, in order, deduplicated (unfolds, skips comments, drops invalid or overlong ids).

#### `threadingIdsFromHeaderLines(lines): ThreadingIds`
The first `Message-ID`, `In-Reply-To` and `References` of a message from its raw header lines, chains capped to 20.

#### `buildReplyHeaders(stored): ReplyThreadingHeaders | null`
`In-Reply-To` and `References` of a reply (append, In-Reply-To fallback, 20 ids, 998 characters), or `null` without a valid `Message-ID`.

### reply-threading.service.ts (#192)

#### `threadingColumnsFor(headerLines, recipients)`
The receiver's threading columns, with the link to our email scoped to the recipients' domains.

#### `replyHeadersForInbound(inboundId)`
The reply headers for a dashboard reply, recovering the ids from `raw_message` once for older rows.

#### `getRepliedEmail(inbound)`
The linked email (id, subject, sent time) for the detail page.

### arf-parser.service.ts / feedback-handler.service.ts

`isFeedbackReport`, `parseFeedbackReport`, `classifyFeedbackType`, `handleFeedbackReport`, `handleInboundFeedbackReport`: see [feedback-loops.md](feedback-loops.md#service-methods).

### dnsbl.service.ts

#### `dnsblQueryName(ip, zone): string | null`
Pure. Returns the reversed-octet query name (`1.2.3.4` → `4.3.2.1.<zone>`), or `null` when the address should be skipped (not publicly routable, IPv6, or malformed). Reuses `isBlockedIp()` from `src/utils/ssrf-guard.ts`.

#### `isBlacklistedIp(ip, zone): Promise<boolean>`
Resolves the query name; any A record means listed. Fails open on NOTFOUND or timeout.

### inbound.service.ts

All read methods exclude trashed rows by default; trash methods explicitly target trashed rows.

#### `listInboundEmails(filters)` / `getInboundEmailById(id)`
Live (non-trashed) reads, used by the API and dashboard.

#### `trashInboundEmail(id)` / `trashInboundEmails(ids[])`
Soft-delete single or bulk. Idempotent.

#### `listTrashedInboundEmails(filters)` / `getTrashedInboundEmailById(id)`
Trash-only reads.

#### `restoreInboundEmail(id)`
Clears `deleted_at`. 404 if not currently trashed.

#### `permanentDeleteInboundEmail(id)`
Hard-delete a trashed row.

#### `emptyInboundTrash()`
Permanently deletes every trashed inbound email. Returns count.

## API Endpoints

All routes require Bearer token auth and are rate-limited.

| Method | Path                                    | Description                           |
|--------|-----------------------------------------|---------------------------------------|
| GET    | `/api/v1/inbound`                       | List received emails (excludes trash) |
| GET    | `/api/v1/inbound/trash`                 | List trashed inbound                  |
| GET    | `/api/v1/inbound/:id`                   | Get inbound email by ID               |
| DELETE | `/api/v1/inbound/:id`                   | Move to trash                         |
| POST   | `/api/v1/inbound/bulk-delete`           | Bulk move to trash (`{ids: []}`)      |
| POST   | `/api/v1/inbound/:id/restore`           | Restore from trash                    |
| DELETE | `/api/v1/inbound/:id/permanent`         | Permanently delete a trashed row      |
| POST   | `/api/v1/inbound/trash/empty`           | Empty inbound trash                   |
