# SMTP Submission Module

Lets any SMTP-capable application send **through** BunMail by pointing its SMTP settings at BunMail and authenticating with a BunMail API key. This is what makes BunMail a drop-in replacement for SendGrid/Brevo/Mailgun **SMTP relays**: switch an app to BunMail by changing SMTP credentials only, no code changes.

Introduced in #120.

## Submission vs. inbound: two different SMTP servers

BunMail runs (up to) two independent SMTP listeners. They are **not** the same thing:

| | **Submission** (this module) | **Inbound** ([docs/inbound.md](inbound.md)) |
|---|---|---|
| Direction | Apps send **out** through BunMail | BunMail **receives** mail for your domains |
| Default port | `465` with a TLS cert (implicit TLS), `587` without | `25` (prod) / `2525` (dev) |
| `AUTH` | **Required** (API key) | Disabled |
| Recipient domains | **Any** (it's a relay for authenticated clients) | Only registered domains (open-relay guard) |
| What it does | Parses the message → `createEmail` → outbound queue → DKIM → direct-to-MX | Parses → stores in `inbound_emails` (+ bounce/DMARC branching) |
| Env toggle | `SMTP_SUBMISSION_ENABLED` | `SMTP_ENABLED` |

The open-relay guard for submission is **authentication**: only clients holding a valid API key can send, and they can send to any recipient (that's the point). The inbound receiver, being unauthenticated, instead restricts recipients to your registered domains.

## How apps authenticate

Point the app's SMTP settings at BunMail:

| Setting | Value |
|---|---|
| **Host** | your BunMail host (e.g. `mail.yourdomain.com`, or `localhost` on the same box) |
| **Port** | `465` with a cert, `587` without (or your `SMTP_SUBMISSION_PORT`) |
| **Encryption** | **SSL/TLS** (implicit TLS, nodemailer `secure: true`) if you configured a cert (below); otherwise none / plaintext. Not STARTTLS: it is not available on Bun (#349) |
| **Username** | anything: `apikey` is conventional (mirrors SendGrid) |
| **Password** | a BunMail API key, `bm_live_…` |
| **From** | an address on a domain **registered** in BunMail, with its DKIM record published and verified (see below) |

The password is treated as the API key: SHA-256 hashed and looked up exactly like a REST `Authorization: Bearer` token. Revocation also applies to sessions that are already authenticated: each message checks that the key is still active, so a revoked key's open connection is refused (`550`) at its next message. The username is ignored (any value works) so apps that force a non-empty username still work.

> **Sender domain requirement.** In `BUNMAIL_ENV=production`, the `From` domain must be registered in BunMail (`POST /api/v1/domains`) or the send is rejected with SMTP `550`. In development, unregistered domains are allowed (sent unsigned). A registered domain whose DKIM, SPF or DMARC record is not verified is still accepted: SMTP has no channel to report it, so BunMail logs `Email queued from a sender domain with unverified DNS records` at `warn` with the email id and the `warnings`. Set `REQUIRE_VERIFIED_DOMAIN=true` (#245) to refuse a domain whose DKIM record is not verified (re-checked in DNS once, a failure remembered for 5 minutes) with SMTP `550`, and an unregistered domain in every environment. These are the same rules the REST `POST /api/v1/emails/send` path enforces. A missing subject, a missing sender or recipients, and a message that does not parse are also a `550`. Any other, unexpected failure (a database error, a bug) is answered with a fixed `451 Local error in processing, try again later`, so the client retries and no internal error text reaches it; the details are logged server-side.

## What gets relayed

The submitted message is parsed and mapped to the same fields the REST send API accepts, then handed to `createEmail`, so it flows through the identical queue, retry, DKIM-signing, suppression, and webhook machinery as an API send.

- **From / To / Cc / Reply-To / Subject / HTML / Text**: mapped from the message. `Reply-To` (#169) is a header only: it never adds a recipient or affects BCC detection.
- **From display name** (#250): the display name of the submitted `From:` header (`"Acme Support" <hello@example.com>`) is kept as the email's `fromName`, through the same rules as the REST field (see [emails.md](emails.md#from-display-name-250)): 1 to 100 characters, no control or bidi-control character, none of `@ < > "`. A name that fails is **dropped**, not refused: the mail goes out with the bare address, and a `warn` (`SMTP submission dropped the From display name`) names the field and the rule, never the value.
- **`X-BunMail-Category: transactional|marketing`** (#250, case-insensitive) sets the email's `category` (see [emails.md](emails.md#category-250)). The header is consumed by BunMail and never relayed. Any other value, or the header given more than once, is refused with `550`; so is a `marketing` message that cannot carry the per-recipient one-click link (more than one recipient, or no https `APP_BASE_URL`).
- **`X-BunMail-Tag: key=value`** (#189, name case-insensitive) adds a tag to the email (see [emails.md](emails.md#tags-189)), one header per tag, split on the first `=` (so a value may contain `=`; the key is trimmed). Same rules as the REST `tags` field: at most 10, keys of 1 to 40 characters of `A-Z a-z 0-9 _ -` unique ignoring case, values of 1 to 256 characters with no control or bidi-control character. The value is taken as written in the header, without RFC 2047 decoding, so keep it ASCII or UTF-8. The headers are consumed by BunMail, never relayed and never logged as dropped headers. A header without `=`, a tag that breaks a rule, a repeated key or more than 10 tags is refused with `550` and a message naming the key (when valid), never the value.
- **Address length.** Header addresses longer than 254 characters (RFC 5321) are dropped at ingestion with a warning, so an over-long or pathological address never reaches storage or the recipient parser.
- **Delivery = the envelope.** Only `RCPT TO` recipients (at most 50 per transaction) are delivered. `To`/`Cc` keep only addresses that are also envelope recipients; an address that appears only in a header is neither delivered nor shown. If the headers name recipients but none of them was sent in `RCPT TO`, the message is rejected (`550`) instead of showing the envelope recipients in `To`, which would expose blind recipients to each other.
- **Several `To` addresses** (#178): a message whose `To:` header lists several addresses (each also in `RCPT TO`) is relayed as ONE email with all of them, as a REST send with an array `to`: every recipient sees the whole `To:` list, delivery is per recipient domain. The REST caps apply (at most 50 `to` addresses and 100 unique recipients with `Cc` and BCC; `RCPT TO` is already capped at 50 per transaction), answered with `550`. Before #178 a `To` list longer than 255 characters could not be stored and the message failed with `451`.
- **BCC**: envelope recipients (`RCPT TO`) that don't appear in the visible `To`/`Cc` headers are treated as blind recipients: delivered, but never rendered in the message headers.
- **Attachments** (#181): every part mailparser reports as an attachment is relayed, through the same rules and limits as the REST `attachments` field (see [emails.md](emails.md#attachments-181)): at most 10, at most `ATTACHMENTS_MAX_TOTAL_MB` (default 5) decoded in total, filenames of 1 to 255 characters without control, bidi-control or path characters, a valid Content-ID, and no executable, script or installer by extension or by sniffed content. The declared `Content-Type` is ignored; the type sent is derived from the bytes. A part with a `Content-ID` keeps it and stays inline, and the HTML's `cid:` references are kept as they are (mailparser runs with `keepCidLinks`, so they are not inlined as data URLs). A part without a filename is named `attachment-<n>` (1-based). A violation refuses the message with clear text and nothing is queued: `552` when the attachments are over the size budget, `550` otherwise (too many, a bad filename or Content-ID, a blocked type naming the attachment's index). The bytes are dropped once the email reaches a final state, as for a REST send.
- **Message size:** the server advertises and enforces (`SIZE`, then `552 Message size exceeds limit`) 10 MiB plus the MIME encoding of the attachment budget (base64 in 76-character lines) plus 64 KiB of part headers: about 17.4 MB with the default 5 MB, 35.2 MB at 18 (#181).
- **Custom headers** (#177): `In-Reply-To`, `References` and `X-*` headers are relayed, through the same rules and caps as the REST `headers` field (see [emails.md](emails.md#custom-headers)): valid name, no line break or control character in the (unfolded) value, at most 998 characters, at most 20 headers and 8 KB in total, no case-insensitive duplicate. `X-BunMail-*` is reserved (`X-BunMail-Category` and `X-BunMail-Tag` are read as instructions, see above; any other is dropped). Unlike the REST API, a header that fails is **dropped** and the message is still accepted: mail clients add many `X-` headers of their own, and losing one is safer than refusing the mail. Each drop is logged at `warn` (`SMTP submission dropped custom headers`) with the header names and the rule broken, never the values. Every other header of the message (`Received`, `Content-*`, `List-Unsubscribe`, `Feedback-ID`, ...) is not copied: BunMail builds those itself.

### Not forwarded (v1 limitations)

- **No idempotency keys** (#188): the REST `Idempotency-Key` header has no SMTP equivalent, so a client that resubmits a message after a dropped connection sends it again. Use the REST API when a retry must not duplicate a send.
- **Charsets:** the message is MIME-parsed from its raw bytes, so 8-bit parts in any declared charset (ISO-8859-1, Windows-1252, ...) are decoded correctly (#250).
- **A body is required:** a message with neither a text nor an HTML part is refused (`550`, #250).

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `SMTP_SUBMISSION_ENABLED` | `false` | Start the submission server. |
| `SMTP_SUBMISSION_PORT` | `465` with a cert, `587` without | Listen port, a whole number from 1 to 65535 (anything else refuses to boot). |
| `SMTP_SUBMISSION_DAILY_QUOTA` | `0` | Per-API-key messages accepted per UTC day; over-quota → SMTP `452`. `0` = unlimited. See [Quotas](#per-key-daily-quotas-123). |
| `SMTP_SUBMISSION_TLS_CERT` | _(empty)_ | PEM cert path. Set with the key for TLS (#349). One without the other refuses to boot. |
| `SMTP_SUBMISSION_TLS_KEY` | _(empty)_ | PEM private-key path. |
| `SMTP_SUBMISSION_TLS_MODE` | `implicit` with a cert | `implicit` (TLS from the first byte) or `starttls`. `starttls` refuses to boot on Bun, a mode without a cert refuses to boot, and so does any other value. See [TLS modes](#tls-modes-349). |
| `SMTP_SUBMISSION_ALLOW_INSECURE` | `false` | Allow AUTH over plaintext (no TLS). The password is a full-privilege key, so this exposes it to link sniffers. With neither TLS nor this flag the server **refuses to start**. Set `true` only on a trusted network. Ignored with a cert: AUTH is then only accepted over TLS. |
| `SMTP_SUBMISSION_RATE_LIMIT_ENABLED` | `true` | Per-IP connection rate limiting. |
| `SMTP_SUBMISSION_RATE_LIMIT_MAX` | `30` | Max connections per IP per window. |
| `SMTP_SUBMISSION_RATE_LIMIT_WINDOW` | `60` | Connection window (seconds). |
| `SMTP_SUBMISSION_AUTH_RATE_LIMIT_ENABLED` | `true` | Per-IP failed-AUTH throttle (anti key-brute-force). |
| `SMTP_SUBMISSION_AUTH_RATE_LIMIT_MAX` | `10` | Failed AUTHs per IP before lockout. |
| `SMTP_SUBMISSION_AUTH_RATE_LIMIT_WINDOW` | `900` | Failed-AUTH window (seconds). |

### TLS modes (#349)

| Mode | When | Port (unless `SMTP_SUBMISSION_PORT`) | Client setting |
|---|---|---|---|
| `implicit` | a cert and key are set (the default then) | `465` | **SSL/TLS** (nodemailer `secure: true`) |
| `starttls` | `SMTP_SUBMISSION_TLS_MODE=starttls`, **Node only** | `587` | STARTTLS (nodemailer `secure: false, requireTLS: true`) |
| `none` | no cert; needs `SMTP_SUBMISSION_ALLOW_INSECURE=true` | `587` | none / plaintext |

The start line says which one runs: `SMTP submission server started` with `tls: "implicit" | "starttls" | "none"` and the `port`. Each `SMTP submission client authenticated` line carries `secure` (whether the session is TLS).

**Why not STARTTLS.** STARTTLS turns an accepted plaintext connection into a TLS one on the server side. Under Bun (1.3.14) that never works: `new tls.TLSSocket(socket, { isServer: true })` on an accepted socket never runs the handshake (the client sees a timeout or an unexpected EOF), and Bun's own `socket.upgradeTLS()` refuses server-side upgrades. smtp-server's own implicit TLS does the same upgrade, so it fails under Bun too. So `starttls` refuses to boot under Bun rather than advertise a STARTTLS that cannot complete; it only exists for running on Node.

**How implicit TLS works.** Bun's own TLS server (`tls.createServer`, which handshakes fine) listens on the port and terminates TLS from the first byte. Each decrypted connection is handed to smtp-server (`SMTPServer#connect`), which runs with `secure: true, secured: true` ("TLS done upstream"): every session is TLS before its first SMTP byte, STARTTLS is not offered, AUTH is allowed, and the per-IP limits see the real client address. `connect` is public in smtp-server but missing from `@types/smtp-server`, so the module declares it, and `smtp-server` is pinned to the exact version 3.19.23 in `package.json`: `test/integration/smtp-submission-tls.integration.test.ts` fails if an upgrade breaks the handover. A client that has not finished its handshake after 60 s is disconnected (Bun ignores `handshakeTimeout`, so the limit is set on the socket by hand) and logged at `warn` (`SMTP submission TLS handshake timed out`), and a failed handshake is logged at `warn` (`SMTP submission TLS handshake failed`, with the IP and the error code).

**Hang-ups close the whole socket (#351).** Under Bun (1.3.14), a TLS socket the server ends and that is then paused (smtp-server ends the socket on `QUIT`, a `421` or its idle timeout, then unpipes its parser) never closes once the client's FIN arrives: it stays in `CLOSE_WAIT`, `destroy()` can no longer close it, and on Linux the event loop spins on it at a full CPU core. Anyone who could reach the port could pin the CPU by sending `QUIT` and hanging up. So the listener never half-closes a TLS socket, at any stage (handshake, handoff, session): ending our side destroys the socket as soon as the last reply has been written (the `221` or `421` still goes out), and a client's FIN or a socket error destroys it at once, logged at `debug` (`SMTP submission client hung up`, with the IP). smtp-server then closes its session as usual (`SMTP session closed`). Plaintext sockets (submission without a cert, inbound on port 25) do not have the bug. `test/integration/smtp-submission-tls.integration.test.ts` hangs up at each stage (before any TLS byte, mid-handshake, after the greeting, half-closed after EHLO, after `QUIT`, and 40 times in a row) and fails if a socket is left in `CLOSE_WAIT` or the process does not go back to idle.

**A Bun quirk on failed handshakes.** A plaintext client that connects to the implicit-TLS port gets a TLS alert, but Bun can still report the connection as established. Nothing the client sent is read as SMTP and nothing written to it reaches the wire, but it opens a session that closes at once: one `SMTP session closed` line with `messages: 0`, and one connection counted against its IP's connection limit (`SMTP_SUBMISSION_RATE_LIMIT_*`). That is the same count any plaintext client gets (one per TCP connection, never more), so it cannot use the limit up faster, and the count only affects that client's own IP.

**Inbound STARTTLS on port 25 (#345) hits the same limitation.** The inbound receiver offers no STARTTLS today (`disabledCommands`), and adding it is what #345 tracks: MX-to-MX mail uses TLS on port 25 only through STARTTLS, which cannot complete under Bun for the same reason. Terminating TLS in Bun first only works for implicit TLS, which port 25 does not use, so this approach does not carry over there.

### TLS / security posture

- **With a cert** (`SMTP_SUBMISSION_TLS_CERT` + `_KEY`): every connection is TLS from the first byte (implicit TLS, port 465) and AUTH is only accepted over TLS, so the API key never travels in the clear. This is the recommended posture whenever the port isn't strictly loopback.
- **Without a cert**: plaintext `AUTH` is **refused by default** (#133): the server won't start, because the API key would travel in the clear. To run plaintext on a **trusted network** (app + BunMail sharing a host or a private Docker network), opt in explicitly with `SMTP_SUBMISSION_ALLOW_INSECURE=true`. Never expose a plaintext submission port to the public internet.
- **Failed-AUTH throttle**: because the password is an API key, repeated failed AUTHs from one IP are counted and locked out (`454`) to blunt key brute-forcing. Failures expire only with their window: a successful AUTH does not clear them (#190), so holding one valid key does not buy more guesses at others.

### First-boot checklist (Docker Compose)

Submission is **off by default**. To enable it:

1. **`.env`**: set `SMTP_SUBMISSION_ENABLED=true` (and, for TLS, the cert/key paths; the port is then 465 unless `SMTP_SUBMISSION_PORT` says otherwise).
2. **`docker-compose.override.yml`**: publish the submission port, using the submission examples in `docker-compose.override.example.yml` (#205): public `465` with implicit TLS, or `127.0.0.1` only for plaintext on a trusted host. The base `docker-compose.yml` publishes no submission port.
3. **Firewall**: allow inbound TCP on the submission port (465 with TLS) from the networks your apps live on.

Then `docker compose up -d --build`. When submission is off, the app logs `SMTP submission server disabled: set SMTP_SUBMISSION_ENABLED=true …` at startup.

## Integration examples

### NestJS (`@nestjs-modules/mailer` / Nodemailer)

Already SMTP-based: switching from SendGrid/Brevo to BunMail is a `.env` change only:

```env
EMAIL_HOST=mail.yourdomain.com   # your BunMail host
EMAIL_USER=apikey                # any value
EMAIL_PASSWORD=bm_live_xxxxxxxx  # a BunMail API key
EMAIL_SENDER=hello@yourdomain.com  # domain registered in BunMail, DKIM record verified
```

```ts
MailerModule.forRootAsync({
  useFactory: (config: ConfigService) => ({
    transport: {
      host: config.get("EMAIL_HOST"),
      port: 465,
      secure: true, // SSL/TLS (implicit TLS). Without a cert: port 587, secure: false
      auth: { user: config.get("EMAIL_USER"), pass: config.get("EMAIL_PASSWORD") },
    },
    defaults: { from: config.get("EMAIL_SENDER") },
  }),
});
```

### Infisical / Netbird / Dify (and most self-hosted apps)

These expose SMTP settings in their config/env. Set:

```
SMTP host      = mail.yourdomain.com   (or the BunMail container hostname)
SMTP port      = 465   (587 without a cert)
SMTP username  = apikey
SMTP password  = bm_live_...
SMTP from      = notifications@yourdomain.com   (registered, DKIM record verified)
Encryption     = SSL/TLS (implicit TLS) if you configured a cert, none on a trusted
                 private network. Not STARTTLS: it is not available on Bun.
```

## Per-key daily quotas (#123)

Set `SMTP_SUBMISSION_DAILY_QUOTA` to cap how many messages each API key can send via the submission path per **UTC calendar day**. Once a key reaches the cap, further submissions are rejected with SMTP **`452`** (a *temporary* failure: the window resets at `00:00 UTC`, so clients retry rather than treating it as permanent). `0` (default) means unlimited.

- Counts only **accepted** messages toward the cap; rejections don't consume quota.
- Applies to the SMTP submission path **only**: the REST `POST /api/v1/emails/send` API is unaffected.
- Usage is tracked per `(api_key, UTC day)` in the `smtp_submission_usage` table (`accepted` / `rejected` counters). Every post-auth outcome is recorded, so `rejected` includes quota hits, suppressed recipients, and unregistered-domain rejections.
- The quota is exact, also under concurrency and across replicas (#190): before the send, one atomic statement takes a slot (`accepted + 1` only while it is below the cap); a message rejected after that (parse error, suppressed recipient, sender check) hands its slot back and is counted as `rejected`. A process that dies between the two keeps the slot (errs on the safe side).

## Stats endpoint (#123)

### `GET /api/v1/smtp-submission/stats`

Bearer-auth + rate-limited, **scoped to the calling API key** (like the rest of `/api/v1`). Returns per-day accepted/rejected counts for messages sent via the submission server, plus the key's quota status.

**Query params:** `days` (trailing UTC-day window inclusive of today; default `30`, max `365`).

**Response:**

```json
{
  "success": true,
  "data": {
    "window": { "days": 30 },
    "quota": { "daily": 1000, "usedToday": 42, "remaining": 958 },
    "totals": { "accepted": 1234, "rejected": 7 },
    "daily": [
      { "day": "2026-07-18", "accepted": 40, "rejected": 1 },
      { "day": "2026-07-19", "accepted": 42, "rejected": 0 }
    ]
  }
}
```

When quotas are disabled (`SMTP_SUBMISSION_DAILY_QUOTA=0`), `quota.daily` and `quota.remaining` are `null` (not `0`, which would read as "no sends allowed"). Days with no activity are omitted from `daily`.

> Cross-key / instance-wide submission analytics (top keys, rejection-by-reason) and a dashboard view are a separate follow-up: this endpoint is per-key only.

## Service Methods

### smtp-submission.service.ts

#### `start(portOverride?: number): void`
Starts the submission server on `SMTP_SUBMISSION_PORT` (or `portOverride`, used by tests), in the TLS mode of `config.smtpSubmission.tls.mode` (#349): in `implicit` mode behind a Bun TLS listener that hands each decrypted connection to smtp-server. Requires AUTH; authenticates the password against the API-keys table via `findByHash`. Refuses to start without TLS unless `SMTP_SUBMISSION_ALLOW_INSECURE=true` (#133).

#### `stop(): void`
Gracefully shuts the server down (called from the app's shutdown handler).

### usage.service.ts (#123)

#### `recordOutcome(apiKeyId, "accepted" | "rejected"): Promise<void>`
Upserts today's `(api_key, UTC day)` row and increments the matching counter atomically (`ON CONFLICT DO UPDATE`).

#### `getAcceptedToday(apiKeyId): Promise<number>`
Today's accepted count for the key (0 if no row). Backs the stats endpoint's `usedToday`.

#### `reserveAccepted(apiKeyId, dailyQuota): Promise<string | null>`
Takes one of today's quota slots atomically (#190): inserts today's row with `accepted = 1`, or increments `accepted` only while it is below `dailyQuota` (`ON CONFLICT DO UPDATE ... WHERE`). Returns the UTC day it counted on, or `null` when the quota is used up.

#### `releaseReservation(apiKeyId, day): Promise<void>`
Hands a slot back after a rejection: `accepted - 1`, `rejected + 1` on that day, in one statement.

#### `getStats(apiKeyId, days): Promise<UsageStats>`
Per-day rows (oldest first) + window totals over the trailing `days` UTC days. Backs the stats endpoint.

### message-mapper.ts (pure, unit-tested)

#### `buildSubmissionInput(parts): SendEmailInput`
Turns extracted addresses + subject/body into a `SendEmailInput`: resolves the sender (From header → envelope MAIL FROM), assigns To/Cc from the headers limited to envelope recipients, preserves BCC (envelope recipients not in headers), and falls back to envelope recipients when no To header is present. Throws on missing sender, no recipients, or headers whose recipients are all outside the envelope (mapped to SMTP `550`).

## Module Layout

```
src/modules/smtp-submission/
├── smtp-submission.plugin.ts        ← REST: GET /api/v1/smtp-submission/stats (#123)
├── errors.ts                        ← SubmissionRejectedError: a message refused on its content (SMTP 550)
├── services/
│   ├── smtp-submission.service.ts   ← SMTPServer (AUTH) → createEmail; implicit-TLS listener (#349); start()/stop()
│   └── usage.service.ts             ← per-(key,day) usage counters + quota read (#123)
├── message-mapper.ts                ← pure message → SendEmailInput mapping
├── dtos/
│   └── stats-query.dto.ts           ← stats query validation
├── models/
│   └── smtp-submission-usage.schema.ts ← smtp_submission_usage pgTable (#123)
└── serializations/
    └── stats.serialization.ts       ← stats response shaping
```

The SMTP listener itself has no HTTP routes: it's an alternate **ingress** to the `emails` table via `createEmail`, with SMTP status codes as its "responses". The `plugin` / `dtos` / `models` / `serializations` exist only for the usage-stats REST surface + quota table added in #123.
