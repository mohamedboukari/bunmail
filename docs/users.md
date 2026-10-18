# Users Module

Dashboard user accounts (#214): the first piece of the invite-only accounts epic (#225), which replaces the shared `DASHBOARD_PASSWORD` with real accounts, roles and revocable sessions.

#214 shipped the **schema and the pure helpers**. The owner bootstrap (#215) is the first feature that reads and writes these tables: it creates the single owner from `BUNMAIL_OWNER_EMAIL` and lets them set a password through a one-time link (see [Owner bootstrap](#owner-bootstrap-215)). Login (#216), invitations (#217), roles (#218) and the auth guard (#222) build on them next. Until #216 the dashboard login keeps using `DASHBOARD_PASSWORD`.

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

For the owner bootstrap (#215) it also exports `OwnerSetupLink` (`{ token, email, expiresAt }`: a freshly minted link, the raw token shown once and never stored) and `OwnerBootstrapResult` (the discriminated union `bootstrapOwner` returns, see below).

## Owner bootstrap (#215)

`BUNMAIL_OWNER_EMAIL` names the dashboard owner. `readOwnerEmail` in `config.ts` trims and lowercases it (so it satisfies the `email = lower(email)` check and a case-only change is not a mismatch) and exposes it as `config.dashboard.ownerEmail`. An unset value refuses to boot in production and is `null` in development; a malformed value or one over 254 characters refuses to boot in every environment, and the error never echoes the value. The address check is `isEmailAddress` from `src/utils/recipients.ts` (the recipient parser's regex plus the 254-character cap), so the codebase keeps one address regex.

On every boot, after the DKIM key pass, `src/index.ts` calls `bootstrapOwner`. When `ownerEmail` is `null` (development only) it logs `BUNMAIL_OWNER_EMAIL is not set: owner bootstrap skipped` at `warn` and skips. A thrown error is logged (``Owner bootstrap failed; run `bun run src/db/reset-owner.ts` to retry``, `error`) and the boot continues: the API and mail delivery do not depend on the owner. The state machine, all under one transaction:

| State | Result | Effect |
|-------|--------|--------|
| No owner | `created` | Insert the owner (`role = 'owner'`), revoke any stray open `owner_setup` token, mint a new one, log the link |
| No owner, a non-owner user already has the email | `email-taken` | Nothing changes, `error` logged (`Owner bootstrap skipped: BUNMAIL_OWNER_EMAIL belongs to an existing non-owner account, which is never promoted`): the env value never promotes an existing account |
| Owner without a `password` credential (setup pending) | `reissued` | Revoke every open `owner_setup` token, mint a new one, log the link. A changed env email updates the stored one first (nobody has claimed the account yet); if another account already holds the new email, the result is `email-taken` instead and nothing changes |
| Owner with a password, same email (any case) | `complete` | Nothing, no log |
| Owner with a password, different email | `mismatch` | Nothing changes; `warn` `BUNMAIL_OWNER_EMAIL differs from the stored owner; ignored. Ownership moves only by transfer.` with `configured` and `stored` passed through `redactEmail` (masked when `LOG_REDACT_PII` is on, the production default; shown in full otherwise) |

**Locking.** Every owner mutation (bootstrap, `reset-owner`, setup completion) runs inside `db.transaction` under `pg_advisory_xact_lock(hashtext('bunmail:owner'))`, distinct from the `bunmail:migrations` lock. Replicas and crash loops therefore serialize: no unique violation on `users_single_owner` reaches the boot, at most one live link exists (each mint revokes every open `owner_setup` token; the schema has no such constraint), and a bootstrap racing a completion cannot leave a live token next to a freshly set password.

**Token lifecycle.** `mintToken()` gives a 256-bit base64url token; only `hashToken(token)` is stored in `user_tokens` (`purpose = 'owner_setup'`, `expires_at` = the app clock + 24 h). The link `<APP_BASE_URL or http://localhost:PORT>/dashboard/setup?token=...` is logged once at `warn` with the message `Owner setup link` and the fields `note`, `url`, `owner` (through `redactEmail`, so masked only when `LOG_REDACT_PII` is on), `expiresAt` and, when the localhost fallback was used, `hint`. It is logged only after the transaction commits, so a rolled-back token is never printed. A token is live while `used_at` and `revoked_at` are null and `expires_at > now()` (checked against the database clock), and its user is the enabled owner. `GET /dashboard/setup` only reads it. `POST /dashboard/setup` spends it with a conditional `UPDATE ... SET used_at = now() ... RETURNING` in the same transaction that replaces the `password` credential and revokes the owner's other open tokens, so two concurrent submissions cannot both win. Owner setup does not set `email_verified_at`: the link arrives through server logs and does not prove control of the mailbox.

**After setup (interim until #216).** The server logs `Owner setup completed` at `warn` with `owner` (through `redactEmail`) and the client `ip`. The owner is signed in with the existing stateless session cookie (the same one `POST /dashboard/login` issues) and redirected to `/dashboard`; when `DASHBOARD_PASSWORD` is empty (development, dashboard disabled) a "password saved" page is shown instead. The stored owner password is not used for login yet: `/dashboard/login` still checks `DASHBOARD_PASSWORD`. Those sessions end only on expiry (24 h) or a `SESSION_SECRET` rotation. #216 must make login read the owner credential and make completion and `reset-owner` revoke the owner's `sessions` rows.

**Recovery.** `src/db/reset-owner.ts` (`bun run src/db/reset-owner.ts`, or `docker compose exec app bun run src/db/reset-owner.ts`) calls `issueOwnerSetupLink` under the same lock and writes the link straight to stdout (`Owner setup link for <owner> (single use, expires ...)`, then the URL), not through the logger, so `LOG_LEVEL` cannot hide it: the script revokes every earlier link, so a filtered-out new link would leave none. With an owner, it revokes every open token of that user (any purpose) and mints a fresh `owner_setup` token; the stored email and the current password are kept until the new link is completed, so an abandoned reset cannot lock the owner out (a differing env email only warns). With no owner and an env email, it creates the owner as bootstrap does. With neither, or when a non-owner account already holds the env email, it logs `Owner reset failed` at `error` and exits 1. It has no HTTP surface: shell access is the trust boundary.

**Database errors.** Drizzle's query errors embed the query parameters (`Failed query: ... params: ...`), which on these paths include the new password hash, token hashes and the owner email. `owner.service.ts` therefore rethrows every query error as `OwnerStoreError` (`src/modules/users/errors.ts`), whose message carries only the Postgres SQLSTATE, so the global error handler, the boot step and `reset-owner.ts` never log them. Deliberate service errors (for example "No owner account exists ...") pass through unchanged.

## Service helpers

`password.service.ts`, `token.service.ts` and `owner-setup-policy.service.ts` are pure: no I/O, no config. `owner.service.ts` is the only one that touches the database.

### password.service.ts

- `hashPassword(password): Promise<string>`: argon2id via `Bun.password`, fresh salt per hash, parameters encoded in the hash so they can be raised later.
- `verifyPassword(password, hash): Promise<boolean>`: constant-time for a well-formed hash; a stored value that is not a supported hash yields `false` rather than throwing, while any other error propagates (a programming error must not read as "wrong password").

### token.service.ts

- `mintToken(): { token, hash }`: 32 random bytes as base64url (give to the user), plus its SHA-256 hex (store).
- `hashToken(token): string`: hash a presented token for lookup.

### owner-setup-policy.service.ts

- `OWNER_SETUP_TTL_MS`: lifetime of a setup link, 24 hours (a code constant, no env var).
- `setupTokenExpiry(now): Date`: `now + OWNER_SETUP_TTL_MS`.
- `isWellFormedSetupToken(token): boolean`: exactly 43 base64url characters (the form `mintToken` produces). Checked before any database call.
- `SETUP_PASSWORD_MIN_LENGTH` (15) and `SETUP_PASSWORD_MAX_LENGTH` (256): also the form's `minlength` / `maxlength`.
- `setupPasswordProblem(password, confirm): string | null`: 15 to 256 characters, counted in code points rather than UTF-16 units (15 per NIST SP 800-63B-4 for a single factor; 256 caps the argon2 input), and `confirm` must match; `null` when acceptable. The message never echoes the input.
- `buildSetupUrl(appBaseUrl, port, token): { url, usedFallback }`: uses `APP_BASE_URL` (trimmed, trailing slashes stripped) when it starts with `http://` or `https://`, otherwise `http://localhost:PORT` (and `usedFallback` lets the caller add a hint to set `APP_BASE_URL`).

### owner.service.ts

Every write runs in a transaction under the `bunmail:owner` advisory lock. Never logs the token or its hash.

- `bootstrapOwner(ownerEmail, now?): Promise<OwnerBootstrapResult>`: the state machine above; the result is a discriminated union on `kind` (`created` / `reissued` carry the token, email and expiry for the caller to log).
- `issueOwnerSetupLink(ownerEmail | null, now?): Promise<OwnerSetupLink>`: always replaces the open tokens; used by `reset-owner`. Throws when there is no owner and `ownerEmail` is `null`, or when a non-owner account holds `ownerEmail`.
- `findLiveOwnerSetup(token): Promise<{ userId, email } | null>`: read-only lookup of a live `owner_setup` token for the enabled owner.
- `completeOwnerSetup(token, password): Promise<{ userId, email } | null>`: cheap re-check first, then `hashPassword` outside the transaction (the lock is never held during argon2), then under the lock: spend the token, replace the `password` credential, revoke the user's other open tokens, touch `updated_at`. `null` when the token is no longer live.

## Migration

`drizzle/0016_*.sql` creates the four tables, applied automatically on boot by the runner. The `CHECK` lists are rendered as quoted literals via `sql.raw` (code constants): bound parameters are not valid in DDL, and drizzle-kit would otherwise emit `$1, $2` placeholders into the migration.

## Tests

- `test/unit/user-auth-helpers.test.ts`: hashing and verification, token minting and hashing.
- `test/integration/users-schema.integration.test.ts`: every invariant above against real Postgres, including a transfer of ownership inside one transaction and a failed transfer rolling back entirely.
- `test/unit/owner-email-config.test.ts`: `BUNMAIL_OWNER_EMAIL` parsing, normalization and the production refusal.
- `test/unit/owner-setup-policy.test.ts`: token format, expiry, password policy (including code-point counting) and setup URL building.
- `test/unit/recipients.test.ts`: `isEmailAddress`, the address check shared with `BUNMAIL_OWNER_EMAIL`.
- `test/unit/pages-render.test.ts`: the three setup pages render and escape their input.
- `test/unit/owner-store-error.test.ts`: a drizzle query error leaves the owner service as `OwnerStoreError` with the SQLSTATE only (no SQL, no params, no driver message); other errors pass through.
- `test/e2e/dashboard.test.ts` ("Owner setup", service mocked): public access, security headers (`Referrer-Policy: strict-origin`), identical invalid-link responses, same-origin check (including `Origin: null`, what a `no-referrer` page would send), password policy, cookie and redirect on success, a token spent between the check and the write, the done page when the dashboard is disabled, and protected routes still requiring a session.
- `test/integration/owner-setup.integration.test.ts`: fresh install, restart before setup (including a changed email and `email-taken`), concurrency (parallel bootstraps, parallel completions, bootstrap racing completion, completion and recovery provably waiting on the held owner lock, lock released after commit), expiry, single use and a disabled owner (including one disabled while completion waits on the lock), behaviour after setup, recovery, and a spawned `reset-owner.ts` smoke test (exit `0` with a live link, also under `LOG_LEVEL=error`; exit `1` with no owner and no email).
