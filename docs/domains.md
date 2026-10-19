# Domains Module

Manages sender domains, auto-generates DKIM keys, and verifies DNS records (SPF, DKIM, DMARC).

## Module Layout

```
src/modules/domains/
├── domains.plugin.ts               ← Elysia plugin (route group)
├── services/
│   ├── domain.service.ts           ← CRUD + DKIM key generation
│   ├── domain-dkim.service.ts      ← DKIM options for mail sent outside the queue (#106, #217)
│   └── dns-verification.service.ts ← SPF/DKIM/DMARC DNS verification
├── dtos/
│   └── create-domain.dto.ts        ← POST body validation
├── models/
│   └── domain.schema.ts            ← Drizzle pgTable definition
├── serializations/
│   └── domain.serialization.ts     ← Strips private keys, exposes DKIM DNS record
└── types/
    └── domain.types.ts             ← Domain type + CreateDomainInput
```

## Database Schema

Table: `domains`

| Column            | Type           | Constraints                  |
|-------------------|----------------|------------------------------|
| id                | varchar(36)    | PK, prefixed `dom_`          |
| name              | varchar(255)   | NOT NULL, UNIQUE             |
| dkim_private_key  | text           | nullable (auto-generated, **AES-256-GCM encrypted at rest**: `v1:<iv>:<ct>:<tag>` format, see #23) |
| dkim_public_key   | text           | nullable (auto-generated, plaintext: published in DNS) |
| dkim_selector     | varchar(63)    | NOT NULL, default `'bunmail'`|
| unsubscribe_email | varchar(255)   | nullable: overrides the default `unsubscribe@<from-domain>` mailto in the `List-Unsubscribe` header (#40). On single-recipient mail with inbound SMTP off it is kept next to the per-recipient link; with inbound SMTP on, the `unsub+<token>` mailto replaces it (#249) |
| unsubscribe_url   | text           | nullable: adds an `https` URL form to `List-Unsubscribe` and enables `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (#40). Used only for mail with cc, bcc or several recipients, or when `APP_BASE_URL` is not `https://`: otherwise BunMail's per-recipient `/u/<token>` link takes precedence, since a static URL cannot tell who clicked (#249) |
| notify_email      | varchar(255)   | nullable, when set, inbound mail received for this domain triggers a summary notification email to this address (#106). Use an external mailbox. |
| spf_verified      | boolean        | NOT NULL, default `false`    |
| dkim_verified     | boolean        | NOT NULL, default `false`    |
| dmarc_verified    | boolean        | NOT NULL, default `false`    |
| verified_at       | timestamp      | nullable                     |
| created_at        | timestamp      | NOT NULL, default `now()`    |
| updated_at        | timestamp      | NOT NULL, default `now()`    |
| created_by_user_id | varchar(36) | nullable, FK → users ON DELETE SET NULL, indexed: who created it (#219, attribution only; NULL = the owner) |

## DKIM Key Generation

When a domain is created, BunMail automatically generates a 2048-bit RSA keypair:

- **Private key**: generated as PEM, then encrypted with AES-256-GCM using `DKIM_ENCRYPTION_KEY` from `.env` before insert (#23). The plaintext PEM only lives in memory inside `createDomain()` and is never logged. Decrypted on read by the queue's domain lookup. **A key that does not decrypt fails closed in production (#244):** the boot refuses to start, naming the domains (`findUndecryptableDomainKeys`), and the queue never sends unsigned: the email is held on the retry backoff and fails once it is too old to retry. Development warns and sends unsigned.
- **Public key**: stored plaintext in `dkim_public_key`, provided as a DNS TXT record value

The DKIM DNS record the user needs to add is returned in the API response as `dkimDnsRecord`.

## DNS Verification

The `dns-verification.service.ts` checks three DNS record types:

| Record | Host                                    | What it checks                              |
|--------|-----------------------------------------|---------------------------------------------|
| SPF    | `<domain>`                              | exactly one `v=spf1` record that gives `pass` (RFC 7208, evaluated with mailauth) for every sending IP of this server (#247) |
| DKIM   | `<selector>._domainkey.<domain>`        | TXT record containing the expected public key |
| DMARC  | `_dmarc.<domain>`                       | TXT record starting with `v=DMARC1`         |

Trigger verification via `POST /api/v1/domains/:id/verify` or the dashboard "Verify DNS Records" button.

## Service Methods

### domain.service.ts

#### `createDomain(input): Promise<Domain>`
Creates a domain record and auto-generates a 2048-bit RSA keypair for DKIM signing. `input.createdByUserId` (#219) records who added it: the dashboard user, or over REST the calling key's user (null = the owner).

#### `getDkimDnsRecord(domain): string | null`
Returns the DKIM DNS TXT record value (`v=DKIM1; k=rsa; p=<base64>`) for a domain.

#### `listDomains(): Promise<Domain[]>`
Returns all registered domains.

#### `getDomainById(id): Promise<Domain | undefined>`
Returns a single domain by ID.

#### `getDomainByName(name): Promise<Domain | undefined>`
Returns a single domain by its name. Used by the inbound-notification path (#106) to resolve the recipient domain's `notify_email` + DKIM material.

#### `updateDomainNotifyEmail(id, notifyEmail): Promise<Domain | undefined>`
Sets (or clears, when passed `null`) the inbound-notification address for a domain (#106). Returns `undefined` when no row matches the id.

#### `updateDomainUnsubscribe(id, changes): Promise<Domain | undefined>`
Updates `unsubscribeEmail` and/or `unsubscribeUrl` (#243); only the fields present in `changes` are written, `null` clears one. Also editable from the domain page in the dashboard.

#### `deleteDomain(id): Promise<Domain | undefined>`
Hard-deletes a domain and its keys.

### domain-dkim.service.ts

- `resolveDomainDkim(domain): DkimOptions | undefined`: decrypts the domain's stored DKIM key (`DKIM_ENCRYPTION_KEY`; a plaintext key is used with a `warn`, a decrypt failure is logged at `error` and yields no key) and returns the signing options, or `undefined` when there is no usable key. Used by inbound notifications (#106: with no key at all they send unsigned; with a stored key that does not decrypt they are not sent in production, #244) and invitation emails (#217, which then do not send). The queue keeps its own copy of the decrypt step.

### dns-verification.service.ts

#### `verifyDomain(domain): Promise<VerificationResult>`
Runs SPF, DKIM, and DMARC checks in parallel, updates the database, and returns `{ spf, dkim, dmarc, spfReason }`. SPF (#247): the record must exist exactly once, contain no `<placeholder>`, and give `pass` for every sending IP (`MAIL_PUBLIC_IP`, or the A/AAAA records of `MAIL_HOSTNAME`, from `sending-ips.service.ts`), evaluated in strict RFC 7208 mode with mailauth (10-lookup and 2-void-lookup limits, 10 s cap); a failed DNS lookup is reported as temporary. The dashboard suggests `v=spf1 a:<MAIL_HOSTNAME> -all` (`suggestedSpfRecord()`), to be merged into an existing record.

## Serialization

The `serializeDomain()` function:
- **Strips** `dkimPrivateKey` and `dkimPublicKey` (never exposed in API responses)
- **Exposes** `dkimDnsRecord`: the TXT record value users need to add to their DNS

## API Endpoints

All routes require Bearer token auth and are rate-limited.

| Method | Path                          | Description              |
|--------|-------------------------------|--------------------------|
| POST   | /api/v1/domains               | Register domain (auto-DKIM) |
| GET    | /api/v1/domains               | List domains             |
| GET    | /api/v1/domains/:id           | Get domain details       |
| POST   | /api/v1/domains/:id/verify    | Verify DNS records       |
| PATCH  | /api/v1/domains/:id           | Edit unsubscribe settings (#243) |
| DELETE | /api/v1/domains/:id           | Delete domain            |

`POST /api/v1/domains` accepts an optional `notifyEmail` field to set the
inbound-notification address at create time (see below).

## Inbound Notifications (#106)

Each domain can carry a `notify_email`. When BunMail's inbound SMTP receiver
accepts a message for a recipient on that domain, it sends a short "you have
new mail" email (`New email for <recipient address>`: sender, arrival time,
size and, when `APP_BASE_URL` is configured, a dashboard link; no subject or
preview of the message unless `INBOUND_NOTIFY_PREVIEW=true`, #250) to the
notify address. Automatic mail is not notified, each address gets at most
5 notifications per 10 minutes and the domain at most 30 (see [inbound.md](inbound.md#what-a-notification-contains-250)).
The notification is sent **from** `<INBOUND_NOTIFY_FROM_LOCAL>@<domain>` (default
`notifications@<domain>`) and DKIM-signed with the domain's own key, so it
passes the same SPF/DKIM you already set up for outbound.

- **Set it** from the dashboard (the domain detail page) via
  `POST /dashboard/domains/:id/notify-email`, or at create time with the
  `notifyEmail` field on `POST /api/v1/domains`. An empty submission clears it.
- **Point it at an external mailbox.** A notify address on a domain BunMail
  itself receives for would loop; such loops (and any mail whose sender domain
  is a registered BunMail domain) are skipped by the sender-domain loop guard.
- **Disable globally** with `INBOUND_NOTIFY_ENABLED=false` (operator kill
  switch); per-domain, just leave `notify_email` empty.
- Bounces (DSNs) and DMARC aggregate reports never trigger a notification:
  they are routed away before the inbound store.
