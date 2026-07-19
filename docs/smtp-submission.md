# SMTP Submission Module

Lets any SMTP-capable application send **through** BunMail by pointing its SMTP settings at BunMail and authenticating with a BunMail API key. This is what makes BunMail a drop-in replacement for SendGrid/Brevo/Mailgun **SMTP relays** — switch an app to BunMail by changing SMTP credentials only, no code changes.

Introduced in #120.

## Submission vs. inbound — two different SMTP servers

BunMail runs (up to) two independent SMTP listeners. They are **not** the same thing:

| | **Submission** (this module) | **Inbound** ([docs/inbound.md](inbound.md)) |
|---|---|---|
| Direction | Apps send **out** through BunMail | BunMail **receives** mail for your domains |
| Default port | `587` | `25` (prod) / `2525` (dev) |
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
| **Port** | `587` (or your `SMTP_SUBMISSION_PORT`) |
| **Encryption** | STARTTLS if you configured a cert (below); otherwise none / plaintext |
| **Username** | anything — `apikey` is conventional (mirrors SendGrid) |
| **Password** | a BunMail API key, `bm_live_…` |
| **From** | an address on a domain **registered + DKIM-verified** in BunMail |

The password is treated as the API key: SHA-256 hashed and looked up exactly like a REST `Authorization: Bearer` token. The username is ignored (any value works) so apps that force a non-empty username still work.

> **Sender domain requirement.** In `BUNMAIL_ENV=production`, the `From` domain must be registered in BunMail (`POST /api/v1/domains`) or the send is rejected with SMTP `550`. In development, unregistered domains are allowed (sent unsigned). This is the same rule the REST `POST /api/v1/emails/send` path enforces.

## What gets relayed

The submitted message is parsed and mapped to the same fields the REST send API accepts, then handed to `createEmail` — so it flows through the identical queue, retry, DKIM-signing, suppression, and webhook machinery as an API send.

- **From / To / Cc / Subject / HTML / Text** — mapped from the message.
- **BCC** — envelope recipients (`RCPT TO`) that don't appear in the visible `To`/`Cc` headers are treated as blind recipients: delivered, but never rendered in the message headers.

### Not forwarded (v1 limitations)

- **Attachments and arbitrary custom headers** are **not** relayed. The outbound pipeline (`createEmail` / `sendMail` / the `emails` schema) has no attachment or custom-header field yet, so the submission path relays `from/to/cc/bcc/subject/html/text` only. Fine for typical transactional mail (Infisical/Netbird/Dify invites, alerts, password resets); attachment support is a separate follow-up.

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `SMTP_SUBMISSION_ENABLED` | `false` | Start the submission server. |
| `SMTP_SUBMISSION_PORT` | `587` | Listen port. |
| `SMTP_SUBMISSION_TLS_CERT` | _(empty)_ | PEM cert path. When set with the key, STARTTLS is advertised. |
| `SMTP_SUBMISSION_TLS_KEY` | _(empty)_ | PEM private-key path. |
| `SMTP_SUBMISSION_RATE_LIMIT_ENABLED` | `true` | Per-IP connection rate limiting. |
| `SMTP_SUBMISSION_RATE_LIMIT_MAX` | `30` | Max connections per IP per window. |
| `SMTP_SUBMISSION_RATE_LIMIT_WINDOW` | `60` | Connection window (seconds). |
| `SMTP_SUBMISSION_AUTH_RATE_LIMIT_ENABLED` | `true` | Per-IP failed-AUTH throttle (anti key-brute-force). |
| `SMTP_SUBMISSION_AUTH_RATE_LIMIT_MAX` | `10` | Failed AUTHs per IP before lockout. |
| `SMTP_SUBMISSION_AUTH_RATE_LIMIT_WINDOW` | `900` | Failed-AUTH window (seconds). |

### TLS / security posture

- **With a cert** (`SMTP_SUBMISSION_TLS_CERT` + `_KEY`): STARTTLS is advertised so clients can encrypt before sending the API key.
- **Without a cert**: plaintext `AUTH` is allowed (`allowInsecureAuth`). Since the API key travels in the clear, only run this on a **trusted network** — the common self-hosted case where the app and BunMail share a host or a private Docker network. Do not expose a plaintext submission port to the public internet.
- **Failed-AUTH throttle**: because the password is an API key, repeated failed AUTHs from one IP are counted and locked out (`454`) to blunt key brute-forcing. A successful AUTH clears the counter.

### First-boot checklist (Docker Compose)

Submission is **off by default**. To enable it:

1. **`.env`**: set `SMTP_SUBMISSION_ENABLED=true` (and, for TLS, the cert/key paths).
2. **`docker-compose.yml`**: uncomment the submission port line under `services.app.ports` (commented out by default so a fresh checkout doesn't bind 587).
3. **Firewall**: allow inbound TCP on 587 from the networks your apps live on.

Then `docker compose up -d --build`. When submission is off, the app logs `SMTP submission server disabled — set SMTP_SUBMISSION_ENABLED=true …` at startup.

## Integration examples

### NestJS (`@nestjs-modules/mailer` / Nodemailer)

Already SMTP-based — switching from SendGrid/Brevo to BunMail is a `.env` change only:

```env
EMAIL_HOST=mail.yourdomain.com   # your BunMail host
EMAIL_USER=apikey                # any value
EMAIL_PASSWORD=bm_live_xxxxxxxx  # a BunMail API key
EMAIL_SENDER=hello@yourdomain.com  # domain registered + DKIM-verified in BunMail
```

```ts
MailerModule.forRootAsync({
  useFactory: (config: ConfigService) => ({
    transport: {
      host: config.get("EMAIL_HOST"),
      port: 587,
      secure: false, // STARTTLS if a cert is configured; plaintext otherwise
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
SMTP port      = 587
SMTP username  = apikey
SMTP password  = bm_live_...
SMTP from      = notifications@yourdomain.com   (registered + DKIM-verified)
TLS/STARTTLS   = on if you configured a cert, off on a trusted private network
```

## Service Methods

### smtp-submission.service.ts

#### `start(portOverride?: number): void`
Starts the submission server on `SMTP_SUBMISSION_PORT` (or `portOverride`, used by tests). Requires AUTH; authenticates the password against the API-keys table via `findByHash`.

#### `stop(): void`
Gracefully shuts the server down (called from the app's shutdown handler).

### message-mapper.ts (pure, unit-tested)

#### `buildSubmissionInput(parts): SendEmailInput`
Turns extracted addresses + subject/body into a `SendEmailInput`: resolves the sender (From header → envelope MAIL FROM), assigns To/Cc from headers, preserves BCC (envelope recipients not in headers), and falls back to envelope recipients when no To header is present. Throws on missing sender or no recipients (mapped to SMTP `550`).

## Module Layout

```
src/modules/smtp-submission/
├── services/
│   └── smtp-submission.service.ts   ← SMTPServer (AUTH) → createEmail; start()/stop()
└── message-mapper.ts                ← pure message → SendEmailInput mapping
```

No DB model, routes, DTOs, or serializers: submission is an alternate **ingress** to the existing `emails` table via `createEmail`, and its "responses" are SMTP status codes, not JSON. A future REST surface (e.g. `GET /api/v1/smtp-submission/stats`) or per-key SMTP quotas (with their own table) would add a `plugin` / `dtos` / `models` — tracked in #123.
