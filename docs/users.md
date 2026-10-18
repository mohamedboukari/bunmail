# Users Module

Dashboard user accounts (#214): the first piece of the invite-only accounts epic (#225), which replaces the shared `DASHBOARD_PASSWORD` with real accounts, roles and revocable sessions.

#214 shipped the **schema and the pure helpers**. The owner bootstrap (#215) is the first feature that reads and writes these tables: it creates the single owner from `BUNMAIL_OWNER_EMAIL` and lets them set a password through a one-time link (see [Owner bootstrap](#owner-bootstrap-215)). Account login (#216) made that account the dashboard login, with server-side sessions in `sessions` (see [Sessions](#sessions-216)), and removed `DASHBOARD_PASSWORD` and `SESSION_SECRET`. Invitations (#217), roles (#218) and the auth guard (#222) build on them next.

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
| previous_token_hash | varchar(64) | nullable: SHA-256 of the token the last rotation replaced (#216); null before the first rotation |
| rotated_at   | timestamptz    | nullable: last token rotation (#216); null until the first |
| assurance    | varchar(10)    | NOT NULL, default `password`, `CHECK IN (pending, password, mfa)` |
| auth_method  | varchar(16)    | NOT NULL, default `password`, `CHECK IN` the credential types |
| expires_at   | timestamptz    | NOT NULL: idle timeout, capped at `created_at` + 7 days     |
| last_seen_at | timestamptz    | NOT NULL, default `now()`: moved forward on every rotation |
| ip           | varchar(45)    | nullable: only a valid IPv4/IPv6 literal is stored          |
| user_agent   | varchar(255)   | nullable: writers truncate to 255 (code points)            |
| created_at   | timestamptz    | NOT NULL, default `now()`                                  |

Indexes: `sessions_user_id_idx` (revoke all of a user's sessions), `sessions_expires_at_idx` (purge), `sessions_previous_token_hash_idx` (the guard looks a token up by either hash, #216).

### `session_token_history` (#216)

Every token a session rotated away from, kept until the session ends, so reuse of a token of any age is detected.

| Column        | Type        | Constraints                                              |
|---------------|-------------|----------------------------------------------------------|
| token_hash    | varchar(64) | PK: SHA-256 of the superseded token                      |
| session_id    | varchar(36) | NOT NULL, FK `sessions` ON DELETE CASCADE                 |
| superseded_at | timestamptz | NOT NULL, default `now()`                                |

Index: `session_token_history_session_id_idx`. One row per rotation (at most one a minute per active session); logout, revocation and the expired-session sweep remove the rows with their session.

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

For login and sessions (#216): `Tx` (a `db.transaction` handle) and `DbExecutor` (`db` or a `Tx`, so a caller can run a session write inside its own transaction), `SessionClient` (`{ ip, userAgent }`), `NewSessionInput`, `CreatedSession` (`{ sessionId, token }`), `ActiveSession` (`{ sessionId, userId, matched: "current" | "previous", rotationDue, graceOver }`), `RotatedSession` (`{ token, maxAgeSec }`), `LoginFailureReason`, `LoginResult` and `CompletedOwnerSetup` (`{ userId, email, sessionToken }`).

## Owner bootstrap (#215)

`BUNMAIL_OWNER_EMAIL` names the dashboard owner. `readOwnerEmail` in `config.ts` trims and lowercases it (so it satisfies the `email = lower(email)` check and a case-only change is not a mismatch) and exposes it as `config.dashboard.ownerEmail`. An unset value refuses to boot in production and is `null` in development; a malformed value or one over 254 characters refuses to boot in every environment, and the error never echoes the value. The address check is `isEmailAddress` from `src/utils/recipients.ts` (the recipient parser's regex plus the 254-character cap), so the codebase keeps one address regex.

On every boot, after the DKIM key pass, `src/index.ts` calls `bootstrapOwner`. When `ownerEmail` is `null` (development only) it logs `BUNMAIL_OWNER_EMAIL is not set: owner bootstrap skipped; the dashboard has no account to sign in with until BUNMAIL_OWNER_EMAIL is set` at `warn` and skips. A thrown error is logged (``Owner bootstrap failed; run `bun run src/db/reset-owner.ts` to retry``, `error`) and the boot continues: the API and mail delivery do not depend on the owner. The state machine, all under one transaction:

| State | Result | Effect |
|-------|--------|--------|
| No owner | `created` | Insert the owner (`role = 'owner'`), revoke any stray open `owner_setup` token, mint a new one, log the link |
| No owner, a non-owner user already has the email | `email-taken` | Nothing changes, `error` logged (`Owner bootstrap skipped: BUNMAIL_OWNER_EMAIL belongs to an existing non-owner account, which is never promoted`): the env value never promotes an existing account |
| Owner without a `password` credential (setup pending) | `reissued` | Revoke every open `owner_setup` token, mint a new one, log the link. A changed env email updates the stored one first (nobody has claimed the account yet); if another account already holds the new email, the result is `email-taken` instead and nothing changes |
| Owner with a password, same email (any case) | `complete` | Nothing, no log |
| Owner with a password, different email | `mismatch` | Nothing changes; `warn` `BUNMAIL_OWNER_EMAIL differs from the stored owner; ignored. Ownership moves only by transfer.` with `configured` and `stored` passed through `redactEmail` (masked when `LOG_REDACT_PII` is on, the production default; shown in full otherwise) |

**Locking.** Every owner mutation (bootstrap, `reset-owner`, setup completion) runs inside `db.transaction` under `pg_advisory_xact_lock(hashtext('bunmail:owner'))`, distinct from the `bunmail:migrations` lock. Replicas and crash loops therefore serialize: no unique violation on `users_single_owner` reaches the boot, at most one live link exists (each mint revokes every open `owner_setup` token; the schema has no such constraint), and a bootstrap racing a completion cannot leave a live token next to a freshly set password.

**Token lifecycle.** `mintToken()` gives a 256-bit base64url token; only `hashToken(token)` is stored in `user_tokens` (`purpose = 'owner_setup'`, `expires_at` = the app clock + 24 h). The link `<APP_BASE_URL or http://localhost:PORT>/dashboard/setup?token=...` is logged once at `warn` with the message `Owner setup link` and the fields `note`, `url`, `owner` (through `redactEmail`, so masked only when `LOG_REDACT_PII` is on), `expiresAt` and, when the localhost fallback was used, `hint`. It is logged only after the transaction commits, so a rolled-back token is never printed. A token is live while `used_at` and `revoked_at` are null and `expires_at > now()` (checked against the database clock), and its user is the enabled owner. `GET /dashboard/setup` only reads it. `POST /dashboard/setup` spends it with a conditional `UPDATE ... SET used_at = now() ... RETURNING` in the same transaction that replaces the `password` credential and revokes the owner's other open tokens, so two concurrent submissions cannot both win. Owner setup does not set `email_verified_at`: the link arrives through server logs and does not prove control of the mailbox.

**After setup.** The server logs `Owner setup completed` at `warn` with `owner` (through `redactEmail`) and the client `ip`. In the completion transaction (still under the owner lock) every session of the owner is deleted and a new one is created (#216), so no crash can leave an old session alive next to a new password; the route sets its token as the `bm_session` cookie and redirects to `/dashboard`. From then on the owner signs in at `/dashboard/login` with this email and password (see [Sessions](#sessions-216)).

**Recovery.** `src/db/reset-owner.ts` (`bun run src/db/reset-owner.ts`, or `docker compose exec app bun run src/db/reset-owner.ts`) calls `issueOwnerSetupLink` under the same lock and writes straight to stdout (`The owner's dashboard sessions were signed out.`, `Owner setup link for <owner> (single use, expires ...)`, then the URL), not through the logger, so `LOG_LEVEL` cannot hide it: the script revokes every earlier link, so a filtered-out new link would leave none. With an owner, it revokes every open token of that user (any purpose), deletes every session of the owner in the same transaction (#216: an operator who runs it usually suspects a compromise, so it is an immediate kill switch), and mints a fresh `owner_setup` token; the stored email and the current password are kept until the new link is completed, so an abandoned reset cannot lock the owner out (a differing env email only warns). Until then the old password can still sign in; completing the link deletes the owner's sessions again. With no owner and an env email, it creates the owner as bootstrap does. With neither, or when a non-owner account already holds the env email, it logs `Owner reset failed` at `error` and exits 1. It has no HTTP surface: shell access is the trust boundary.

**Database errors.** Drizzle's query errors embed the query parameters (`Failed query: ... params: ...`), which on these paths include the new password hash, setup and session token hashes and account emails. Every query of the users module (`owner.service.ts`, `session.service.ts`, `login.service.ts`) therefore runs through `withSanitizedErrors` (`src/modules/users/errors.ts`), which rethrows a query error as `UserStoreError` (renamed from `OwnerStoreError` in #216), whose message carries only the Postgres SQLSTATE, so the global error handler, the boot step, the dashboard guard and `reset-owner.ts` never log them. Deliberate service errors (for example "No owner account exists ...") pass through unchanged.

## Sessions (#216)

The dashboard login is an account login: email and password against `user_credentials`, then a server-side session row. The cookie (`bm_session`, `HttpOnly; SameSite=Lax; Path=/dashboard`, `Secure` in production) carries an opaque 256-bit token; only its SHA-256 is stored, so a database dump yields no usable cookie, and logs carry the `ses_` id, never the token or its hash. Route-level behaviour (order of checks, status codes, log lines) is in [docs/dashboard.md](dashboard.md#auth-flow).

**Lifetimes** (code constants in `session-policy.service.ts`): idle timeout 24 h (`SESSION_IDLE_SECONDS`), absolute cap 7 days (`SESSION_ABSOLUTE_SECONDS`), rotation after 60 s (`SESSION_ROTATE_SECONDS`), grace for the replaced token 30 s (`SESSION_ROTATION_GRACE_SECONDS`). Every time comparison runs on the database clock (`now()`), so replicas with skewed clocks agree.

**Lifecycle:**

- **Create.** A successful login, or owner setup completion inside its locked transaction, inserts a row with `expires_at = now() + 24 h`, `rotated_at` null and assurance `password` (the login step's `firstFactorAssurance()` is where #220 will return `pending` for users with a second factor). A login first revokes the session the browser presented, if any. The cookie `Max-Age` is the 7-day cap.
- **Look up.** The guard hashes the presented token (after a shape check, so malformed and pre-#216 cookies never cost a query) and runs one query matching it against `token_hash` or `previous_token_hash`, joined to `users`: unexpired, user not disabled, assurance `password` or `mfa`. A `pending` session can never open a protected page.
- **Rotate.** When the current token is older than 60 s (`coalesce(rotated_at, created_at)`), the guard mints a new token and runs one conditional `UPDATE ... WHERE id = $id AND token_hash = $presented AND expires_at > now()`: `previous_token_hash` gets the old hash, `token_hash` the new one, `rotated_at` and `last_seen_at` become `now()`, and `expires_at` becomes `LEAST(now() + 24 h, created_at + 7 days)`. This write is the sliding refresh, so a session costs at most one write a minute. When two requests race, one `UPDATE` matches and sets the cookie (with `Max-Age` = seconds left until the cap); the other matches nothing and is served without a new cookie.
- **Reuse detection.** The previous token is served (no write, no cookie) for 30 s after the rotation. Presented later, it means two parties hold the session: `revokeAllUserSessions` deletes every session of the user and the guard logs `Session token reuse detected: all sessions of the user revoked`. Every replaced hash is also written to `session_token_history` (in the rotation's transaction) and kept until the session ends, so a token two or more rotations old is recognized as reuse too (`findSessionBySupersededToken`, only for unexpired sessions), in the guard and also on the login and logout pages. A lost response (the new cookie never reached the browser) looks like reuse and signs the user out: a rare false positive, accepted for the detection.
- **Revoke.** Logout deletes the row (matching the current or the previous hash). Owner setup completion and `reset-owner` delete every session of the owner under the owner lock. `revokeAllUserSessions(userId, executor?)` is also the hook for deactivation (#218) and password change (#277). Independently, the lookup and the login reject a disabled user, so leftover rows grant nothing, and `ON DELETE CASCADE` removes the rows of a deleted user.
- **Sweep.** The purge worker (`runSessionSweep` in `src/modules/trash/services/purge.service.ts`) calls `purgeExpiredSessions()` on boot and every 6 hours and logs `Expired session sweep completed` with `deleted`. Housekeeping only: the guard enforces expiry itself.

**Login without account enumeration.** `verifyPasswordLogin` runs exactly one argon2id verify on every branch: an unknown email or a user without a password is verified against a dummy hash made once per process by the same `hashPassword` (so the cost parameters match), and a disabled user verifies the real hash and then fails. Every failure reason (`unknown`, `no_password`, `disabled`, `bad_password`, plus `too_long` decided in the route before any lookup) gets the same response. On success `user_credentials.last_used_at` is updated. The first unknown-email login of a process also creates the dummy hash, one extra argon2id hash; that slower response happens once per process.

No JavaScript secret comparison is left on these paths: the presented token is hashed and looked up through a unique index, and argon2id verification is constant-time inside Bun. That is why the pre-#216 `crypto.timingSafeEqual` check (and its spy test) is gone.

## Service helpers

`password.service.ts`, `token.service.ts`, `owner-setup-policy.service.ts` and `session-policy.service.ts` are pure: no I/O, no config. `owner.service.ts`, `session.service.ts` and `login.service.ts` touch the database, all through `withSanitizedErrors`.

### password.service.ts

- `hashPassword(password): Promise<string>`: argon2id via `Bun.password`, fresh salt per hash, parameters encoded in the hash so they can be raised later.
- `verifyPassword(password, hash): Promise<boolean>`: constant-time for a well-formed hash; a stored value that is not a supported hash yields `false` rather than throwing, while any other error propagates (a programming error must not read as "wrong password").

### token.service.ts

- `mintToken(): { token, hash }`: 32 random bytes as base64url (give to the user), plus its SHA-256 hex (store).
- `hashToken(token): string`: hash a presented token for lookup.
- `isWellFormedToken(value): boolean`: exactly 43 base64url characters, the shape `mintToken` produces (#216). Checked before any database call; it rejects a pre-#216 `<ts>.<hmac>` cookie.

### owner-setup-policy.service.ts

- `OWNER_SETUP_TTL_MS`: lifetime of a setup link, 24 hours (a code constant, no env var).
- `setupTokenExpiry(now): Date`: `now + OWNER_SETUP_TTL_MS`.
- `isWellFormedSetupToken(token): boolean`: delegates to `isWellFormedToken`. Checked before any database call.
- `SETUP_PASSWORD_MIN_LENGTH` (15) and `SETUP_PASSWORD_MAX_LENGTH` (256): also the form's `minlength` / `maxlength`.
- `setupPasswordProblem(password, confirm): string | null`: 15 to 256 characters, counted in code points rather than UTF-16 units (15 per NIST SP 800-63B-4 for a single factor; 256 caps the argon2 input), and `confirm` must match; `null` when acceptable. The message never echoes the input.
- `buildSetupUrl(appBaseUrl, port, token): { url, usedFallback }`: uses `APP_BASE_URL` (trimmed, trailing slashes stripped) when it starts with `http://` or `https://`, otherwise `http://localhost:PORT` (and `usedFallback` lets the caller add a hint to set `APP_BASE_URL`).

### owner.service.ts

Every write runs in a transaction under the `bunmail:owner` advisory lock. Never logs the token or its hash.

- `bootstrapOwner(ownerEmail, now?): Promise<OwnerBootstrapResult>`: the state machine above; the result is a discriminated union on `kind` (`created` / `reissued` carry the token, email and expiry for the caller to log).
- `issueOwnerSetupLink(ownerEmail | null, now?): Promise<OwnerSetupLink>`: always replaces the open tokens and deletes every session of an existing owner (#216); used by `reset-owner`. Throws when there is no owner and `ownerEmail` is `null`, or when a non-owner account holds `ownerEmail`.
- `findLiveOwnerSetup(token): Promise<{ userId, email } | null>`: read-only lookup of a live `owner_setup` token for the enabled owner.
- `completeOwnerSetup(token, password, client?): Promise<CompletedOwnerSetup | null>`: cheap re-check first, then `hashPassword` outside the transaction (the lock is never held during argon2), then under the lock: spend the token, replace the `password` credential, revoke the user's other open tokens, delete every session of the owner, create the new session (`client` is the `{ ip, userAgent }` stored with it, default both `null`), touch `updated_at`. All or nothing. Returns `{ userId, email, sessionToken }`, or `null` when the token is no longer live.

### session-policy.service.ts

- `SESSION_IDLE_SECONDS` (24 h), `SESSION_ABSOLUTE_SECONDS` (7 days, also the login cookie `Max-Age`), `SESSION_ROTATE_SECONDS` (60), `SESSION_ROTATION_GRACE_SECONDS` (30).
- `LOGIN_EMAIL_MAX_LENGTH` (254, the address cap) and `LOGIN_PASSWORD_MAX_LENGTH` (256, the setup cap, so every stored password can be typed in): also the login form's `maxlength`.
- `normalizeLoginEmail(email)`: trimmed and lower-cased, as `users.email` stores it (also used by the owner bootstrap).
- `loginInputTooLong(email, password)`: over either bound (the password counted in code points); the route then fails the login without any lookup.
- `sessionIp(ip)`: the value to store in `sessions.ip`: a valid IPv4/IPv6 literal, otherwise `null`, so a forged `X-Forwarded-For` can never make a valid login fail on the column width.
- `clampUserAgent(userAgent)`: cut to 255 code points (never splits a surrogate pair), or `null`.

### session.service.ts

- `createSession(input, executor?): Promise<CreatedSession>`: mints the token, inserts the row (`ip` and `user_agent` cleaned with `sessionIp` and `clampUserAgent`), returns `{ sessionId, token }`.
- `findActiveSession(token): Promise<ActiveSession | null>`: the guard's single lookup described above.
- `rotateSession(sessionId, presentedToken): Promise<RotatedSession | null>`: the conditional rotation; `null` when another request rotated first.
- `revokeSessionByToken(token): Promise<string | null>`: deletes the session whose current or previous hash matches; returns its `ses_` id.
- `revokeAllUserSessions(userId, executor?): Promise<number>`: deletes every session of a user.
- `purgeExpiredSessions(): Promise<number>`: deletes expired rows.

### login.service.ts

- `verifyPasswordLogin(email, password): Promise<LoginResult>`: the password step described above; `{ ok: true, userId, assurance }` or `{ ok: false, reason }`.

## Migration

`drizzle/0016_*.sql` creates the four tables, applied automatically on boot by the runner. The `CHECK` lists are rendered as quoted literals via `sql.raw` (code constants): bound parameters are not valid in DDL, and drizzle-kit would otherwise emit `$1, $2` placeholders into the migration.

`drizzle/0017_*.sql` (#216) adds the nullable `sessions.previous_token_hash` and `sessions.rotated_at` columns, the `sessions_previous_token_hash_idx` index, and the `session_token_history` table (`token_hash` PK, `session_id` FK `sessions` ON DELETE CASCADE, `superseded_at`, index on `session_id`). No backfill: existing rows simply have not rotated yet.

## Tests

- `test/unit/user-auth-helpers.test.ts`: hashing and verification, token minting and hashing.
- `test/integration/users-schema.integration.test.ts`: every invariant above against real Postgres, including a transfer of ownership inside one transaction and a failed transfer rolling back entirely.
- `test/unit/owner-email-config.test.ts`: `BUNMAIL_OWNER_EMAIL` parsing, normalization and the production refusal.
- `test/unit/owner-setup-policy.test.ts`: token format, expiry, password policy (including code-point counting) and setup URL building.
- `test/unit/recipients.test.ts`: `isEmailAddress`, the address check shared with `BUNMAIL_OWNER_EMAIL`.
- `test/unit/pages-render.test.ts`: the login page (email and password inputs, escaped error, disabled when rate-limited) and the two setup pages render and escape their input.
- `test/unit/owner-store-error.test.ts`: a drizzle query error leaves the users services as `UserStoreError` with the SQLSTATE only (no SQL, no params, no driver message), also through `withSanitizedErrors`; other errors pass through.
- `test/unit/session.test.ts`: the cookie helpers (exact-name parsing, a legacy value returned as is, attributes, `Secure` only when asked, `Max-Age` clamping, clearing).
- `test/unit/session-policy.test.ts`: token shape (including a pre-#216 HMAC cookie), `sessionIp`, `clampUserAgent`, email normalization and input bounds, and the lifetime constants and their ordering.
- `test/e2e/dashboard.test.ts` (services mocked): login (same-origin, bounds, identical failures, session replacement, `503` on a database error), the #109 limiter, protected routes without a usable session, rotation and reuse detection (new cookie, no write when not due, grace, lost race, rotation error, reuse revoking every session, `503` when that revoke fails, cross-origin POST refused before rotation), owner setup (public access, security headers, identical invalid-link responses, same-origin check including `Origin: null`, password policy, cookie and redirect on success, a token spent between the check and the write) and logout (revocation, legacy cookie, revoke error, cross-origin `403`).
- `test/integration/dashboard-session.integration.test.ts`: login against real Postgres (only the hash stored, `last_used_at`, distinct cookies, session replacement, one argon2id verify on every failure branch), logout, the guard (expired, disabled user, `pending` assurance, tampered token, old HMAC cookie), rotation (after 60 s, the absolute cap, grace, exactly one winner among concurrent requests), reuse detection (every session of the user revoked; a token two rotations old only rejected) and the service helpers (sweep, per-user revoke, IP cleaning).
- `test/integration/owner-setup.integration.test.ts`: fresh install, restart before setup (including a changed email and `email-taken`), concurrency (parallel bootstraps, parallel completions, bootstrap racing completion, completion and recovery provably waiting on the held owner lock, lock released after commit), expiry, single use and a disabled owner (including one disabled while completion waits on the lock), behaviour after setup, sessions (completion deletes the owner's sessions and opens exactly one; a failed completion leaves them; `issueOwnerSetupLink` signs out only the owner), recovery, and a spawned `reset-owner.ts` smoke test (exit `0` with a live link and the sign-out line, also under `LOG_LEVEL=error`; exit `1` with no owner and no email).
