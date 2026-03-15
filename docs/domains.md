# Domains Module

Manages sender domains, auto-generates DKIM keys, and verifies DNS records (SPF, DKIM, DMARC).

## Module Layout

```
src/modules/domains/
├── domains.plugin.ts               ← Elysia plugin (route group)
├── services/
│   ├── domain.service.ts           ← CRUD + DKIM key generation
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

| Column           | Type           | Constraints                  |
|------------------|----------------|------------------------------|
| id               | varchar(36)    | PK, prefixed `dom_`          |
| name             | varchar(255)   | NOT NULL, UNIQUE             |
| dkim_private_key | text           | nullable (auto-generated)    |
| dkim_public_key  | text           | nullable (auto-generated)    |
| dkim_selector    | varchar(63)    | NOT NULL, default `'bunmail'`|
| spf_verified     | boolean        | NOT NULL, default `false`    |
| dkim_verified    | boolean        | NOT NULL, default `false`    |
| dmarc_verified   | boolean        | NOT NULL, default `false`    |
| verified_at      | timestamp      | nullable                     |
| created_at       | timestamp      | NOT NULL, default `now()`    |
| updated_at       | timestamp      | NOT NULL, default `now()`    |

## DKIM Key Generation

When a domain is created, BunMail automatically generates a 2048-bit RSA keypair:

- **Private key** — stored in `dkim_private_key` (PEM format), used by Nodemailer to sign outgoing emails
- **Public key** — stored in `dkim_public_key` (PEM format), provided as a DNS TXT record value

The DKIM DNS record the user needs to add is returned in the API response as `dkimDnsRecord`.

## DNS Verification

The `dns-verification.service.ts` checks three DNS record types:

| Record | Host                                    | What it checks                              |
|--------|-----------------------------------------|---------------------------------------------|
| SPF    | `<domain>`                              | TXT record starting with `v=spf1`           |
| DKIM   | `<selector>._domainkey.<domain>`        | TXT record containing the expected public key |
| DMARC  | `_dmarc.<domain>`                       | TXT record starting with `v=DMARC1`         |

Trigger verification via `POST /api/v1/domains/:id/verify` or the dashboard "Verify DNS Records" button.

## Service Methods

### domain.service.ts

#### `createDomain(input): Promise<Domain>`
Creates a domain record and auto-generates a 2048-bit RSA keypair for DKIM signing.

#### `getDkimDnsRecord(domain): string | null`
Returns the DKIM DNS TXT record value (`v=DKIM1; k=rsa; p=<base64>`) for a domain.

#### `listDomains(): Promise<Domain[]>`
Returns all registered domains.

#### `getDomainById(id): Promise<Domain | undefined>`
Returns a single domain by ID.

#### `deleteDomain(id): Promise<Domain | undefined>`
Hard-deletes a domain and its keys.

### dns-verification.service.ts

#### `verifyDomain(domain): Promise<VerificationResult>`
Runs SPF, DKIM, and DMARC checks in parallel, updates the database, and returns `{ spf, dkim, dmarc }`.

## Serialization

The `serializeDomain()` function:
- **Strips** `dkimPrivateKey` and `dkimPublicKey` (never exposed in API responses)
- **Exposes** `dkimDnsRecord` — the TXT record value users need to add to their DNS

## API Endpoints

All routes require Bearer token auth and are rate-limited.

| Method | Path                          | Description              |
|--------|-------------------------------|--------------------------|
| POST   | /api/v1/domains               | Register domain (auto-DKIM) |
| GET    | /api/v1/domains               | List domains             |
| GET    | /api/v1/domains/:id           | Get domain details       |
| POST   | /api/v1/domains/:id/verify    | Verify DNS records       |
| DELETE | /api/v1/domains/:id           | Delete domain            |
