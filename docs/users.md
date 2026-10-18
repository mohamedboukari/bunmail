# Users Module

Dashboard user accounts (#214): the first piece of the invite-only accounts epic (#225), which replaces the shared `DASHBOARD_PASSWORD` with real accounts, roles and revocable sessions.

This issue ships the **schema and the pure helpers only**. Nothing reads these tables yet: login (#216), the owner bootstrap (#215), invitations (#217), roles (#218) and the auth guard (#222) build on them. Until then the dashboard keeps using `DASHBOARD_PASSWORD`.

## Design

- **Identity and credentials are separate.** `users` holds who someone is; `user_credentials` holds one row per way they can log in. A password is the first credential type; TOTP (#220), passkeys (#223) and OAuth/SSO (#224) are further rows with the columns they need already present (`provider`, `provider_account_id`, `public_key`, `counter`, `name`). The `metadata` jsonb column from the original design is deliberately deferred: the bun-sql driver stores jsonb as JSON strings (#261), so it could not be queried until that is fixed; a later type that needs free-form data adds the column once #261 is resolved. TOTP recovery codes (#220) are expected to be stored hashed in `secret_hash` of their own rows, or in a small table of their own if several per user are needed.
- **Sessions carry an assurance level.** `pending` (first factor passed, second required), `password`, `mfa`. The auth guard (#222) can require a minimum per route, so adding 2FA later touches no routes.
- **Invariants live in the database.** Exactly one owner, lower-cased unique emails, and every enum column limited to its value set by a `CHECK` constraint, so a typo can never become a privilege.
- **Secrets are never stored.** Session cookies and one-time links carry a random 256-bit token; only its SHA-256 hash is in the database. Passwords are argon2id hashes from `Bun.password`.
- **No new dependency.** Hashing, randomness and SHA-256 come from Bun and Node's `crypto`.

## Schema

### `users`

| Column            | Type           | Constraints                                          |
|-------------------|----------------|------------------------------------------------------|
| id                | varchar(36)    | PK, `usr_` prefix                                    |
| email             | varchar(255)   | NOT NULL, UNIQUE, `CHECK (email = lower(email))`     |
| email_verified_at | timestamptz    | nullable                                             |
| name              | varchar(100)   | nullable                                             |
| role              | varchar(10)    | NOT NULL, default `member`, `CHECK IN (owner, admin, member)` |
| disabled_at       | timestamptz    | nullable: deactivated account                        |
| created_at        | timestamptz    | NOT NULL, default `now()`                            |
| updated_at        | timestamptz    | NOT NULL, default `now()`                            |

Indexes: `users_single_owner`, a unique index on `(role) WHERE role = 'owner'`: every owner row has the same value, so at most one can exist. An ownership transfer must demote the old owner and promote the new one in one transaction (tested).

### `user_credentials`

| Column              | Type           | Constraints                                            |
|---------------------|----------------|--------------------------------------------------------|
| id                  | varchar(36)    | PK, `crd_` prefix                                      |
| user_id             | varchar(36)    | NOT NULL, FK `users` ON DELETE CASCADE                  |
| type                | varchar(16)    | NOT NULL, `CHECK IN (password, totp, passkey, oauth)`   |
| provider            | varchar(100)   | nullable: `google`, `oidc:<issuer>`, passkey authenticator |
| provider_account_id | text           | nullable: id at the provider, or passkey credential id (up to 1023 bytes) |
| name                | varchar(100)   | nullable: user-chosen label for a passkey or linked account |
| secret_hash         | text           | nullable: argon2id hash, or encrypted TOTP secret      |
| public_key          | text           | nullable: passkey public key                           |
| counter             | bigint         | nullable: passkey signature counter (unsigned 32-bit)  |
| last_used_at        | timestamptz    | nullable                                               |
| created_at          | timestamptz    | NOT NULL, default `now()`                              |
| updated_at          | timestamptz    | NOT NULL, default `now()`                              |

Indexes: `user_credentials_one_password_per_user` (unique on `user_id WHERE type = 'password'`), `user_credentials_provider_account_unique` (unique on `(provider, provider_account_id) WHERE provider IS NOT NULL`: an external account links to one user).

### `sessions`

| Column       | Type           | Constraints                                               |
|--------------|----------------|-----------------------------------------------------------|
| id           | varchar(36)    | PK, `ses_` prefix                                         |
| user_id      | varchar(36)    | NOT NULL, FK `users` ON DELETE CASCADE                     |
| token_hash   | varchar(64)    | NOT NULL, UNIQUE: SHA-256 of the cookie token              |
| assurance    | varchar(10)    | NOT NULL, default `password`, `CHECK IN (pending, password, mfa)` |
| auth_method  | varchar(16)    | NOT NULL, default `password`, `CHECK IN` the credential types |
| expires_at   | timestamptz    | NOT NULL                                                   |
| last_seen_at | timestamptz    | NOT NULL, default `now()`: sliding refresh                 |
| ip           | varchar(45)    | nullable                                                   |
| user_agent   | varchar(255)   | nullable: writers truncate to 255                          |
| created_at   | timestamptz    | NOT NULL, default `now()`                                  |

Indexes: `sessions_user_id_idx` (revoke all of a user's sessions), `sessions_expires_at_idx` (purge).

### `user_tokens`

One-time tokens: the owner setup link, invitations, password resets.

| Column     | Type           | Constraints                                                     |
|------------|----------------|-----------------------------------------------------------------|
| id         | varchar(36)    | PK, `utk_` prefix                                               |
| user_id    | varchar(36)    | nullable, FK `users` ON DELETE CASCADE                           |
| email      | varchar(255)   | nullable, lower-cased: the invited address                      |
| purpose    | varchar(20)    | NOT NULL, `CHECK IN (owner_setup, invite, password_reset)`      |
| token_hash | varchar(64)    | NOT NULL, UNIQUE                                                |
| role       | varchar(10)    | nullable, `CHECK IN (owner, admin, member)`: role an invite grants |
| invited_by | varchar(36)    | nullable, FK `users` ON DELETE SET NULL: invite history survives |
| expires_at | timestamptz    | NOT NULL                                                        |
| used_at    | timestamptz    | nullable: spent                                                 |
| revoked_at | timestamptz    | nullable: withdrawn                                             |
| created_at | timestamptz    | NOT NULL, default `now()`                                       |

Checks: `user_tokens_target_check` (`user_id` or `email` must be set). Index: `user_tokens_email_purpose_idx` (re-inviting an address replaces its pending invitation).

## Types

`src/modules/users/types/user.types.ts` exports the value sets as constants and unions: `USER_ROLES` / `UserRole`, `CREDENTIAL_TYPES` / `CredentialType`, `SESSION_ASSURANCES` / `SessionAssurance`, `TOKEN_PURPOSES` / `TokenPurpose`. The same constants render the `CHECK` constraints (`literals()`), and an integration test reads the live constraint definitions back from Postgres and checks every value is present, so a constant changed without `bun run db:generate` fails the test instead of silently diverging.

## Service helpers

Pure, no I/O, no config.

### password.service.ts

- `hashPassword(password): Promise<string>`: argon2id via `Bun.password`, fresh salt per hash, parameters encoded in the hash so they can be raised later.
- `verifyPassword(password, hash): Promise<boolean>`: constant-time for a well-formed hash; a stored value that is not a supported hash yields `false` rather than throwing, while any other error propagates (a programming error must not read as "wrong password").

### token.service.ts

- `mintToken(): { token, hash }`: 32 random bytes as base64url (give to the user), plus its SHA-256 hex (store).
- `hashToken(token): string`: hash a presented token for lookup.

Both files are listed in `knip.json`'s `ignoreFiles` (unused-file check only) until #216 imports them; remove them from that list then.

## Migration

`drizzle/0016_*.sql` creates the four tables, applied automatically on boot by the runner. The `CHECK` lists are rendered as quoted literals via `sql.raw` (code constants): bound parameters are not valid in DDL, and drizzle-kit would otherwise emit `$1, $2` placeholders into the migration.

## Tests

- `test/unit/user-auth-helpers.test.ts`: hashing and verification, token minting and hashing.
- `test/integration/users-schema.integration.test.ts`: every invariant above against real Postgres, including a transfer of ownership inside one transaction and a failed transfer rolling back entirely.
