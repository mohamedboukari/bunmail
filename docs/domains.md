# Domains Module

Manages sender domains and their email authentication status (SPF, DKIM, DMARC).

## Module Layout

```
src/modules/domains/
├── domains.plugin.ts               ← Elysia plugin (route group)
├── services/
│   └── domain.service.ts           ← CRUD operations
├── dtos/
│   └── create-domain.dto.ts        ← POST body validation
├── models/
│   └── domain.schema.ts            ← Drizzle pgTable definition
├── serializations/
│   └── domain.serialization.ts     ← Strips private keys from responses
└── types/
    └── domain.types.ts             ← Domain type + CreateDomainInput
```

## Database Schema

Table: `domains`

| Column           | Type           | Constraints                  |
|------------------|----------------|------------------------------|
| id               | varchar(36)    | PK, prefixed `dom_`          |
| name             | varchar(255)   | NOT NULL, UNIQUE             |
| dkim_private_key | text           | nullable                     |
| dkim_public_key  | text           | nullable                     |
| dkim_selector    | varchar(63)    | NOT NULL, default `'bunmail'`|
| spf_verified     | boolean        | NOT NULL, default `false`    |
| dkim_verified    | boolean        | NOT NULL, default `false`    |
| dmarc_verified   | boolean        | NOT NULL, default `false`    |
| verified_at      | timestamp      | nullable                     |
| created_at       | timestamp      | NOT NULL, default `now()`    |
| updated_at       | timestamp      | NOT NULL, default `now()`    |

## Types

### `Domain`

Inferred from Drizzle schema (`InferSelectModel<typeof domains>`).

### `CreateDomainInput`

```typescript
interface CreateDomainInput {
  name: string;
}
```

## Service Methods

### `createDomain(input: CreateDomainInput): Promise<Domain>`

Creates a new domain record with default verification flags (all `false`).

### `listDomains(): Promise<Domain[]>`

Returns all registered domains.

### `getDomainById(id: string): Promise<Domain | undefined>`

Returns a single domain by ID, or `undefined` if not found.

### `deleteDomain(id: string): Promise<Domain | undefined>`

Hard-deletes a domain. Returns the deleted row, or `undefined` if not found.

## Serialization

The `serializeDomain()` function strips sensitive fields from API responses:
- `dkimPrivateKey` — never exposed
- `dkimPublicKey` — not exposed in current version
- `updatedAt` — internal field

## API Endpoints

All routes require Bearer token auth and are rate-limited.

| Method | Path                    | Description     |
|--------|-------------------------|-----------------|
| POST   | /api/v1/domains         | Create domain   |
| GET    | /api/v1/domains         | List domains    |
| GET    | /api/v1/domains/:id     | Get domain      |
| DELETE | /api/v1/domains/:id     | Delete domain   |

## Future

- DKIM key pair generation on domain creation
- DNS record verification (SPF, DKIM, DMARC)
- Automatic DKIM signing for emails sent from verified domains
