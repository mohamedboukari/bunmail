# Users Module

Dashboard user accounts (#214): the first piece of the invite-only accounts epic (#225), which replaces the shared `DASHBOARD_PASSWORD` with real accounts, roles and revocable sessions.

#214 shipped the **schema and the pure helpers**. The owner bootstrap (#215) is the first feature that reads and writes these tables: it creates the single owner from `BUNMAIL_OWNER_EMAIL` and lets them set a password through a one-time link (see [Owner bootstrap](#owner-bootstrap-215)). Account login (#216) made that account the dashboard login, with server-side sessions in `sessions` (see [Sessions](#sessions-216)), and removed `DASHBOARD_PASSWORD` and `SESSION_SECRET`. The auth guard (#222) enforces the roles on every dashboard route (see [Roles enforcement](#roles-enforcement-222)). Invitations (#217) are the only way other accounts come to exist (see [Invitations](#invitations-217)). Account management (#218) lets the owner and admins change roles, deactivate, reactivate and remove accounts, and the owner hand over ownership (see [Account management](#account-management-218)). Record ownership (#219) ties API keys, templates, domains and webhooks to the user who created them (see [Record ownership](#record-ownership-219)). Admin-issued reset links (#277) let a user who forgot their password back in (see [Password resets](#password-resets-277)), and every signed-in user can change their own password (#279, see [Password change](#password-change-279)) and see and sign out their own sessions (#281, see [Active sessions](#active-sessions-281)). A password sign-in from a browser the account has not used recently emails the account an alert (#282, see [New-device alerts](#new-device-alerts-282)). Any account can add TOTP two-factor authentication with recovery codes, and `REQUIRE_2FA` can make it mandatory for the owner or for admins and the owner (#220, see [Two-factor authentication](#two-factor-authentication-220)). Every one of these actions, and every sign-in, is recorded in the audit log (#221, [docs/audit-log.md](audit-log.md)).

## Design

- **Identity and credentials are separate.** `users` holds who someone is; `user_credentials` holds one row per way they can log in. A password is the first credential type; TOTP (#220), passkeys (#223) and OAuth/SSO (#224) are further rows with the columns they need already present (`provider`, `provider_account_id`, `public_key`, `counter`, `name`). The `metadata` jsonb column from the original design is deliberately deferred: every planned type has explicit columns; a later type that needs free-form data adds it with the `jsonb` column type from `src/db/jsonb.ts` (#261). TOTP recovery codes (#220) live in a small table of their own, `user_recovery_codes` (ten per account, each spent separately), bound to the `totp` credential.
- **Sessions carry an assurance level.** `pending` (first factor passed, second required), `password`, `mfa`. The auth guard (#222) can require a minimum per route (`requireAssurance`), so adding 2FA later touches no routes.
- **Invariants live in the database.** Exactly one owner, lower-cased unique emails, and every enum column limited to its value set by a `CHECK` constraint, so a typo can never become a privilege.
- **Secrets are never stored.** Session cookies and one-time links carry a random 256-bit token; only its SHA-256 hash is in the database. The `bm_device` cookie (#282) is stored the same way, although it is not a credential. Passwords are argon2id hashes from `Bun.password`.
- **No new dependency for auth.** Hashing, randomness, SHA-256, and TOTP (#220: HMAC-SHA1, RFC 4226 / RFC 6238, base32) come from Bun and Node's `crypto`. The dependencies of the module are `mmdb-lib` (pinned, no dependencies of its own), which reads the optional offline GeoIP database of the Active sessions page (#281), and `uqr` (#220, pinned to `0.1.3`, MIT, no dependencies of its own, by unjs), which only computes the QR code module matrix of the enrolment page; the SVG is drawn by our own component from that matrix.

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
| secret_hash         | text           | nullable: argon2id hash, or the TOTP secret (#220): its base32 text encrypted with `encryptSecret` under `DKIM_ENCRYPTION_KEY` (AES-256-GCM, `v1:` format) |
| public_key          | text           | nullable: passkey public key                           |
| counter             | bigint         | nullable: passkey signature counter (unsigned 32-bit), or for `totp` the last accepted time step (#220, replay protection) |
| last_used_at        | timestamptz    | nullable                                               |
| created_at          | timestamptz    | NOT NULL, default `now()`                              |
| updated_at          | timestamptz    | NOT NULL, default `now()`                              |

Indexes: `user_credentials_one_password_per_user` (unique on `user_id WHERE type = 'password'`), `user_credentials_one_totp_per_user` (#220, unique on `user_id WHERE type = 'totp'`: two racing confirmations cannot both store a second factor), `user_credentials_provider_account_unique` (unique on `(provider, provider_account_id) WHERE provider IS NOT NULL`: an external account links to one user).

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
| credential_id | varchar(36)   | nullable, FK `user_credentials` ON DELETE CASCADE: the credential the session was opened with (#277); null for sessions opened before migration `0019` |
| expires_at   | timestamptz    | NOT NULL: idle timeout, capped at `created_at` + 7 days; for a `pending` session (#220) `created_at` + 10 minutes, never extended |
| last_seen_at | timestamptz    | NOT NULL, default `now()`: moved forward on every rotation |
| ip           | varchar(45)    | nullable: only a valid IPv4/IPv6 literal is stored          |
| user_agent   | varchar(255)   | nullable: writers truncate to 255 (code points)            |
| location     | varchar(128)   | nullable: approximate location of `ip` (#281), "City, Country" or "Country", set in the background after the session is created when GeoIP is configured; null otherwise (migration `0025`) |
| totp_pending_secret | text    | nullable: a TOTP enrolment started in this session and not confirmed yet (#220), the new secret encrypted like `user_credentials.secret_hash`; cleared at confirmation (migration `0027`) |
| created_at   | timestamptz    | NOT NULL, default `now()`                                  |

Indexes: `sessions_user_id_idx` (revoke all of a user's sessions), `sessions_expires_at_idx` (purge), `sessions_previous_token_hash_idx` (the guard looks a token up by either hash, #216), `sessions_credential_id_idx` (the cascade from a replaced credential, #277).

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
| role       | varchar(10)    | nullable, `CHECK IN (owner, admin, member)`: role an invite grants (`admin` or `member` only, see below) |
| invited_by | varchar(36)    | nullable, FK `users` ON DELETE SET NULL: who sent an invitation, or who issued a password reset link (#277: "issued by"); history survives |
| expires_at | timestamptz    | NOT NULL                                                        |
| used_at    | timestamptz    | nullable: spent                                                 |
| revoked_at | timestamptz    | nullable: withdrawn                                             |
| created_at | timestamptz    | NOT NULL, default `now()`                                       |

Checks: `user_tokens_target_check` (`user_id` or `email` must be set); `user_tokens_invite_check` (#217): a row with `purpose = 'invite'` must have an `email` and a `role` of `admin` or `member`, so no code path and no hand-written row can mint an owner invitation (`role IS NOT NULL` is spelled out, since a NULL `IN (...)` would pass a CHECK). Index: `user_tokens_email_purpose_idx` (re-inviting an address replaces its pending invitation).

### `user_recovery_codes` (#220)

TOTP recovery codes: ten per account with a second factor, each usable once in place of a code from the authenticator app.

| Column        | Type         | Constraints                                                     |
|---------------|--------------|-----------------------------------------------------------------|
| id            | varchar(36)  | PK, `rcv_` prefix                                               |
| user_id       | varchar(36)  | NOT NULL, FK `users` ON DELETE CASCADE                           |
| credential_id | varchar(36)  | NOT NULL, FK `user_credentials` ON DELETE CASCADE: the `totp` credential the code was issued with, so disabling 2FA (or a reset removing it) deletes the codes in the same statement |
| code_hash     | varchar(64)  | NOT NULL: SHA-256 (hex) of the normalized code (16 upper-case base32 characters); the code itself is never stored |
| used_at       | timestamptz  | nullable: when it was spent                                     |
| created_at    | timestamptz  | NOT NULL, default `now()`                                       |

Indexes: `user_recovery_codes_user_id_code_hash_idx` (UNIQUE, the sign-in lookup), `user_recovery_codes_credential_id_idx` (the cascade). A table of their own rather than `user_credentials` rows: a recovery code is not a way to log in on its own, there are ten per account, each is spent separately (`used_at`), and a credential type would also widen `sessions.auth_method`. A fast hash is enough: each code carries 80 random bits.

### `user_devices` (#282)

The browsers each account signed in from with a password, for the new-device alert. One row per account and `bm_device` cookie.

| Column        | Type         | Constraints                                                     |
|---------------|--------------|-----------------------------------------------------------------|
| id            | varchar(36)  | PK, `udv_` prefix                                               |
| user_id       | varchar(36)  | NOT NULL, FK `users` ON DELETE CASCADE                           |
| device_hash   | varchar(64)  | NOT NULL: SHA-256 of the `bm_device` cookie value (the value is never stored) |
| user_agent    | varchar(64)  | nullable: the device label at the last sign-in ("Chrome on macOS", fixed strings from `describeUserAgent`), not the raw header |
| ip            | varchar(45)  | nullable: client IP at the last sign-in, only a valid IPv4/IPv6 literal |
| location      | varchar(128) | nullable: approximate location of `ip` (#281) when the lookup answered within 2 s |
| first_seen_at | timestamptz  | NOT NULL, default `now()`                                       |
| last_seen_at  | timestamptz  | NOT NULL, default `now()`: moved forward at every sign-in from this browser |

Indexes: `user_devices_user_id_device_hash_idx` (UNIQUE, the sign-in upsert's conflict target), `user_devices_user_id_idx` (the account's devices, the cascade), `user_devices_last_seen_at_idx` (the 400-day sweep).

## Types

`src/modules/users/types/user.types.ts` exports the value sets as constants and unions: `USER_ROLES` / `UserRole`, `CREDENTIAL_TYPES` / `CredentialType`, `SESSION_ASSURANCES` / `SessionAssurance`, `TOKEN_PURPOSES` / `TokenPurpose`. The same constants render the `CHECK` constraints (`literals()`), and an integration test reads the live constraint definitions back from Postgres and checks every value is present, so a constant changed without `bun run db:generate` fails the test instead of silently diverging.

For the owner bootstrap (#215) it also exports `OwnerSetupLink` (`{ token, email, expiresAt }`: a freshly minted link, the raw token shown once and never stored) and `OwnerBootstrapResult` (the discriminated union `bootstrapOwner` returns, see below).

For invitations (#217): `INVITE_ROLES` / `InviteRole` (`admin`, `member`) with `isInviteRole`, `InviteActor` (`{ id, role }` from `auth`), `InviteRefusal` (`invalid_email`, `role_not_allowed`, `account_exists`, `not_found`), `InviteMailFailure` / `InviteMailOutcome`, `IssuedInvitation` (`{ invitationId, token, email, role, expiresAt, replaced }`, the raw token never stored), `IssueInvitationResult`, `PendingInvitation`, `InviteTarget`, `InviteAcceptance` and `AcceptInvitationResult`.

For password resets (#277): `IssuedPasswordReset` (`{ resetId, token, expiresAt, replaced }`, the raw token never stored), `IssuePasswordResetResult` (`{ ok: true, resetId, url, usedFallback, expiresAt }` or `{ ok: false, reason }`), `PasswordResetTarget` (`{ resetId, userId, email }`) and `CompletePasswordResetResult`; `AccountAction` gains `reset_password` and `AccountRefusal` gains `account_disabled`.

For password changes (#279): `PasswordChangeInput` (`{ userId, assurance, current, password, confirm }`; `assurance`, #220, is that of the session the change is made from), `PasswordChangeRefusal` (`rate_limited`, `invalid_input`, `wrong_password`, `account_inactive`, `credential_changed`) and `ChangePasswordResult`.

For two-factor authentication (#220): `TWO_FACTOR_POLICIES` / `TwoFactorPolicy` (`none`, `owner`, `admin`) with `isTwoFactorPolicy`, `TwoFactorStatus` (`{ enabled, enabledAt, recoveryCodesLeft }`), `PendingEnrolment` (`{ secret, uri }`, never logged), `TwoFactorRefusal` (`rate_limited`, `no_pending`, `already_enabled`, `not_enabled`, `wrong_code`, `wrong_password`), `ConfirmEnrolmentResult`, `RegenerateRecoveryCodesResult`, `DisableTwoFactorResult`, `SecondFactorMethod` (`totp`, `recovery_code`), `PendingSession` (`{ sessionId, userId, email }`) and `TwoFactorLoginResult`; `ActiveSession` gains `hasTotp`, and `CompletePasswordResetResult` and `CompletedOwnerSetup` gain `twoFactorRemoved`.

For login and sessions (#216): `Tx` (a `db.transaction` handle) and `DbExecutor` (`db` or a `Tx`, so a caller can run a session write inside its own transaction), `SessionClient` (`{ ip, userAgent }`), `NewSessionInput` (with an optional `credentialId`, #277), `CreatedSession` (`{ sessionId, token }`), `ActiveSession` (`{ sessionId, userId, matched: "current" | "previous", rotationDue, graceOver }`), `RotatedSession` (`{ token, maxAgeSec }`), `LoginFailureReason`, `LoginResult` (a success carries the verified `credentialId`, #277) and `CompletedOwnerSetup` (`{ userId, email, sessionToken }`).

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

**Legacy records (#219).** In the same transaction, whatever the outcome, once an owner row exists (setup complete or still pending): every row of `api_keys`, `templates`, `domains` and `webhooks` whose `created_by_user_id` is NULL is assigned to the owner (`assignUnownedRecords`). This is the upgrade backfill: migrations run before the owner exists, so a migration could not do it. On the first boot after the upgrade the owner and every legacy record are linked at once; later boots find nothing (or only the rows of users removed since). When anything changed it logs `info` `Records without a creator assigned to the owner` with `ownerId` and the per-table counts `records: { keys, templates, domains, webhooks }`, after commit.

**Locking.** Every owner mutation (bootstrap, `reset-owner`, setup completion) runs inside `db.transaction` under `pg_advisory_xact_lock(hashtext('bunmail:owner'))`, distinct from the `bunmail:migrations` lock. Replicas and crash loops therefore serialize: no unique violation on `users_single_owner` reaches the boot, at most one live link exists (each mint revokes every open `owner_setup` token; the schema has no such constraint), and a bootstrap racing a completion cannot leave a live token next to a freshly set password.

**Token lifecycle.** `mintToken()` gives a 256-bit base64url token; only `hashToken(token)` is stored in `user_tokens` (`purpose = 'owner_setup'`, `expires_at` = the app clock + 24 h). The link `<APP_BASE_URL or http://localhost:PORT>/dashboard/setup?token=...` is logged once at `warn` with the message `Owner setup link` and the fields `note`, `url`, `owner` (through `redactEmail`, so masked only when `LOG_REDACT_PII` is on), `expiresAt` and, when the localhost fallback was used, `hint`. It is logged only after the transaction commits, so a rolled-back token is never printed. A token is live while `used_at` and `revoked_at` are null and `expires_at > now()` (checked against the database clock), and its user is the enabled owner. `GET /dashboard/setup` only reads it. `POST /dashboard/setup` spends it with a conditional `UPDATE ... SET used_at = now() ... RETURNING` in the same transaction that replaces the `password` credential and revokes the owner's other open tokens, so two concurrent submissions cannot both win. Owner setup does not set `email_verified_at`: the link arrives through server logs and does not prove control of the mailbox.

**After setup.** The server logs `Owner setup completed` at `warn` with `owner` (through `redactEmail`) and the client `ip`. In the completion transaction (still under the owner lock) every session of the owner is deleted and a new one is created (#216), so no crash can leave an old session alive next to a new password; the route sets its token as the `bm_session` cookie and redirects to `/dashboard`. From then on the owner signs in at `/dashboard/login` with this email and password (see [Sessions](#sessions-216)).

**Recovery.** `src/db/reset-owner.ts` (`bun run src/db/reset-owner.ts`, or `docker compose exec app bun run src/db/reset-owner.ts`) calls `issueOwnerSetupLink` under the same lock and writes straight to stdout (`The owner's dashboard sessions were signed out.`, `Owner setup link for <owner> (single use, expires ...)`, then the URL), not through the logger, so `LOG_LEVEL` cannot hide it: the script revokes every earlier link, so a filtered-out new link would leave none. With an owner, it revokes every open token of that user (any purpose), deletes every session of the owner in the same transaction (#216: an operator who runs it usually suspects a compromise, so it is an immediate kill switch), and mints a fresh `owner_setup` token; the stored email and the current password are kept until the new link is completed, so an abandoned reset cannot lock the owner out (a differing env email only warns). Until then the old password can still sign in; completing the link deletes the owner's sessions again. With no owner and an env email, it creates the owner as bootstrap does. With neither, or when a non-owner account already holds the env email, it logs `Owner reset failed` at `error` and exits 1. It has no HTTP surface: shell access is the trust boundary.

**Database errors.** Drizzle's query errors embed the query parameters (`Failed query: ... params: ...`), which on these paths include the new password hash, setup and session token hashes and account emails. Every query of the users module (`owner.service.ts`, `session.service.ts`, `login.service.ts`) therefore runs through `withSanitizedErrors` (`src/modules/users/errors.ts`), which rethrows a query error as `UserStoreError` (renamed from `OwnerStoreError` in #216), whose message carries only the Postgres SQLSTATE, so the global error handler, the boot step, the dashboard guard and `reset-owner.ts` never log them. Deliberate service errors (for example "No owner account exists ...") pass through unchanged.

## Sessions (#216)

The dashboard login is an account login: email and password against `user_credentials`, then a server-side session row. The cookie (`bm_session`, `HttpOnly; SameSite=Lax; Path=/dashboard`, `Secure` in production) carries an opaque 256-bit token; only its SHA-256 is stored, so a database dump yields no usable cookie, and logs carry the `ses_` id, never the token or its hash. Route-level behaviour (order of checks, status codes, log lines) is in [docs/dashboard.md](dashboard.md#auth-flow).

**Lifetimes** (code constants in `session-policy.service.ts`): idle timeout 24 h (`SESSION_IDLE_SECONDS`), absolute cap 7 days (`SESSION_ABSOLUTE_SECONDS`), rotation after 60 s (`SESSION_ROTATE_SECONDS`), grace for the replaced token 30 s (`SESSION_ROTATION_GRACE_SECONDS`). Every time comparison runs on the database clock (`now()`), so replicas with skewed clocks agree.

**Lifecycle:**

- **Create.** A successful login, or owner setup completion inside its locked transaction (likewise invitation acceptance and password reset completion), inserts a row bound to the credential just checked or written (`credential_id`, #277), with `expires_at = now() + 24 h`, `rotated_at` null and assurance `password`; a login of an account with a TOTP second factor gets assurance `pending` instead, with `expires_at = now() + 10 minutes` (`firstFactorAssurance()` in the login step, #220, see [Two-factor authentication](#two-factor-authentication-220)). A login first revokes the session the browser presented, if any. The cookie `Max-Age` is the 7-day cap. **Credential binding (#277):** a login verifies the password, then inserts the session naming that credential. If a password reset (or owner setup) replaced the credential in between, the insert fails with a foreign-key violation (`23503`) and the route answers the generic invalid email or password redirect (`Dashboard login failed`, `reason: credential_replaced`; the attempt stays counted, and the IP's failures are cleared only once a session exists), so the old password never opens a session after a reset. Replacing a credential (DELETE and INSERT) also deletes, by cascade, every session bound to the old one.
- **Look up.** The guard hashes the presented token (after a shape check, so malformed and pre-#216 cookies never cost a query) and runs one query matching it against `token_hash` or `previous_token_hash`, joined to `users`: unexpired, user not disabled, assurance `mfa`, or `password` only while the account has no `totp` credential (#220). A `pending` session can never open a protected page, and a password-level session stops opening one the moment the account has a second factor.
- **Rotate.** When the current token is older than 60 s (`coalesce(rotated_at, created_at)`), the guard mints a new token and runs one conditional `UPDATE ... WHERE id = $id AND token_hash = $presented AND expires_at > now()`: `previous_token_hash` gets the old hash, `token_hash` the new one, `rotated_at` and `last_seen_at` become `now()`, and `expires_at` becomes `LEAST(now() + 24 h, created_at + 7 days)`. This write is the sliding refresh, so a session costs at most one write a minute. When two requests race, one `UPDATE` matches and sets the cookie (with `Max-Age` = seconds left until the cap); the other matches nothing and is served without a new cookie.
- **Reuse detection.** The previous token is served (no write, no cookie) for 30 s after the rotation. Presented later, it means two parties hold the session: `revokeAllUserSessions` deletes every session of the user and the guard logs `Session token reuse detected: all sessions of the user revoked`. Every replaced hash is also written to `session_token_history` (in the rotation's transaction) and kept until the session ends, so a token two or more rotations old is recognized as reuse too (`findSessionBySupersededToken`, only for unexpired sessions), in the guard and also on the login and logout pages. A lost response (the new cookie never reached the browser) looks like reuse and signs the user out: a rare false positive, accepted for the detection.
- **Revoke.** Logout deletes the row (matching the current or the previous hash). Owner setup completion and `reset-owner` delete every session of the owner under the owner lock. `revokeAllUserSessions(userId, executor?)` is also the hook for deactivation (#218), a completed password reset (#277) and a password change (#279); the `credential_id` cascade (#277) is a second, independent path for sessions bound to a replaced credential. Independently, the lookup and the login reject a disabled user, so leftover rows grant nothing, and `ON DELETE CASCADE` removes the rows of a deleted user.
- **Account fields.** The same row returns the account's email and role and the session's assurance (#222), narrowed with `isUserRole` / `isSessionAssurance` (an unknown value, impossible while the `CHECK` constraints hold, counts as no session). The dashboard builds its `auth` context from it, so a request costs exactly one session query and a role change applies on the next request.
- **Sweep.** The purge worker (`runSessionSweep` in `src/modules/trash/services/purge.service.ts`) calls `purgeExpiredSessions()` on boot and every 6 hours and logs `Expired session sweep completed` with `deleted`. Housekeeping only: the guard enforces expiry itself. In the same cycle `runDeviceSweep` deletes the `user_devices` rows not seen for 400 days (#282, `Stale sign-in device sweep completed`).

**Login without account enumeration.** `verifyPasswordLogin` runs exactly one argon2id verify on every branch: an unknown email or a user without a password is verified against a dummy hash made once per process by the same `hashPassword` (so the cost parameters match), and a disabled user verifies the real hash and then fails. Every failure reason (`unknown`, `no_password`, `disabled`, `bad_password`, plus `too_long` decided in the route before any lookup) gets the same response. On success `user_credentials.last_used_at` is updated. The first unknown-email login of a process also creates the dummy hash, one extra argon2id hash; that slower response happens once per process.

No JavaScript secret comparison is left on these paths: the presented token is hashed and looked up through a unique index, and argon2id verification is constant-time inside Bun. That is why the pre-#216 `crypto.timingSafeEqual` check (and its spy test) is gone.

## Invitations (#217)

Every account other than the owner arrives by invitation. An admin or the owner opens **Invitations** in the dashboard (`/dashboard/invitations`, linked from the dashboard home for admins and the owner), enters an address and a role, and BunMail emails a one-time accept link or, when it cannot, shows the link once for the inviter to share.

**Who may invite whom.** The owner invites admins and members; an admin invites members; a member invites nobody; nobody invites an owner. `canGrantRole(actorRole, role)` decides it in the service from the signed-in account's role (`auth.user.role`, read with the session on every request), so a crafted form (`role=owner`, or an admin posting `role=admin`) is refused with `403` and logged (`Invitation refused`, `reason: role_not_allowed`); the routes carry `adminGuard` as well. The same rule covers revoke and resend: an admin cannot revoke or resend an admin invitation (the page shows "Owner only" for those rows). The database's `user_tokens_invite_check` refuses an owner invitation even from a bug.

**Creating.** The address is trimmed, lower-cased and checked with `isEmailAddress`; control and format characters (Unicode `Cc`, `Cf`: bidi overrides, zero-width) are refused in the invite policy. An address that already has an account (enabled or not) is refused (`account_exists`). Under `pg_advisory_xact_lock(hashtext('bunmail:invite:' || email))`, a live invitation for the address whose role the actor cannot grant (an owner's admin invitation, seen by an admin) is never replaced or downgraded: the request is refused (`pending_higher_role`) and nothing changes. Otherwise, in the same transaction, every open invitation for the address is revoked and a new `user_tokens` row is inserted (`purpose = 'invite'`, `email`, `role`, `invited_by` = the inviter, only `hashToken(token)` stored, `expires_at` = `now() + interval 'N days'` on the database clock with N = `INVITE_EXPIRY_DAYS`, default 7, at most 90, inlined as a literal and read back with `RETURNING` for the email and the page). Re-inviting a pending address therefore replaces its link, and concurrent invitations of one address leave exactly one live link. Logged at `info` as `Invitation created` (`invitationId`, `invitedBy`, `role`, `email` through `redactEmail`, `replaced`, `expiresAt`).

**The email.** After commit, `sendInviteEmail` sends `You're invited to BunMail` from `SYSTEM_MAIL_FROM` with `sendMail` (out of band, no `emails` row), DKIM-signed with that domain's key (`resolveDomainDkim`, shared with inbound notifications). Plain text and simple escaped HTML: the inviter's name (or email), the role, the expiry and the accept link `<APP_BASE_URL or http://localhost:PORT>/dashboard/invite?token=...`, the only link (no tracking). It is sent only when `SYSTEM_MAIL_FROM` is set, its domain is registered in BunMail with `dkim_verified`, and the key decrypts; it counts as sent when an MX group reached `sent`. Logged as `Invitation email sent` (`info`) or `Invitation email not sent` (`warn`, with `reason`: `not_configured`, `sender_unavailable`, `send_failed` or `no_base_url`; a thrown error is logged as a fixed message with its `errorName` and, for a users-store error, its `sqlState`, never its raw message, and the domain lookup runs through `withSanitizedErrors`). An unsent email never fails the invitation: the link is stashed in the one-time reveal store (kind `invite_link`, bound to the inviter's user and session, 60 seconds, #280) and the Invitations page shows it once, with a flash saying why the email was not sent. The link never appears in a URL, a flash message or a log. When `APP_BASE_URL` is unset or not an `http(s)://` URL the link falls back to `http://localhost:PORT`, which is useless to an invitee: it is never emailed, and the inviter gets it once with the reason `APP_BASE_URL is not set, so no usable link could be emailed` (`reason: no_base_url`).

**Revoke and resend.** Revoke sets `revoked_at` on a pending invitation (conditional on it still being open). Resend, under the address lock, revokes the pending invitation and mints a new one for the same address and role (`invited_by` becomes whoever resent it), then sends or reveals it like a new one. Logged as `Invitation revoked` / `Invitation resent` (`previousInvitationId`).

**Accepting.** `GET /dashboard/invite?token=` and `POST /dashboard/invite` are public routes registered before the session guard, mirroring owner setup: auth-page headers (`no-store`, `Referrer-Policy: strict-origin`, `nosniff`, `DENY`), same-origin first on the POST, then the token shape, an indexed lookup, the policy (name 1 to 100 characters with no control or format characters; password 15 to 256 characters and confirmed, the owner setup policy), and only then argon2id. An invitation counts as live only while its inviter still could send it: `invited_by` must name an existing, enabled account whose current role grants the invitation's role (the owner any, an admin `member`), so an invitation from a deleted (`invited_by` NULL), disabled or demoted inviter is dead. Every dead link (missing, malformed, unknown, expired, used, revoked, inviter no longer allowed) gets the same `400` page; `GET` never spends the token. In one transaction under the address lock: refuse when an account took the address meanwhile (`409` page, the open invitations revoked); spend the token with a conditional `UPDATE ... SET used_at = now()` on the live predicate (database clock) plus the inviter re-check, so an inviter disabled or demoted after the form was opened still makes the spend fail; insert the user with the invited role and name; insert the `password` credential (hashed before the transaction); revoke every other open invitation for the address; open the session. A unique violation on `users.email` from a writer outside the lock is reported as `account_exists` too. The route then revokes the session the browser presented, if any (like login), sets the new cookie and redirects to `/dashboard`. Logged at `warn` as `Invitation accepted` (`invitationId`, `userId`, `invitedBy`, `role`, redacted `email`, `sessionId`, `ip`). `email_verified_at` stays null: a hand-shared link proves nothing about the mailbox.

## Account management (#218)

Admins and the owner open **Users** (`/dashboard/users`, in the sidebar for admins and the owner): every account with its name, email, role, status (active or disabled) and creation date, the viewer's own row marked, and a link to Invitations. Each row shows only the buttons the viewer may use (`allowedAccountActions`); every action route checks the rules again in `user-admin.service.ts`.

| Action | Owner | Admin | Member |
|---|---|---|---|
| Change role (member to admin or back; never to or from owner) | any non-owner | no | no |
| Deactivate / reactivate | any non-owner | members only | no |
| Remove (confirmed by typing the account's email, trimmed, case-insensitive) | any non-owner | members only | no |
| Transfer ownership (to an active admin, confirmed with the owner's current password) | yes | no | no |
| Reset password: issue a one-time link (#277; not for a deactivated account) | any non-owner | members only | no |

Nobody acts on their own account, and the owner is never demoted, deactivated, removed or given a reset link (ownership moves only by transfer; the owner's password is reset with `reset-owner`). Deactivate, reactivate, remove and reset password follow the invitation rule: an account manages the roles it could invite (`grantableRoles`).

**Live rules, one at a time.** Every action runs in one transaction under the `bunmail:owner` advisory lock (`withOwnerLock`, shared with the owner setup), reads the actor's and the target's rows with `FOR NO KEY UPDATE`, and checks the rules against those live rows, never against the role the request's session carried. Two admins acting at once, or two transfers racing, are applied one after the other: the second sees what the first committed (a deactivated actor gets `actor_inactive`, a former owner `role_not_allowed`, an already disabled target `unchanged`).

**Side effects, in the same transaction.**

- Deactivate: `disabled_at` set, every session deleted (`revokeAllUserSessions`: the account's cookie gets a `302` to the login page on its next request), the open invitations it issued revoked, the open password reset links for it and those it issued revoked (#277), so reactivating it revives none of them, and every active API key it created disabled (`is_active = false`, `disabled_reason = 'creator_deactivated'`, #219). Reactivate clears `disabled_at` and deletes every session of the account again, so a session created by a login that raced the deactivation can never come back to life; the revoked invitations stay revoked and the disabled keys stay disabled (#219: a deactivation usually means a leaver or a suspected compromise; the user creates new keys).
- Admin to member: the open invitations and password reset links the account issued are revoked (a member can grant or manage nothing), and every admin API key it created becomes restricted (`is_admin = false`, #219; the keys stay active for sending; logged as `adminKeysDowngraded`). Member to admin: the account's own open reset links are revoked (#277), so one issued while it was a member cannot come back to life after a demotion within the hour. The new role applies on its next request, since the session guard reads the role every time; sessions are kept.
- Remove: the open invitations it issued are revoked, its sessions deleted and its active API keys disabled (`creator_removed`, #219), then the row is deleted: `user_credentials`, `sessions` and its own `user_tokens` cascade, and `invited_by` on its past invitations and `created_by_user_id` on its keys, templates, domains and webhooks become `NULL` (they belong to the owner from then on; the next boot records that). The keys are disabled first, so a NULL creator never means a live key of a removed user.
- Transfer: the owner is demoted to `admin` first, then the target promoted to `owner`, so `users_single_owner` holds at every statement; the previous owner's open `admin` invitations are revoked (an admin cannot grant admin), its `member` invitations stay, every open owner setup link is revoked (a `reset-owner` link minted for the previous owner would otherwise come back to life if ownership ever returned to it), and so are the open password reset links the previous owner issued for admins and every open reset link of the new owner, whoever issued it (#277; revoked before the role changes; they would otherwise come back to life if ownership returned within the hour). Both accounts stay signed in. The password is checked with `verifyPassword` against the owner's `password` credential, after the rules (a refused request never reaches argon2id) and outside the lock; a wrong password changes nothing. The check is throttled with the login limiter's settings (`DASHBOARD_LOGIN_RATE_LIMIT_*`) under keys of its own, `transfer:user:<actorId>` and `transfer:ip:<client IP>`: over budget, the request is refused (`rate_limited`) before any argon2id work; otherwise the attempt is counted right away, before the verify, so a parallel burst cannot run more verifies than the budget; a completed transfer clears both keys. The route builds the budget (`AttemptLimiter`) and passes it to the service. The previous owner's templates, domains and webhooks, and every such row with no creator, move to the new owner (`moveOwnerRecords`, #219). API keys never move: they stay attributed to the account that created them, so demoting, deactivating or removing the former owner later still reaches its admin keys. After a transfer, update `BUNMAIL_OWNER_EMAIL` to the new owner's address, or the boot logs the `differs from the stored owner` warning (it never changes anything).

Revoking those invitations is housekeeping: acceptance re-checks that the inviter is enabled and may still grant the role (#217), so an invitation issued in a race is dead anyway.

**Refusals.** `AccountRefusal`: `actor_inactive`, `not_found`, `self`, `target_is_owner`, `role_not_allowed`, `invalid_role`, `unchanged`, `confirm_mismatch`, `wrong_password`, `not_eligible`, `rate_limited`, `account_disabled` (#277). Those no button leads to (`actor_inactive`, `self`, `target_is_owner`, `role_not_allowed`, `invalid_role`) get the `403` page; the others go back to the Users page with an error flash.

**Logs.** One line per action, after the transaction: `info` `Account role changed` / `Account deactivated` / `Account reactivated` / `Account removed` / `Ownership transferred` / `Password reset link issued` with `action`, `actorId`, `actorRole`, `targetUserId`, the old and new role or status (`oldRole`, `newRole`, `oldStatus`, `newStatus`, `previousOwnerRole`), the counts (`sessionsRevoked`, `invitesRevoked`, `setupLinksRevoked`, `resetLinksRevoked`, and since #219 `keysDisabled` for a deactivation or removal, `adminKeysDowngraded` for a demotion and `recordsMoved: { templates, domains, webhooks }` for a transfer) and, for a reset link, `resetId` and `expiresAt` (never the token); a removal adds the email through `redactEmail`. A refusal (including a wrong password and an exhausted transfer budget) is `warn` `Account action refused` with `action`, `actorId`, `targetUserId`, `reason` and the roles. Never a password.

## Record ownership (#219)

`api_keys`, `templates`, `domains` and `webhooks` carry a nullable `created_by_user_id` (FK `users(id)` ON DELETE SET NULL, indexed). The rule everywhere: **a row with no creator belongs to the owner.**

- **Recorded on create:** a dashboard create records the signed-in user; a REST create records the calling key's `created_by_user_id` (NULL stays NULL).
- **Permissions:** a member sees and manages only its own API keys (always restricted) and edits and deletes only its own templates; admins and the owner act on all of them. Domains and webhooks carry the creator for attribution only: who may manage them stays role-based. See [api-keys.md](api-keys.md#keys-belong-to-users-219) and [templates.md](templates.md#dashboard-permissions-219).
- **Lifecycle:** the owner bootstrap assigns NULL rows to the owner on every boot; deactivation and removal disable the user's keys, demotion restricts its admin keys; a transfer moves the old owner's templates, domains and webhooks, never its keys (see above).
- **Upgrade note:** keys created before #219 are attributed to the owner. After inviting other accounts, rotate any admin key that was shared, because account actions only reach the keys an account created.

`record-ownership.service.ts` holds the updates; each takes the caller's transaction, which holds the owner lock, and returns counts for the caller's log line:

- `assignUnownedRecords(tx, ownerId): Promise<RecordCounts>`: NULL creators to the owner (boot backfill).
- `moveOwnerRecords(tx, fromUserId, toUserId): Promise<ContentRecordCounts>`: the old owner's templates, domains and webhooks, and NULL rows of those tables, to the new owner (transfer). API keys are left out on purpose.
- `downgradeAdminKeysCreatedBy(tx, userId): Promise<number>`: demotion to member makes the user's admin keys restricted.
- `disableKeysCreatedBy(tx, userId, reason): Promise<number>`: deactivate the user's active keys with `creator_deactivated` or `creator_removed`; keys already inactive keep their reason.

## Password resets (#277)

An admin or the owner can let a user who forgot their password back in without email: **Reset password** on the Users page (`POST /dashboard/users/:id/reset-password`) issues a one-time link and shows it once to the issuer, who hands it over by a channel of their choice.

**Who may reset whom.** The `reset_password` rule in `accountActionRefusal`, the same "who manages whom" as deactivation: the owner resets admins and members, an admin resets members, a member nobody; nobody resets their own account this way, and nobody resets the owner (the owner uses `bun run src/db/reset-owner.ts`). A deactivated account cannot be reset until it is reactivated (`account_disabled`). The rule runs in `issuePasswordReset` (`user-admin.service.ts`) on the live actor and target rows, under the `bunmail:owner` lock like every account action; a crafted request for an account no button leads to gets the `403` page.

**Issuing.** In the same locked transaction, `replaceResetToken` revokes every open `password_reset` token of the account (one live link per account: a second link kills the first) and inserts a new `user_tokens` row: `purpose = 'password_reset'`, `user_id` = the account, `invited_by` = the issuer (meaning "issued by" for this purpose; no schema change), only `hashToken(token)` stored, `expires_at` = `now() + interval '60 minutes'` on the database clock (`PASSWORD_RESET_TTL_MINUTES`, a code constant, inlined as a literal and read back). After commit the link `<APP_BASE_URL or http://localhost:PORT>/dashboard/reset?token=...` is built and stashed in the one-time reveal store (kind `password_reset_link`, bound to the issuer's user and session, 60 seconds, #280); the redirect carries only the reveal token, and the Users page shows the link once. It is never emailed, and never in a URL of ours, a flash message or a log. A localhost fallback is flagged in the flash and logged (`Password reset link points at localhost`, `warn`, with `resetId` and a `hint`). Issuing touches neither the account's sessions nor its password.

**Completing.** `GET /dashboard/reset?token=` and `POST /dashboard/reset` are public routes registered before the session guard, mirroring the invitation accept page: auth-page headers (`no-store`, `Referrer-Policy: strict-origin`, `nosniff`, `DENY`), same-origin first on the POST, then the token shape, an indexed lookup, the password policy (15 to 256 characters, confirmed: the owner setup policy; a failure re-renders the form without hashing), and only then argon2id (outside the lock). A link counts as usable only while it is open, unexpired on the database clock, its account exists and is enabled, and its issuer exists, is enabled, is not the account, and may still manage the account's current role (`issuerStillManages`, the same table as the Users page rules). Every unusable link gets the same `400` page; `GET` never spends the token. In one transaction under the owner lock: spend the token with a conditional `UPDATE ... SET used_at = now()` on that predicate (an issuer or account changed after the form was opened still makes it fail; of two concurrent submissions one wins), replace the `password` credential (every session bound to the old credential goes with it, by cascade), revoke every other open token of the account, revoke the open invitations and reset links the account **issued** (as deactivation does: whoever held the old password may have issued them; the trade-off is that the account's legitimate pending invitations die too and must be sent again), delete every session of the account, open a new session bound to the new credential, touch `updated_at`. The route then revokes the session the browser presented, if any (like login), sets the cookie and redirects to `/dashboard`. Logged at `warn` as `Password reset completed` (`resetId`, `userId`, `issuedBy`, redacted `email`, `sessionsRevoked`, `tokensRevoked`, `issuedTokensRevoked`, `sessionId`, `ip`); a dead link on the POST is only `debug` `Password reset refused: invalid link` (like the invitation page, so an anonymous flood cannot fill the `warn` log). Never the token, its hash, the link or a password.

**Second factors (#220).** A completed reset also removes the account's TOTP second factor and its recovery codes, in the same transaction (`removeTwoFactor`; the log line carries `twoFactorRemoved`): an admin-issued reset is the recovery path when the authenticator is lost. The session it opens is a `password` session of an account without a second factor; under `REQUIRE_2FA` the user must enrol again before using the dashboard. Issuing a link removes nothing. (This reverses the plan noted before #220, which was to keep the second factor through a reset: then a user who lost the phone and all recovery codes would have no way back in.)

## Password change (#279)

Every signed-in account, the owner included, changes its own password at `/dashboard/account/password` (`GET` renders the form, `POST` changes it; both `memberGuard`, in `src/pages/plugins/account.plugin.tsx`). The user must know the current password; forgotten passwords go through a reset link (#277) or, for the owner, `reset-owner`.

**Order of checks** (`changePassword` in `password-change.service.ts`, called by the route):

1. Same-origin: the session guard refuses a cross-origin `POST` with `403` before the route runs.
2. The failed-attempt budget, built by the route from the login limiter's primitives and settings (`DASHBOARD_LOGIN_RATE_LIMIT_*`, `passwordChangeLimiter`), with keys of its own: `password:user:<userId>` and `password:ip:<client IP>` (`rateLimitBucket`: IPv6 by `/64`). Over budget: `rate_limited` (`429`), before any argon2id work.
3. The policy (`passwordChangeProblem`): current password required; the new one passes the owner setup policy (15 to 256 characters, confirmed) and differs from the current one. A problem is `invalid_input`: no argon2id, not counted.
4. The attempt is counted on both keys, with no await since step 2, so a parallel burst cannot run more verifies than the budget allows. A wrong password does not give it back.
5. Exactly one argon2id verify of the current password against the account's `password` credential, outside any lock. Wrong (or no password credential): `wrong_password`, the generic `Current password is incorrect.`, nothing changes.
6. The new password is hashed, still outside the lock.
7. One transaction under the `bunmail:owner` lock: the account must still exist and be enabled (`account_inactive`); the credential that was verified must still be the same row with the same hash, read `FOR UPDATE` (`credential_changed`); both refusals come before any write. Then every session of the account is deleted (`revokeAllUserSessions`: this browser's, those bound to the old credential, and those bound to nothing or to another credential), the old `password` row is deleted (its `credential_id` cascade is a second path to the sessions bound to it) and a new one inserted, the account's open reset links are revoked (`revokeResetLinks`), a new session bound to the new credential is opened, and `updated_at` is touched. A completed change clears both budget keys.

**Race with an admin-issued reset.** Verifying first and re-checking the credential inside the transaction keeps argon2id out of the owner lock (which every account action, reset and setup takes), and the compare-and-swap closes the window: a reset completed between the verify and the transaction replaced the row, so the change is refused (`409`) and the reset's password stands (its session is the only one left; this browser's was removed by the reset). A reset completed after the change waits on the lock and replaces the new password, as its issuer intended. A deactivation in between is refused the same way.

Only the `password` credential is replaced; the open invitations and reset links the account **issued** are kept (unlike a reset: the user proved knowledge of the current password, so nothing suggests someone else held it). A TOTP second factor (#220) is not touched, and the session opened here carries the assurance of the one the change was made from (an `mfa` session stays `mfa`; `pending` can never change a password).

**Logs.** `warn` `Password changed` with `userId`, the new `sessionId`, `previousSessionId`, `sessionsRevoked`, `resetLinksRevoked` and `ip`; a refusal is `warn` `Password change refused` with `userId`, `sessionId`, `reason` (`rate_limited`, `invalid_input`, `wrong_password`, `account_inactive`, `credential_changed`) and `ip`; an unexpected error is `error` `Password change failed`. Never a password, a hash or a token.

## Active sessions (#281)

Every signed-in account, the owner included, lists and signs out its **own** sessions at `/dashboard/account/sessions` (`memberGuard`, in `src/pages/plugins/account.plugin.tsx`); other accounts' sessions are the Users page's business (deactivation, #218). Route behaviour and log lines: [docs/dashboard.md](dashboard.md#active-sessions-281).

- **List** (`listUserSessions(userId)`): the user's live sessions, most recently active first, with `id`, `ip`, `user_agent`, `location`, `created_at` and `last_seen_at`, never a token hash. "Live" is the guard's own predicate (`liveSession()`, shared with `findActiveSession`): `expires_at > now()` (which carries both the 24 h idle and the 7 d absolute rule) and assurance `mfa`, or `password` while the account has no TOTP second factor (#220). The page marks the row whose id is the request's `auth.session.id` as **This device**, and labels the device with `describeUserAgent` (`user-agent.service.ts`): a small built-in parser, fixed strings only ("Chrome on macOS", "Firefox on Windows", "curl", "Unknown browser").
- **Sign out one** (`revokeUserSession(userId, sessionId)`): `DELETE ... WHERE id = $sessionId AND user_id = $userId`. The ownership check is in the `WHERE`, so another user's id (or an unknown one) deletes nothing and the route answers `404`. Revoking the request's own session signs this browser out (the route clears the cookie).
- **Sign out all others** (`revokeOtherUserSessions(userId, keepSessionId)`): `DELETE ... WHERE user_id = $userId AND id <> $keepSessionId`. Token history rows go with the sessions (`ON DELETE CASCADE`), as for every revoke.

**Approximate location.** Off unless configured (`config.geoip`, read by `readGeoipSettings` in `src/config.ts`): `GEOIP_DB_PATH` (an offline DB-IP Lite or GeoLite2 City/Country `.mmdb` file) wins, else `GEOIP_PROVIDER=ipinfo` with `GEOIP_API_TOKEN`, else off; an unknown provider, a provider without a token or a token without a provider refuses to boot. Setup: [docs/self-hosting.md](self-hosting.md#approximate-session-locations-geoip-281).

- **When.** Once per session, after it is committed: the login handler, and owner setup, invitation acceptance, password reset and password change after their transaction, call `locateSession(sessionId, ip)` (`session-location.service.ts`) without awaiting it. A slow, rate-limited or down source never delays or fails a sign-in. The lookup runs in the request's log context.
- **Lookup** (`lookupLocation(ip)` in `geoip.service.ts`): `null` when off, when there is no IP, or for a private, loopback, link-local or reserved address (`isBlockedIp`, never looked up). Offline: the file is read once into memory at the first lookup (`Bun.file(path).arrayBuffer()`, then `new Reader(buffer)` from `mmdb-lib`) and shared; a missing or corrupt file logs one `warn` (`GeoIP database could not be loaded, session locations off`) and location stays off until the restart. Online: `https://api.ipinfo.io/lite/<ip>?token=...` (the free Lite API, country only), `AbortSignal.timeout(3000)`, redirects refused, the body capped at 16 KiB, the JSON read field by field without casts. Errors never carry the URL (it holds the token).
- **Stored** (`setSessionLocation`) as "City, Country" or "Country" (`formatLocation`: control and format characters dropped, cut to 128 code points; no country, no label). A failed lookup or write logs `warn` `Session location lookup failed` with `sessionId`, `ip` and a sanitized message, and the session keeps a null location.
- **Approximate**: a VPN or proxy shows its own location, and the page says so.

## New-device alerts (#282)

A successful password sign-in from a browser the account has not used in the last 30 days emails the account "New sign-in to your BunMail account". Route behaviour: [docs/dashboard.md](dashboard.md#auth-flow).

**Recognizing a browser.** By a cookie, never by IP (mobile and VPN addresses change all the time). `bm_device` holds 32 random bytes as base64url (`HttpOnly; SameSite=Lax; Path=/dashboard`, `Secure` in production like `bm_session`, `Max-Age` 400 days). `POST /dashboard/login` sets it on every successful sign-in: the value the browser presented when it is well-formed (43 base64url characters, `isWellFormedToken`), otherwise a new one (a missing, malformed or oversized value counts as absent), so the lifetime is refreshed at each sign-in. Logout does not clear it. **It is not a credential**: it opens no page and no session, and nothing but the alert decision reads it. The same value is shared by every account that signs in from that browser, but rows are per account, so a browser one account uses is still new to another. Only its SHA-256 is stored (`user_devices.device_hash`).

**When it alerts** (`device-policy.service.ts`, decided in one statement by `recordSignInDevice`):

- **Known device**: the account has a `user_devices` row for this cookie hash with `last_seen_at` within the last 30 days (`KNOWN_DEVICE_DAYS`). No alert; `last_seen_at`, the label, the IP and the location move forward.
- **New device**: no row for this account and cookie, or one last seen longer ago than 30 days. One alert, and the row is inserted or refreshed.
- **First device**: the account has no `user_devices` row at all (the first password sign-in after owner setup or invitation accept, or the first after upgrading to #282). Recorded **without an alert**: the account's first browser is not a "new device" event. Consequence: on an upgraded instance, each account's first sign-in afterwards is silent.
- **Only a completed sign-in**: `POST /dashboard/login`, or for an account with two-factor authentication `POST /dashboard/login/two-factor` once the code is accepted (#220); the password step of such an account sets no device cookie and sends no alert. Owner setup, invitation accept, password reset and password change never run the check and set no device cookie: they are link or credential flows the user just performed.

The upsert is `INSERT ... ON CONFLICT (user_id, device_hash) DO UPDATE` with a `prior` CTE that reads the table as it was before the statement (whether the account had any device, and whether this one was known or stale) and `xmax = 0` to tell an insert from an update. Two sign-ins racing from the same new browser give one alert (the one that inserted); two racing on the same stale row may both alert.

**When it runs.** After the login response is decided, in the background (`recognizeSignInDevice` in `sign-in-device.service.ts`, not awaited), like the location lookup: it never delays or fails a login. It waits up to 2 s (`LOCATION_WAIT_MS`) for the session's location lookup (`locateSession` now returns the location it stored), then records the device and decides. Any error is logged at `warn` (`New-device sign-in check failed`, with `userId`, `ip`, `errorName` and, for a database error, `sqlState`) and the login is unaffected.

**The email** (`new-device-alert.service.ts`), sent like the invitation email: `sendSystemMail` (`system-mail.service.ts`, now shared by both) sends from `SYSTEM_MAIL_FROM` with `sendMail`, out of band, DKIM-signed with that domain's key, and only when the domain is registered in BunMail with `dkim_verified` and the key decrypts (never unsigned). Plain text and escaped HTML: the account address masked (`m***@example.com`), the device label, the IP (or `unknown`), the approximate location when known (left out otherwise), the time in UTC (`2026-10-18 14:03:27 UTC`), and "If this was you, you can ignore this email. If it wasn't, sign in and use Account > Active sessions > Sign out all other devices, change your password, and tell an administrator." **No links of any kind**: no URL, no token, no button, no tracking. A forwarded or leaked alert cannot act on the account, and users are not trained to click links in security mail.

**Logs.** `info` `New-device sign-in` (`userId`, `deviceId`, `ip`) for every new device, sent or not; `info` `First sign-in device recorded, no alert`; `debug` `Sign-in from a known device`. Then `warn` `New-device sign-in alert sent` (`userId`, `deviceId`, the address through `redactEmail`), `info` `New-device sign-in alert not sent` with `reason: not_configured` when `SYSTEM_MAIL_FROM` is unset, or `warn` `New-device sign-in alert not sent` with `reason` `sender_unavailable` or `send_failed` (thrown errors by name and SQLSTATE only). Never the cookie value or its hash.

**Retention.** A row is deleted with its account (`ON DELETE CASCADE`) and by the purge worker once not seen for 400 days (`DEVICE_RETENTION_DAYS`, the cookie lifetime); that browser is new again at its next sign-in.

## Two-factor authentication (#220)

Time-based one-time passwords (TOTP, RFC 6238 over RFC 4226 HOTP): HMAC-SHA1, 6 digits, 30-second steps, the parameters every authenticator app supports, implemented on Node's `crypto` (`totp.service.ts`, unit-tested against the RFC 4226 Appendix D and RFC 6238 Appendix B vectors). Route behaviour, pages and log lines: [docs/dashboard.md](dashboard.md#two-factor-authentication-220).

**Enrolment** (`/dashboard/account/two-factor`, any role):

- **Re-authentication.** Starting needs the current password (`POST .../start`, field `password`): a stolen session cookie alone must not be able to turn 2FA on, which would sign the real user's other devices out and lock the account behind a code only the thief has. The password change's budget applies (`password:user:<id>`, `password:ip:<bucket>`, the login limiter's settings), checked and counted before exactly one argon2id verify; a wrong password writes nothing. The pending secret is written only after this check, so confirming (which needs it) cannot happen without a start that passed it.
- **Start.** A random 20-byte secret (base32, 32 characters) is encrypted with `encryptSecret` under `DKIM_ENCRYPTION_KEY` and stored on the session that started it (`sessions.totp_pending_secret`), not as a credential. Bound to the session by construction: it survives a restart, works across replicas, and dies with the session (logout, revocation, expiry). The one-time reveal store was not used for it: it is in memory, per process, and lives 60 seconds, too short to scan a code and type the first one. Nor an unconfirmed `user_credentials` row: then every "has 2FA" check would have to remember to skip unconfirmed rows, and one that forgot would lock the user out at the next sign-in. So a `totp` row always means a working second factor.
- **Page.** The secret is decrypted for the page only: a QR code of the `otpauth://totp/BunMail:<email>?secret=...&issuer=BunMail&algorithm=SHA1&digits=6&period=30` URI, drawn as inline SVG on the server (the `uqr` module matrix, turned into a path of integers by `components/qr-code.tsx`), and the secret in groups of four for typing by hand. The URI itself never reaches the HTML, a URL or a log; the page is `no-store`.
- **Confirm.** One transaction, the session row locked: the pending secret must exist and the account must not have a `totp` credential; the code must match (window below; a wrong code keeps the enrolment). Then the `totp` credential is inserted (the same ciphertext as `secret_hash`, the matched step as `counter`, so that code cannot be replayed at the next sign-in), ten recovery codes are inserted (hashes only), every **other** session of the account is deleted (they were opened with the password alone, like a password change #279), this session becomes `mfa` and its pending secret is cleared, and `users.updated_at` is touched. The token is not rotated: the session already had full access. Two confirmations racing from two sessions hit `user_credentials_one_totp_per_user`: the second gets `already_enabled`.
- **Recovery codes** are returned to the route once and shown through the one-time reveal store (kind `recovery_codes`, bound to the user and session, #280); never in a URL, a flash or a log.

**Login state machine.** The `sessions.assurance` column carries it:

| From | Event | To |
|------|-------|----|
| (none) | right password, no `totp` credential | `password` (24 h idle, 7 d cap), as before #220 |
| `password` | the account gets a `totp` credential by any path (a login that checked the password while a confirmation was committing, for example) | no longer admitted: `liveSession()` admits `password` only while the account has no `totp` row, so the guard refuses it and the Active sessions page no longer lists it |
| (none) | right password, `totp` credential | `pending`: `expires_at = now() + 10 min`, cookie `Max-Age=600`, browser sent to `/dashboard/login/two-factor`. The guard never admits it (`liveSession()` only admits `password` and `mfa`), so it opens no protected page, is never rotated, and is not listed on the Active sessions page |
| `pending` | right code (TOTP or recovery) | `mfa`, in the transaction that spends the code: a new token, `previous_token_hash` cleared (no grace, not written to `session_token_history`: the pending token dies at once), `rotated_at`/`last_seen_at` = now, `expires_at` = the normal sliding expiry capped at `created_at + 7 d`; cookie `Max-Age` = what is left of the cap. Then the post-login steps: location lookup (#281), `bm_device` cookie and new-device check (#282) |
| `pending` | wrong code | `pending`, unchanged (until the budget is spent) |
| `pending` | budget spent, logout, 10 minutes, a password reset (the credential cascade) | deleted |
| `password` | 2FA confirmed in this session | `mfa` (other sessions deleted) |
| `password` / `mfa` | password change | a new session with the same assurance |

Rotation and reuse detection (#216) apply unchanged to `password` and `mfa` sessions.

**Verifying a code** (`matchSecondFactor` in `two-factor.service.ts`, always inside a transaction):

- Six digits (spaces ignored): a TOTP code. The secret is decrypted, and the code is compared in constant time (`timingSafeEqual`) with the codes of the current step and one step either side (`TOTP_WINDOW_STEPS = 1`: 90 seconds of tolerance for clock drift and typing), every candidate computed whether or not one already matched. A matching step must be **newer than the stored `counter`**.
- **Replay protection.** The matched step is written with a compare-and-swap in the same transaction: `UPDATE user_credentials SET counter = $step, last_used_at = now() WHERE id = $id AND (counter IS NULL OR counter < $step)`. Zero rows means another request already used this step (or a later one): refused like a wrong code. Of two concurrent submissions of one code, the second waits on the row lock and then matches nothing, so exactly one succeeds. A side effect: after a code of the next step is accepted, the current step's code is refused too.
- Anything else, where recovery codes are allowed (the login step and disabling, not regenerating): a recovery code, normalized (spaces and dashes removed, upper case, exactly 16 base32 characters), hashed and spent with `UPDATE ... SET used_at = now() WHERE user_id = $u AND code_hash = $h AND used_at IS NULL RETURNING`: it works exactly once, also under concurrency.
- The JS clock decides the step (the phone's clock is the reference, not the database's); replicas need NTP like any TOTP server. A stored secret that no longer decrypts (a changed `DKIM_ENCRYPTION_KEY`) makes TOTP checks fail with an error (`503` at login): recovery codes still work, and a reset removes the factor.

**Throttling.** `src/pages/lib/two-factor-limiter.ts` builds the budgets on the login limiter's primitives with fixed numbers: `TWO_FACTOR_MAX_FAILURES` (5) per `TWO_FACTOR_WINDOW_SECONDS` (15 minutes) per key, always on, whatever `DASHBOARD_LOGIN_RATE_LIMIT_*` says (a 6-digit code, three valid at any moment, needs a budget, and a loose login setting must not widen it). Order in the service: `isLimited()` (refused as `rate_limited` before any work), then `record()` on both keys with no await in between, then the check. Two budgets:

- `twoFactorLoginLimiter(userId, ip)`, the second login step only: `totp:user:<userId>` and `totp:ip:<rateLimitBucket(ip)>`. Once spent (now or before) the route deletes the pending session and sends the browser to the login page; the account key stays over budget until the window ends, from any address. A success clears the account key and refunds its own count on the address key (#256). The per-account key is a deliberate lockout: reaching it requires the password, and it is what bounds guessing across many addresses. When the account key runs out, the account is emailed (`login_codes_exhausted`), at most once per account and window (`shouldAlertCodesExhausted`); a block by the shared address key alone emails nobody.
- `twoFactorSessionLimiter(sessionId, ip)`, disabling and regenerating: `totp:session:<sessionId>` and the same address key, never the account key, so a stolen session cannot keep the real user's sign-in blocked. When the session's own key runs out, the route revokes that session (`Two-factor code budget spent in a session: session revoked`).

In memory and per replica, like the login limiter.

**Disable** answers `not_enabled` straight away for an account without a `totp` credential, before the budget and the password, so the form never reveals whether a password is right; otherwise it needs the current password (one argon2id verify, after the budget check) and a code (TOTP or recovery), then deletes the `totp` credential (its recovery codes go by cascade); sessions are kept. **Regenerate** needs a TOTP code (not a recovery code: a leaked recovery code must not mint more), then replaces all ten codes, used or not.

**Lost authenticator.** A recovery code signs in once (`warn` `Recovery code used` with `recoveryCodesLeft`). Without one, `removeTwoFactor(executor, userId)` is the recovery path: it runs inside a **completed** admin-issued password reset (#277, `completePasswordReset`) and a **completed** owner setup link (`completeOwnerSetup`, the link `reset-owner` prints); issuing either link removes nothing, so an abandoned reset does not weaken the account. Both completions already sign every session of the account out. A password change (#279) keeps 2FA; an ownership transfer (#218) keeps both accounts' 2FA; deactivation keeps it; removing an account deletes it by cascade.

**Policy.** `REQUIRE_2FA` (`readRequire2fa` in `config.ts`, `config.dashboard.require2fa`): `none` (default), `owner`, or `admin` (admins and the owner); case-insensitive, anything else refuses to boot. `twoFactorRequired(policy, role)` decides who is covered. The session guard reads `hasTotp` from its single query (`hasTotpCredential`, an `EXISTS` on `user_credentials`); a covered account without a second factor is redirected (`302`) to `/dashboard/account/two-factor` from every protected route except that page and its actions (`isTwoFactorEnrolmentPath`); logout and the assets are public routes. Defaulting to `none` keeps every account working on upgrade; turn it on once the accounts it covers have enrolled, or they will be sent to enrol at their next request (nobody is locked out: they can always enrol). `requireAssurance("mfa")` is not used by any route: the login state machine and this policy are the enforcement, and accounts without a second factor keep `password` sessions.

**Security emails** (`two-factor-alert.service.ts`, sent like the new-device alert: `sendSystemMail`, from `SYSTEM_MAIL_FROM`, DKIM-signed, no links, never awaited on the request path, never throws). Events: `enabled`, `disabled`, `recovery_codes_regenerated`, `removed_by_reset` (a completed reset link or owner setup link removed the factor) and `login_codes_exhausted`. Each says what happened, the masked address, the IP and the time (UTC), and advises changing the password, checking Account > Two-factor and signing out other devices. Logged `warn` `Two-factor security alert sent` (redacted address), or `Two-factor security alert not sent` (`info` when no sender is configured, `warn` with the reason otherwise), with `event` and `userId`.

**Logs.** `info` `Two-factor enrolment started`; `warn` `Two-factor enrolment start refused` (`reason`: `already_enabled`, `rate_limited`, `wrong_password`); `warn` `Two-factor code budget spent in a session: session revoked` (`action`); `warn` `Two-factor authentication enabled` (`userId`, `sessionId`, `sessionsRevoked`, `ip`), `Two-factor enrolment refused` (`reason`), `Two-factor authentication disabled` (`method`), `Two-factor disable refused` (`reason`), `Recovery codes regenerated`, `Recovery codes not regenerated` (`reason`); at login `info` `Dashboard login: password accepted, second factor required`, `info` `Dashboard login successful` (`method`), `warn` `Two-factor sign-in failed: invalid code`, `warn` `Two-factor sign-in blocked: too many attempts, pending session revoked`, `warn` `Recovery code used` (`recoveryCodesLeft`). IDs and reasons only: never a secret, a code, a recovery code, a hash, a token or an `otpauth://` URI.

## Service helpers

`password.service.ts`, `token.service.ts`, `owner-setup-policy.service.ts`, `session-policy.service.ts`, `invite-policy.service.ts`, `user-admin-policy.service.ts`, `password-reset-policy.service.ts`, `password-change-policy.service.ts`, `totp.service.ts`, `recovery-code.service.ts` and `two-factor-policy.service.ts` are pure: no I/O, no config. `owner.service.ts`, `session.service.ts`, `login.service.ts`, `invite.service.ts`, `user-admin.service.ts`, `password-reset.service.ts`, `password-change.service.ts`, `two-factor.service.ts` and `user-device.service.ts` touch the database, all through `withSanitizedErrors`; `record-ownership.service.ts` (#219) only runs inside their owner-locked transactions; `system-mail.service.ts` sends mail, for `invite-email.service.ts` and `new-device-alert.service.ts`. `device-policy.service.ts` is pure too.

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
- `buildDashboardUrl(appBaseUrl, port, path): { url, usedFallback }`: uses `APP_BASE_URL` (trimmed, trailing slashes stripped) when it starts with `http://` or `https://`, otherwise `http://localhost:PORT` (and `usedFallback` lets the caller add a hint to set `APP_BASE_URL`). Shared by the setup and invitation links.
- `buildSetupUrl(appBaseUrl, port, token): { url, usedFallback }`: `buildDashboardUrl` for `/dashboard/setup?token=...`.

### invite-policy.service.ts

- `grantableRoles(actorRole)` and `canGrantRole(actorRole, role)`: owner grants `admin` and `member`, admin grants `member`, member nothing; never `owner`.
- `normalizeInviteEmail(email)` (trimmed, lower-cased) and `isInvitableEmail(email)` (`isEmailAddress`, plus no `Cc`/`Cf` characters).
- `INVITE_NAME_MAX_LENGTH` (100) and `inviteNameProblem(name)`: 1 to 100 code points, no control or format characters (`Cc`, `Cf`); the message never echoes the input.
- `buildInviteUrl(appBaseUrl, port, token)`: `buildDashboardUrl` for `/dashboard/invite?token=...`.

### system-mail.service.ts

- `sendSystemMail({ to, subject, text, html }, deps): Promise<SystemMailResult>`: the system sender decision (`SYSTEM_MAIL_FROM` set, its domain registered and DKIM-verified, the key decrypts), then `sendMail` with a fresh Message-ID on `MAIL_HOSTNAME`; `{ sent: true, domain }` when an MX group reached `sent`, else `{ sent: false, reason, detail }` (`not_configured`, `sender_unavailable`, `send_failed`; `detail` is safe to log). Never throws, never logs: the caller logs with its own ids.
- `systemMailDeps()`: the real `deps` (`from`, `findDomain`, `resolveDkim`, `send`, `hostname`); the unit tests inject fakes.
- `escapeHtml(value)`, `oneLine(value)`: the escaping shared by both emails.

### invite-email.service.ts

- `buildInviteEmail({ url, inviter, role, expiresAt }): { subject, text, html }`: pure; every dynamic value escaped in the HTML part and flattened to one line in the text part; exactly one link.
- `sendInviteEmail(input, deps?): Promise<InviteMailOutcome>`: `sendSystemMail` plus the log lines above; never throws. `deps` (`InviteMailDeps`, the same as `SystemMailDeps`) defaults to `systemMailDeps()` and is injected by the unit tests.

### invite.service.ts

Every write for an address runs in a transaction under its `bunmail:invite:<email>` advisory lock. Never logs a token, its hash or the link.

- `createInvitation(actor, email, role, client?): Promise<IssueInvitationResult>`: checks, replaces the address's open invitations (never a higher-role one), sends or reports the email. `{ ok: true, invitation, url, delivery }` or `{ ok: false, reason }`.
- `resendInvitation(actor, id, client?)`, `revokeInvitation(actor, id, client?)`: as above, for a pending invitation of a role the actor may grant. Creating, resending, revoking and accepting write their audit event (#221) in the same transaction.
- `revokeInvitesIssuedBy(executor, inviterId, role?): Promise<number>`: revokes the open invitations an account issued (only those granting `role` when given); shared by account management and a completed password reset (#277).
- `listPendingInvitations(): Promise<PendingInvitation[]>`: open and unexpired, newest first, with the inviter's name or email.
- `findLiveInvitation(token): Promise<InviteTarget | null>`: read-only lookup for the accept form (live, and the inviter re-check).
- `acceptInvitation(token, { name, password }, client?): Promise<AcceptInvitationResult>`: the acceptance transaction above.

### user-admin-policy.service.ts

- `accountActionRefusal(action, actor, target): AccountRefusal | null`: the table above (who acts on whom, plus `unchanged`, `not_eligible` and `account_disabled` from the target's state); the action's own input is checked by the service.
- `allowedAccountActions(actor, target): AccountAction[]`: the buttons the Users page shows.
- `removalConfirmed(confirm, email)`: trimmed, lower-cased equality.

### user-admin.service.ts

Every action runs under the `bunmail:owner` lock with both rows locked; logs every outcome.

- `listAccounts(): Promise<AccountSummary[]>`: every account, oldest first.
- `changeAccountRole(actorId, targetId, role, client?)`, `deactivateAccount(actorId, targetId, client?)`, `reactivateAccount(actorId, targetId, client?)`, `removeAccount(actorId, targetId, confirm, client?)`, `transferOwnership(actorId, targetId, password, limiter, client?)`: `Promise<AccountActionResult>` (`{ ok: true }` or `{ ok: false, reason }`). An applied action is written to the audit log (#221) in its own transaction; `client` (`{ ip, userAgent }`) is the request's, null fields when omitted.
- `issuePasswordReset(actorId, targetId, client?): Promise<IssuePasswordResetResult>` (#277): the rules, then `replaceResetToken`, in one locked transaction; returns the link for the one-time reveal.

### password-reset-policy.service.ts

- `PASSWORD_RESET_TTL_MINUTES` (60): lifetime of a reset link (a code constant, no env var).
- `buildPasswordResetUrl(appBaseUrl, port, token)`: `buildDashboardUrl` for `/dashboard/reset?token=...`.

### password-reset.service.ts

Never logs a token, its hash, the link or a password.

- `replaceResetToken(tx, userId, issuerId): Promise<IssuedPasswordReset>`: revokes the account's open reset links and mints a new one; the caller holds the owner lock.
- `revokeResetLinks(executor, { userId } | { issuedBy, targetRole? }): Promise<number>`: housekeeping for deactivation, role changes, ownership transfer and a completed reset (`targetRole` limits it to links for accounts of that role).
- `findLivePasswordReset(token): Promise<PasswordResetTarget | null>`: read-only lookup for the reset form (usable, with the issuer and account re-checks).
- `completePasswordReset(token, password, client?): Promise<CompletePasswordResetResult>`: the completion transaction above.

### password-change-policy.service.ts

- `passwordChangeProblem(current, password, confirm): string | null` (#279): the form message (current password required, the setup policy, different from the current one), never echoing the input.

### password-change.service.ts

- `changePassword({ userId, current, password, confirm }, limiter, client?): Promise<ChangePasswordResult>` (#279): the order of checks and the transaction above; `{ ok: true, sessionsRevoked, resetLinksRevoked, sessionId, sessionToken }` or `{ ok: false, reason }` (`PasswordChangeRefusal`; `invalid_input` carries `problem`). Never logs.

### owner.service.ts

Every write runs in a transaction under the `bunmail:owner` advisory lock (`withOwnerLock`, also used by account management). Never logs the token or its hash.

- `bootstrapOwner(ownerEmail, now?): Promise<OwnerBootstrapResult>`: the state machine above, then the legacy-record backfill (#219) in the same transaction; the result is a discriminated union on `kind` (`created` / `reissued` carry the token, email and expiry for the caller to log).
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
- `findActiveSession(token): Promise<ActiveSession | null>`: the guard's single lookup described above. `ActiveSession` is `{ sessionId, userId, email, role, assurance, matched, rotationDue, graceOver }`.
- `rotateSession(sessionId, presentedToken): Promise<RotatedSession | null>`: the conditional rotation; `null` when another request rotated first.
- `revokeSessionByToken(token): Promise<{ sessionId, userId } | null>`: deletes the session whose current or previous hash matches; returns its `ses_` id and its user (for the audit log, #221).
- `revokeAllUserSessions(userId, executor?): Promise<number>`: deletes every session of a user.
- `purgeExpiredSessions(): Promise<number>`: deletes expired rows.
- `listUserSessions(userId): Promise<UserSessionSummary[]>`, `revokeUserSession(userId, sessionId): Promise<boolean>`, `revokeOtherUserSessions(userId, keepSessionId): Promise<number>`, `setSessionLocation(sessionId, location): Promise<void>`: the Active sessions page (#281), described above.
- `findPendingSession(token): Promise<PendingSession | null>`, `lockPendingSession(tx, sessionId, token): Promise<boolean>` (`FOR UPDATE`), `elevatePendingSession(tx, sessionId): Promise<RotatedSession>`, `setTotpPendingSecret(userId, sessionId, encrypted | null)`, `totpPendingSecretOf(executor, userId, sessionId, forUpdate?)`, `markSessionMfa(tx, sessionId)`: the two-factor steps (#220), described above. `createSession` gives a `pending` session the 10-minute expiry (`SESSION_PENDING_SECONDS`), and `findActiveSession` returns `hasTotp`.

### session-location.service.ts, geoip.service.ts, user-agent.service.ts (#281)

- `locateSession(sessionId, ip): Promise<string | null>`: the background lookup and write; never rejects; resolves to the location stored, or `null` (the new-device check waits on it, #282).
- `lookupLocation(ip, settings?)`, `loadMmdbLookup(path)`, `fetchIpinfoLocation(ip, token, fetch?)`, `formatLocation(city, country)`, `locationFromMmdbRecord(record)`, `locationFromIpinfo(body)`: the GeoIP sources and the label.
- `describeUserAgent(userAgent): string`: the device label (pure).

### device-policy.service.ts, user-device.service.ts, sign-in-device.service.ts, new-device-alert.service.ts (#282)

- `KNOWN_DEVICE_DAYS` (30), `DEVICE_RETENTION_DAYS` (400), `DEVICE_COOKIE_MAX_AGE_SECONDS` (400 days); `classifySignInDevice(facts): "first" | "known" | "new"` (pure).
- `recordSignInDevice({ userId, deviceToken, label, ip, location }): Promise<{ deviceId, kind }>`: the one-statement upsert above; `purgeStaleUserDevices(): Promise<number>`: the 400-day sweep.
- `recognizeSignInDevice(event): Promise<void>`: the background check of a login (location wait, record, alert); never rejects.
- `buildNewDeviceAlertEmail(input): { subject, text, html }` (pure, no links), `formatAlertTime(at)`, `sendNewDeviceAlert(input, deps?): Promise<NewDeviceAlertOutcome>` (never throws, logs as above).

### totp.service.ts, recovery-code.service.ts, two-factor-policy.service.ts (#220, pure)

- `hotp(key, counter, digits?)`, `totpStep(nowMs)`, `totpCode(key, step, digits?)`: RFC 4226 / RFC 6238.
- `matchTotpStep(key, code, nowMs, lastStep): number | null`: the step a code belongs to within one step of now and newer than `lastStep`, every candidate compared in constant time (`codesEqual`); `looksLikeTotpCode(input)`.
- `base32Encode(bytes)`, `base32Decode(text)` (RFC 4648, no padding, strict), `generateTotpSecret()` (20 random bytes), `otpauthUri(secret, account, issuer?)`, `formatSecretForDisplay(secret)`; constants `TOTP_DIGITS`, `TOTP_STEP_SECONDS`, `TOTP_WINDOW_STEPS`, `TOTP_SECRET_BYTES`, `TOTP_ISSUER`.
- `RECOVERY_CODE_COUNT` (10), `generateRecoveryCode()` / `generateRecoveryCodes()`, `normalizeRecoveryCode(input)`, `hashRecoveryCode(normalized)` (SHA-256 hex).
- `twoFactorRequired(policy, role)`, `isTwoFactorEnrolmentPath(path)`, `TWO_FACTOR_PAGE`, `TWO_FACTOR_LOGIN_PAGE`.

### two-factor-alert.service.ts (#220)

- `buildTwoFactorAlertEmail({ event, email, ip, at })`: pure, no links, values escaped. `sendTwoFactorAlert(input, deps?)`: never throws, logs as above.

### two-factor.service.ts (#220)

Never logs; database errors leave it as `UserStoreError`.

- `twoFactorStatus(userId): Promise<TwoFactorStatus>`.
- `startEnrolment(userId, sessionId, password, limiter)` (re-authentication first), `pendingEnrolment(userId, sessionId, account): Promise<PendingEnrolment | null>`, `confirmEnrolment(userId, sessionId, code, client?, nowMs?): Promise<ConfirmEnrolmentResult>`.
- `completeTwoFactorLogin(pending, presentedToken, code, limiter, nowMs?): Promise<TwoFactorLoginResult>`: the budget, then one transaction locking the pending session, spending the code and elevating the session.
- `disableTwoFactor(userId, password, code, limiter, client?, nowMs?)`, `regenerateRecoveryCodes(userId, code, limiter, client?, nowMs?)`. Enabling, disabling and regenerating write their audit event (#221) in the change's transaction.
- `removeTwoFactor(executor, userId): Promise<boolean>`: inside a completed reset or owner setup.

### login.service.ts

- `verifyPasswordLogin(email, password): Promise<LoginResult>`: the password step described above; `{ ok: true, userId, assurance }` or `{ ok: false, reason }`.

## Roles enforcement (#222)

Three roles, ranked owner > admin > member. The dashboard session guard (`src/pages/lib/session-guard.ts`, mounted by `src/pages/pages.plugin.tsx`) exposes the signed-in account to every protected handler as `auth: DashboardAuth` (`{ user: { id, email, role }, session: { id, assurance } }`, type in `user.types.ts`), and each route carries one check from `src/pages/guards.tsx`:

| Role | Can do |
|---|---|
| `member` | Read the dashboard (emails, inbound, logs and stats, the view pages of domains, webhooks, DMARC reports and suppressions), send email with its own API keys, restore single messages from trash, view and create templates, edit and delete the templates it created, manage its own restricted API keys (#219), change its own password (#279) |
| `admin` | Everything a member can, plus inviting members (#217), deactivating, reactivating and removing members (#218), issuing password reset links for members (#277), every API key (and the admin toggle), every domain, webhook and suppression change, edit and delete of any template, trash (single and bulk, since trash is purged after `TRASH_RETENTION_DAYS`), bulk and permanent deletes, empty trash |
| `owner` | Everything an admin can, plus inviting admins (#217), changing roles, deactivating, reactivating and removing admins, transferring ownership (#218), and issuing password reset links for admins (#277). No route carries `ownerGuard`: these owner-only rules are checked inside the invitation and account services, against the live role |

A role too low gets `403` and a `warn` log line with IDs only. The full route table and the 403 behaviour are in [docs/dashboard.md](dashboard.md#roles-222). The REST API does not use these roles: it authorizes API keys (`is_admin`, `allowed_senders`).

## Migration

`drizzle/0016_*.sql` creates the four tables, applied automatically on boot by the runner. The `CHECK` lists are rendered as quoted literals via `sql.raw` (code constants): bound parameters are not valid in DDL, and drizzle-kit would otherwise emit `$1, $2` placeholders into the migration.

`drizzle/0017_*.sql` (#216) adds the nullable `sessions.previous_token_hash` and `sessions.rotated_at` columns, the `sessions_previous_token_hash_idx` index, and the `session_token_history` table (`token_hash` PK, `session_id` FK `sessions` ON DELETE CASCADE, `superseded_at`, index on `session_id`). No backfill: existing rows simply have not rotated yet.

`drizzle/0018_*.sql` (#217) adds `user_tokens_invite_check`: `purpose <> 'invite' OR (email IS NOT NULL AND role IS NOT NULL AND role IN ('admin', 'member'))`. No invitation rows existed before, so nothing can violate it.

`drizzle/0019_*.sql` (#277) adds the nullable `sessions.credential_id` (FK `user_credentials(id)` ON DELETE CASCADE) and `sessions_credential_id_idx`. No backfill: existing sessions keep `NULL` (not bound) and age out within the 7-day cap; every session opened afterwards is bound.

`drizzle/0020_*.sql` (#219) adds the nullable `created_by_user_id` (FK `users(id)` ON DELETE SET NULL, with an index) to `api_keys`, `templates`, `domains` and `webhooks`, and `api_keys.disabled_reason` with `api_keys_disabled_reason_check` (`NULL` or `revoked`, `creator_deactivated`, `creator_removed`). No backfill in SQL: the owner bootstrap assigns the NULL rows at boot (see [Owner bootstrap](#owner-bootstrap-215)).

`drizzle/0025_*.sql` (#281) adds the nullable `sessions.location` (`varchar(128)`). No backfill: existing sessions show no location.

`drizzle/0026_*.sql` (#282) creates `user_devices` (FK `users(id)` ON DELETE CASCADE, the unique `(user_id, device_hash)` index and the `user_id` and `last_seen_at` indexes). Starts empty, so each account's first password sign-in after the upgrade is its silent first device.

`drizzle/0027_*.sql` (#220) creates `user_recovery_codes` (FKs `users(id)` and `user_credentials(id)`, both ON DELETE CASCADE, the unique `(user_id, code_hash)` index and the `credential_id` index), adds the nullable `sessions.totp_pending_secret` (`text`), and adds `user_credentials_one_totp_per_user` (unique on `user_id WHERE type = 'totp'`). No `totp` rows existed before, so nothing can violate it; no backfill, and nobody has a second factor until they enrol.

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
- `test/unit/invite-policy.test.ts`, `test/unit/invite-config.test.ts`, `test/unit/invite-email.test.ts` (#217): the role matrix, address and name rules, expiry and link building; `INVITE_EXPIRY_DAYS` and `SYSTEM_MAIL_FROM` parsing; the email builder (hostile names escaped, exactly one link) and every send outcome with injected dependencies.
- `test/integration/invitations.integration.test.ts` (#217): role rules at the service and over crafted HTTP, the database CHECK, re-invite and concurrent invites leaving one live link, acceptance (account, name, role, password, session, token spent, other links revoked, concurrent acceptances), an address taken meanwhile, every dead link getting the identical `400` without reaching argon2, revoke and resend (admin-only, role-checked), and the email path (with no system sender the link is revealed once, to the inviter's session only; when the email goes out, no reveal).
- `test/unit/dashboard-guards.test.ts`: role ranking, `requireRole` and `requireAssurance` (pass, `403` page, `warn` line), `toDashboardAuth`.
- `test/unit/user-admin-policy.test.ts` (#218): the account action matrix (self, owner target, role, status, transfer eligibility), the buttons per viewer, the removal confirmation, and the request-scoped viewer role (per context, fail closed, never in log fields).
- `test/integration/users-admin.integration.test.ts` (#218): role change, deactivate, reactivate, remove and transfer by the owner, an admin and a member (service and crafted HTTP), self and owner targets refused with nothing changed, sessions and invitations revoked in the same transaction (the deactivated cookie bounces, a demoted admin gets `403` on its next request), FK cascades on removal, exactly one owner after a transfer and after two racing transfers, a wrong password changing nothing, the transfer budget (the try after it never reaches argon2id, a parallel burst runs at most the budget of verifies, success clears it), a racing login's session dying at reactivation, an old owner setup link staying dead after ownership returns, the log lines, and the sidebar per role.
- `test/integration/record-ownership.integration.test.ts` (#219): the boot backfill (once, idempotent, while setup is pending, on the first boot of an upgrade, nothing without an owner row), the creator recorded on dashboard and REST creates, member scoping of the API keys pages and of template edit and delete, keys disabled at deactivation and removal (an API call with one gets `401`, reactivation leaves them disabled, removal disables before the delete clears the creator), a transfer moving the old owner's templates, domains and webhooks but not its keys (which demotion and deactivation of the former owner still reach), promotion refused for a member's or deactivated admin's key, dashboard creates attached to the user's own key, key creation refused for a deactivated creator and decided by the live role, a key of a deactivated creator rejected by the API and SMTP lookup, member-scoped key lists (emails, suppressions, inbound reply, send page) and masked "Created by" emails for members.
- `test/unit/password-reset-policy.test.ts` (#277): the one-hour lifetime and the link builder (fallback, encoding); `test/unit/user-admin-policy.test.ts` covers the `reset_password` rule and `test/unit/pages-render.test.ts` the reset pages and the Users page action and reveal.
- `test/integration/password-reset.integration.test.ts` (#277): who may issue a link for whom (service and crafted HTTP, the owner, self, a member, a disabled account), one live link per account, the one-hour expiry on the database clock, the one-time reveal to the issuing session only, completion (old password fails and new one works through the login service, every session and every other open token revoked, a fresh session, concurrent completions), the browser's own session replaced, the log line without secrets, expired, used, revoked, unknown and malformed links getting the identical `400` without reaching argon2, a cross-origin POST refused, the issuer or the account changed after issuing (disabled, demoted, deleted, promoted beyond reach, deactivated then reactivated, promoted then demoted, an ownership round trip) making the link dead, the tokens the account issued revoked by its reset, and the credential binding of sessions (the cascade, a login racing a reset answered as a failed login, and login, owner setup, invitation acceptance and reset all binding their session).
- `test/unit/password-change-policy.test.ts` (#279): the change form rules (current required, the setup policy, code points, different from the current one, no echo); `test/unit/pages-render.test.ts` the change password page and its sidebar link.
- `test/integration/password-change.integration.test.ts` (#279): the form; a wrong current password (generic error, exactly one verify, nothing changed, counted); the policy before any argon2id and uncounted; a cross-origin `POST` refused; a completed change with two sessions (the other device and the old cookie signed out, a new cookie bound to the new credential, the new password works and the old one does not, the log line without secrets), the owner included; the account's open reset link revoked; a reset or a deactivation between the verify and the change winning; the budget (a `429` before any argon2id, a parallel burst running at most the budget of verifies, the address key across accounts, the account key across addresses, cleared by a completed change).
- `test/unit/user-agent.test.ts` (#281): the device label table (Chrome, Edge, Firefox, Safari, Opera and Samsung Internet on Windows, macOS, Linux, ChromeOS, Android and iOS; curl, Wget, unknown and empty user agents).
- `test/unit/geoip.test.ts` (#281): `readGeoipSettings` (off, file, provider, precedence, every refusal, the token never echoed), the label formatter, the `.mmdb` reader against a tiny database generated in the test (and a missing or corrupt file), private addresses never looked up, and the ipinfo client with a fake `fetch` (URL, timeout, no redirects, non-2xx, oversized, invalid JSON, network errors without the token).
- `test/integration/account-sessions.integration.test.ts` (#281): the list (only the user's own live sessions, expired and `pending` ones never, the current one marked, the location column only when a location is stored, values escaped); signing out one session (own: revoked and its cookie dead; another user's or an unknown id: `404`, nothing changes; the current one: signed out here); signing out all others (exactly the current session kept, other users untouched); cross-origin `POST`s refused; a login storing the location after the background lookup (injected locator), a failing lookup never breaking the login, and nothing stored with location off.
- `test/unit/device-policy.test.ts`, `test/unit/new-device-alert.test.ts` (#282): the first, known and new classification (including a racing insert), the windows; the alert's contents (masked address, device, IP, location left out when unknown, UTC time, the advice), no link or token-like string in either part, hostile values escaped, and every send outcome with injected dependencies and its log line. `test/unit/session.test.ts` covers the `bm_device` helpers and `test/e2e/dashboard.test.ts` the login's cookie and call (kept when well-formed, replaced when malformed or oversized, none on a failed login).
- `test/integration/new-device-alert.integration.test.ts` (#282): the first device recorded without an alert; a new browser, a forged or malformed cookie and a browser another account used each getting exactly one alert; the same browser within 30 days getting none and moving `last_seen_at`, IP and label; 29 days known, 31 days alerting again, also while another browser of the account is recent; the email (sender, DKIM, contents, location, no link, no cookie, token or hash); no `SYSTEM_MAIL_FROM` (no email, the event logged, the login fine); a throwing sender and a failing device check never breaking the login; owner setup, invitation accept, password reset and password change never running the check; the 400-day purge and the cascade on account removal.
- `test/integration/dashboard-route-access.integration.test.ts` (#222): the deny-by-default route table (every plugin route listed with its access level and carrying the matching role guard; no cookie, member, admin and owner requests per route), a role change applying on the next request, `requireAssurance("mfa")` on a test-only route, and one session lookup per request; over the same table (#220), a `pending` session refused on every protected route and `REQUIRE_2FA=admin` sending an admin without a second factor to its Two-factor page from every other route (members unaffected).
- `test/unit/totp.test.ts` (#220): HOTP against RFC 4226 Appendix D, TOTP against RFC 6238 Appendix B (SHA-1, the 8-digit values and their 6-digit tails), the 30-second steps, base32 (RFC 4648 vectors, round trips, strict refusals), the constant-time comparison, the ±1-step window and the replay rule of `matchTotpStep`, the `otpauth://` URI, the grouped secret, and the recovery codes (format, normalization, SHA-256). `test/unit/two-factor-policy.test.ts`: `readRequire2fa` (default, accepted values, refusals), the policy matrix and the enrolment paths. `test/unit/pages-render.test.ts`: the second login step and the Two-factor page (QR code without the URI, grouped key, recovery codes and flash escaped, the sidebar link), and the QR component's markup (integers only, deterministic).
- `test/integration/two-factor.integration.test.ts` (#220, frozen JS clock): enrolment (the pending secret encrypted on the session, the page with a QR code and the key but never the URI; a wrong code refused with the enrolment kept; the right code storing the encrypted secret and the step, ten SHA-256 recovery codes, other sessions of the account signed out and a bystander's kept, this session `mfa`, the codes revealed once and only to that session; start and confirm refused once on); login (a 10-minute pending session, no device cookie or new-device check yet, the second step form, the pending session opening nothing else; a valid code giving an `mfa` session with a new token while the pending token dies, the new-device check run then; replay refused, also for an older step; two racing submissions of one code from two browsers, exactly one winning; two racing submissions on one pending session; ±1 step accepted and ±2 refused; a recovery code working once in any case and spacing, logged with the codes left; the budget revoking the pending session and blocking the account from another address; a parallel burst from many addresses checking at most the budget; the address key across accounts; a success clearing the account key; cross-origin refused; logout ending a pending session); disable (password and code both required; a recovery code accepted) and regenerate (an app code only; every old code replaced); a completed reset link and a completed `reset-owner` link removing the second factor while issuing them does not; a password change keeping it with an `mfa` session; an ownership transfer keeping both; no pending session on the Active sessions page; `REQUIRE_2FA` `none`, `owner` and `admin`; one `totp` row per account and the recovery code cascade. Security review follow-up: start needs the current password (a wrong one writes nothing, confirm then refused, the password change keys counted, the budget refusing before any argon2id); the security emails for turning 2FA on and off, new recovery codes, a reset link and a `reset-owner` link removing it (none for a reset of an account without 2FA), and one sent end to end through the system sender (DKIM, no link); wrong codes in a session never touching the account's login key, the session revoked once its budget is spent (wrong codes, and wrong passwords on the disable form) while the real user still signs in; disable on an account without 2FA answering at once without any password verify; a password session of an account that now has 2FA refused by the guard and missing from the Active sessions list while its `mfa` session works; the 2FA budget staying at 5 with `DASHBOARD_LOGIN_RATE_LIMIT_MAX=100`; the exhausted-budget email sent once per window and only to the account whose own key ran out. `test/unit/two-factor-alert.test.ts`: the email per event (no link, masked address, escaping), sending never throwing, the once-per-window rule, and `readLoginRateLimitNumbers` (defaults, range, refusals).
- `test/integration/dashboard-session.integration.test.ts`: login against real Postgres (only the hash stored, `last_used_at`, distinct cookies, session replacement, one argon2id verify on every failure branch), logout, the guard (expired, disabled user, `pending` assurance, tampered token, old HMAC cookie), rotation (after 60 s, the absolute cap, grace, exactly one winner among concurrent requests), reuse detection (every session of the user revoked; a token two rotations old only rejected) and the service helpers (sweep, per-user revoke, IP cleaning).
- `test/integration/owner-setup.integration.test.ts`: fresh install, restart before setup (including a changed email and `email-taken`), concurrency (parallel bootstraps, parallel completions, bootstrap racing completion, completion and recovery provably waiting on the held owner lock, lock released after commit), expiry, single use and a disabled owner (including one disabled while completion waits on the lock), behaviour after setup, sessions (completion deletes the owner's sessions and opens exactly one; a failed completion leaves them; `issueOwnerSetupLink` signs out only the owner), recovery, and a spawned `reset-owner.ts` smoke test (exit `0` with a live link and the sign-out line, also under `LOG_LEVEL=error`; exit `1` with no owner and no email).
