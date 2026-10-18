# Users Module

Dashboard user accounts (#214): the first piece of the invite-only accounts epic (#225), which replaces the shared `DASHBOARD_PASSWORD` with real accounts, roles and revocable sessions.

#214 shipped the **schema and the pure helpers**. The owner bootstrap (#215) is the first feature that reads and writes these tables: it creates the single owner from `BUNMAIL_OWNER_EMAIL` and lets them set a password through a one-time link (see [Owner bootstrap](#owner-bootstrap-215)). Account login (#216) made that account the dashboard login, with server-side sessions in `sessions` (see [Sessions](#sessions-216)), and removed `DASHBOARD_PASSWORD` and `SESSION_SECRET`. The auth guard (#222) enforces the roles on every dashboard route (see [Roles enforcement](#roles-enforcement-222)). Invitations (#217) are the only way other accounts come to exist (see [Invitations](#invitations-217)). Account management (#218) lets the owner and admins change roles, deactivate, reactivate and remove accounts, and the owner hand over ownership (see [Account management](#account-management-218)).

## Design

- **Identity and credentials are separate.** `users` holds who someone is; `user_credentials` holds one row per way they can log in. A password is the first credential type; TOTP (#220), passkeys (#223) and OAuth/SSO (#224) are further rows with the columns they need already present (`provider`, `provider_account_id`, `public_key`, `counter`, `name`). The `metadata` jsonb column from the original design is deliberately deferred: the bun-sql driver stores jsonb as JSON strings (#261), so it could not be queried until that is fixed; a later type that needs free-form data adds the column once #261 is resolved. TOTP recovery codes (#220) are expected to be stored hashed in `secret_hash` of their own rows, or in a small table of their own if several per user are needed.
- **Sessions carry an assurance level.** `pending` (first factor passed, second required), `password`, `mfa`. The auth guard (#222) can require a minimum per route (`requireAssurance`), so adding 2FA later touches no routes.
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
| credential_id | varchar(36)   | nullable, FK `user_credentials` ON DELETE CASCADE: the credential the session was opened with (#277); null for sessions opened before migration `0019` |
| expires_at   | timestamptz    | NOT NULL: idle timeout, capped at `created_at` + 7 days     |
| last_seen_at | timestamptz    | NOT NULL, default `now()`: moved forward on every rotation |
| ip           | varchar(45)    | nullable: only a valid IPv4/IPv6 literal is stored          |
| user_agent   | varchar(255)   | nullable: writers truncate to 255 (code points)            |
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

## Types

`src/modules/users/types/user.types.ts` exports the value sets as constants and unions: `USER_ROLES` / `UserRole`, `CREDENTIAL_TYPES` / `CredentialType`, `SESSION_ASSURANCES` / `SessionAssurance`, `TOKEN_PURPOSES` / `TokenPurpose`. The same constants render the `CHECK` constraints (`literals()`), and an integration test reads the live constraint definitions back from Postgres and checks every value is present, so a constant changed without `bun run db:generate` fails the test instead of silently diverging.

For the owner bootstrap (#215) it also exports `OwnerSetupLink` (`{ token, email, expiresAt }`: a freshly minted link, the raw token shown once and never stored) and `OwnerBootstrapResult` (the discriminated union `bootstrapOwner` returns, see below).

For invitations (#217): `INVITE_ROLES` / `InviteRole` (`admin`, `member`) with `isInviteRole`, `InviteActor` (`{ id, role }` from `auth`), `InviteRefusal` (`invalid_email`, `role_not_allowed`, `account_exists`, `not_found`), `InviteMailFailure` / `InviteMailOutcome`, `IssuedInvitation` (`{ invitationId, token, email, role, expiresAt, replaced }`, the raw token never stored), `IssueInvitationResult`, `PendingInvitation`, `InviteTarget`, `InviteAcceptance` and `AcceptInvitationResult`.

For password resets (#277): `IssuedPasswordReset` (`{ resetId, token, expiresAt, replaced }`, the raw token never stored), `IssuePasswordResetResult` (`{ ok: true, resetId, url, usedFallback, expiresAt }` or `{ ok: false, reason }`), `PasswordResetTarget` (`{ resetId, userId, email }`) and `CompletePasswordResetResult`; `AccountAction` gains `reset_password` and `AccountRefusal` gains `account_disabled`.

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

**Locking.** Every owner mutation (bootstrap, `reset-owner`, setup completion) runs inside `db.transaction` under `pg_advisory_xact_lock(hashtext('bunmail:owner'))`, distinct from the `bunmail:migrations` lock. Replicas and crash loops therefore serialize: no unique violation on `users_single_owner` reaches the boot, at most one live link exists (each mint revokes every open `owner_setup` token; the schema has no such constraint), and a bootstrap racing a completion cannot leave a live token next to a freshly set password.

**Token lifecycle.** `mintToken()` gives a 256-bit base64url token; only `hashToken(token)` is stored in `user_tokens` (`purpose = 'owner_setup'`, `expires_at` = the app clock + 24 h). The link `<APP_BASE_URL or http://localhost:PORT>/dashboard/setup?token=...` is logged once at `warn` with the message `Owner setup link` and the fields `note`, `url`, `owner` (through `redactEmail`, so masked only when `LOG_REDACT_PII` is on), `expiresAt` and, when the localhost fallback was used, `hint`. It is logged only after the transaction commits, so a rolled-back token is never printed. A token is live while `used_at` and `revoked_at` are null and `expires_at > now()` (checked against the database clock), and its user is the enabled owner. `GET /dashboard/setup` only reads it. `POST /dashboard/setup` spends it with a conditional `UPDATE ... SET used_at = now() ... RETURNING` in the same transaction that replaces the `password` credential and revokes the owner's other open tokens, so two concurrent submissions cannot both win. Owner setup does not set `email_verified_at`: the link arrives through server logs and does not prove control of the mailbox.

**After setup.** The server logs `Owner setup completed` at `warn` with `owner` (through `redactEmail`) and the client `ip`. In the completion transaction (still under the owner lock) every session of the owner is deleted and a new one is created (#216), so no crash can leave an old session alive next to a new password; the route sets its token as the `bm_session` cookie and redirects to `/dashboard`. From then on the owner signs in at `/dashboard/login` with this email and password (see [Sessions](#sessions-216)).

**Recovery.** `src/db/reset-owner.ts` (`bun run src/db/reset-owner.ts`, or `docker compose exec app bun run src/db/reset-owner.ts`) calls `issueOwnerSetupLink` under the same lock and writes straight to stdout (`The owner's dashboard sessions were signed out.`, `Owner setup link for <owner> (single use, expires ...)`, then the URL), not through the logger, so `LOG_LEVEL` cannot hide it: the script revokes every earlier link, so a filtered-out new link would leave none. With an owner, it revokes every open token of that user (any purpose), deletes every session of the owner in the same transaction (#216: an operator who runs it usually suspects a compromise, so it is an immediate kill switch), and mints a fresh `owner_setup` token; the stored email and the current password are kept until the new link is completed, so an abandoned reset cannot lock the owner out (a differing env email only warns). Until then the old password can still sign in; completing the link deletes the owner's sessions again. With no owner and an env email, it creates the owner as bootstrap does. With neither, or when a non-owner account already holds the env email, it logs `Owner reset failed` at `error` and exits 1. It has no HTTP surface: shell access is the trust boundary.

**Database errors.** Drizzle's query errors embed the query parameters (`Failed query: ... params: ...`), which on these paths include the new password hash, setup and session token hashes and account emails. Every query of the users module (`owner.service.ts`, `session.service.ts`, `login.service.ts`) therefore runs through `withSanitizedErrors` (`src/modules/users/errors.ts`), which rethrows a query error as `UserStoreError` (renamed from `OwnerStoreError` in #216), whose message carries only the Postgres SQLSTATE, so the global error handler, the boot step, the dashboard guard and `reset-owner.ts` never log them. Deliberate service errors (for example "No owner account exists ...") pass through unchanged.

## Sessions (#216)

The dashboard login is an account login: email and password against `user_credentials`, then a server-side session row. The cookie (`bm_session`, `HttpOnly; SameSite=Lax; Path=/dashboard`, `Secure` in production) carries an opaque 256-bit token; only its SHA-256 is stored, so a database dump yields no usable cookie, and logs carry the `ses_` id, never the token or its hash. Route-level behaviour (order of checks, status codes, log lines) is in [docs/dashboard.md](dashboard.md#auth-flow).

**Lifetimes** (code constants in `session-policy.service.ts`): idle timeout 24 h (`SESSION_IDLE_SECONDS`), absolute cap 7 days (`SESSION_ABSOLUTE_SECONDS`), rotation after 60 s (`SESSION_ROTATE_SECONDS`), grace for the replaced token 30 s (`SESSION_ROTATION_GRACE_SECONDS`). Every time comparison runs on the database clock (`now()`), so replicas with skewed clocks agree.

**Lifecycle:**

- **Create.** A successful login, or owner setup completion inside its locked transaction (likewise invitation acceptance and password reset completion), inserts a row bound to the credential just checked or written (`credential_id`, #277), with `expires_at = now() + 24 h`, `rotated_at` null and assurance `password` (the login step's `firstFactorAssurance()` is where #220 will return `pending` for users with a second factor). A login first revokes the session the browser presented, if any. The cookie `Max-Age` is the 7-day cap. **Credential binding (#277):** a login verifies the password, then inserts the session naming that credential. If a password reset (or owner setup) replaced the credential in between, the insert fails with a foreign-key violation (`23503`) and the route answers the generic invalid email or password redirect (`Dashboard login failed`, `reason: credential_replaced`; the attempt stays counted, and the IP's failures are cleared only once a session exists), so the old password never opens a session after a reset. Replacing a credential (DELETE and INSERT) also deletes, by cascade, every session bound to the old one.
- **Look up.** The guard hashes the presented token (after a shape check, so malformed and pre-#216 cookies never cost a query) and runs one query matching it against `token_hash` or `previous_token_hash`, joined to `users`: unexpired, user not disabled, assurance `password` or `mfa`. A `pending` session can never open a protected page.
- **Rotate.** When the current token is older than 60 s (`coalesce(rotated_at, created_at)`), the guard mints a new token and runs one conditional `UPDATE ... WHERE id = $id AND token_hash = $presented AND expires_at > now()`: `previous_token_hash` gets the old hash, `token_hash` the new one, `rotated_at` and `last_seen_at` become `now()`, and `expires_at` becomes `LEAST(now() + 24 h, created_at + 7 days)`. This write is the sliding refresh, so a session costs at most one write a minute. When two requests race, one `UPDATE` matches and sets the cookie (with `Max-Age` = seconds left until the cap); the other matches nothing and is served without a new cookie.
- **Reuse detection.** The previous token is served (no write, no cookie) for 30 s after the rotation. Presented later, it means two parties hold the session: `revokeAllUserSessions` deletes every session of the user and the guard logs `Session token reuse detected: all sessions of the user revoked`. Every replaced hash is also written to `session_token_history` (in the rotation's transaction) and kept until the session ends, so a token two or more rotations old is recognized as reuse too (`findSessionBySupersededToken`, only for unexpired sessions), in the guard and also on the login and logout pages. A lost response (the new cookie never reached the browser) looks like reuse and signs the user out: a rare false positive, accepted for the detection.
- **Revoke.** Logout deletes the row (matching the current or the previous hash). Owner setup completion and `reset-owner` delete every session of the owner under the owner lock. `revokeAllUserSessions(userId, executor?)` is also the hook for deactivation (#218) and a completed password reset (#277); the `credential_id` cascade (#277) is a second, independent path for sessions bound to a replaced credential. Independently, the lookup and the login reject a disabled user, so leftover rows grant nothing, and `ON DELETE CASCADE` removes the rows of a deleted user.
- **Account fields.** The same row returns the account's email and role and the session's assurance (#222), narrowed with `isUserRole` / `isSessionAssurance` (an unknown value, impossible while the `CHECK` constraints hold, counts as no session). The dashboard builds its `auth` context from it, so a request costs exactly one session query and a role change applies on the next request.
- **Sweep.** The purge worker (`runSessionSweep` in `src/modules/trash/services/purge.service.ts`) calls `purgeExpiredSessions()` on boot and every 6 hours and logs `Expired session sweep completed` with `deleted`. Housekeeping only: the guard enforces expiry itself.

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

- Deactivate: `disabled_at` set, every session deleted (`revokeAllUserSessions`: the account's cookie gets a `302` to the login page on its next request), the open invitations it issued revoked, and the open password reset links for it and those it issued revoked (#277), so reactivating it revives none of them. Reactivate clears `disabled_at` and deletes every session of the account again, so a session created by a login that raced the deactivation can never come back to life; the revoked invitations stay revoked.
- Admin to member: the open invitations and password reset links the account issued are revoked (a member can grant or manage nothing). Member to admin: the account's own open reset links are revoked (#277), so one issued while it was a member cannot come back to life after a demotion within the hour. The new role applies on its next request, since the session guard reads the role every time; sessions are kept.
- Remove: the open invitations it issued are revoked and its sessions deleted, then the row is deleted: `user_credentials`, `sessions` and its own `user_tokens` cascade, and `invited_by` on its past invitations becomes `NULL`.
- Transfer: the owner is demoted to `admin` first, then the target promoted to `owner`, so `users_single_owner` holds at every statement; the previous owner's open `admin` invitations are revoked (an admin cannot grant admin), its `member` invitations stay, every open owner setup link is revoked (a `reset-owner` link minted for the previous owner would otherwise come back to life if ownership ever returned to it), and so are the open password reset links the previous owner issued for admins and every open reset link of the new owner, whoever issued it (#277; revoked before the role changes; they would otherwise come back to life if ownership returned within the hour). Both accounts stay signed in. The password is checked with `verifyPassword` against the owner's `password` credential, after the rules (a refused request never reaches argon2id) and outside the lock; a wrong password changes nothing. The check is throttled with the login limiter's settings (`DASHBOARD_LOGIN_RATE_LIMIT_*`) under keys of its own, `transfer:user:<actorId>` and `transfer:ip:<client IP>`: over budget, the request is refused (`rate_limited`) before any argon2id work; otherwise the attempt is counted right away, before the verify, so a parallel burst cannot run more verifies than the budget; a completed transfer clears both keys. The route builds the budget (`AttemptLimiter`) and passes it to the service. After a transfer, update `BUNMAIL_OWNER_EMAIL` to the new owner's address, or the boot logs the `differs from the stored owner` warning (it never changes anything).

Revoking those invitations is housekeeping: acceptance re-checks that the inviter is enabled and may still grant the role (#217), so an invitation issued in a race is dead anyway.

**Refusals.** `AccountRefusal`: `actor_inactive`, `not_found`, `self`, `target_is_owner`, `role_not_allowed`, `invalid_role`, `unchanged`, `confirm_mismatch`, `wrong_password`, `not_eligible`, `rate_limited`, `account_disabled` (#277). Those no button leads to (`actor_inactive`, `self`, `target_is_owner`, `role_not_allowed`, `invalid_role`) get the `403` page; the others go back to the Users page with an error flash.

**Logs.** One line per action, after the transaction: `info` `Account role changed` / `Account deactivated` / `Account reactivated` / `Account removed` / `Ownership transferred` / `Password reset link issued` with `action`, `actorId`, `actorRole`, `targetUserId`, the old and new role or status (`oldRole`, `newRole`, `oldStatus`, `newStatus`, `previousOwnerRole`), the counts (`sessionsRevoked`, `invitesRevoked`, `setupLinksRevoked`, `resetLinksRevoked`) and, for a reset link, `resetId` and `expiresAt` (never the token); a removal adds the email through `redactEmail`. A refusal (including a wrong password and an exhausted transfer budget) is `warn` `Account action refused` with `action`, `actorId`, `targetUserId`, `reason` and the roles. Never a password.

## Password resets (#277)

An admin or the owner can let a user who forgot their password back in without email: **Reset password** on the Users page (`POST /dashboard/users/:id/reset-password`) issues a one-time link and shows it once to the issuer, who hands it over by a channel of their choice.

**Who may reset whom.** The `reset_password` rule in `accountActionRefusal`, the same "who manages whom" as deactivation: the owner resets admins and members, an admin resets members, a member nobody; nobody resets their own account this way, and nobody resets the owner (the owner uses `bun run src/db/reset-owner.ts`). A deactivated account cannot be reset until it is reactivated (`account_disabled`). The rule runs in `issuePasswordReset` (`user-admin.service.ts`) on the live actor and target rows, under the `bunmail:owner` lock like every account action; a crafted request for an account no button leads to gets the `403` page.

**Issuing.** In the same locked transaction, `replaceResetToken` revokes every open `password_reset` token of the account (one live link per account: a second link kills the first) and inserts a new `user_tokens` row: `purpose = 'password_reset'`, `user_id` = the account, `invited_by` = the issuer (meaning "issued by" for this purpose; no schema change), only `hashToken(token)` stored, `expires_at` = `now() + interval '60 minutes'` on the database clock (`PASSWORD_RESET_TTL_MINUTES`, a code constant, inlined as a literal and read back). After commit the link `<APP_BASE_URL or http://localhost:PORT>/dashboard/reset?token=...` is built and stashed in the one-time reveal store (kind `password_reset_link`, bound to the issuer's user and session, 60 seconds, #280); the redirect carries only the reveal token, and the Users page shows the link once. It is never emailed, and never in a URL of ours, a flash message or a log. A localhost fallback is flagged in the flash and logged (`Password reset link points at localhost`, `warn`, with `resetId` and a `hint`). Issuing touches neither the account's sessions nor its password.

**Completing.** `GET /dashboard/reset?token=` and `POST /dashboard/reset` are public routes registered before the session guard, mirroring the invitation accept page: auth-page headers (`no-store`, `Referrer-Policy: strict-origin`, `nosniff`, `DENY`), same-origin first on the POST, then the token shape, an indexed lookup, the password policy (15 to 256 characters, confirmed: the owner setup policy; a failure re-renders the form without hashing), and only then argon2id (outside the lock). A link counts as usable only while it is open, unexpired on the database clock, its account exists and is enabled, and its issuer exists, is enabled, is not the account, and may still manage the account's current role (`issuerStillManages`, the same table as the Users page rules). Every unusable link gets the same `400` page; `GET` never spends the token. In one transaction under the owner lock: spend the token with a conditional `UPDATE ... SET used_at = now()` on that predicate (an issuer or account changed after the form was opened still makes it fail; of two concurrent submissions one wins), replace the `password` credential (every session bound to the old credential goes with it, by cascade), revoke every other open token of the account, revoke the open invitations and reset links the account **issued** (as deactivation does: whoever held the old password may have issued them; the trade-off is that the account's legitimate pending invitations die too and must be sent again), delete every session of the account, open a new session bound to the new credential, touch `updated_at`. The route then revokes the session the browser presented, if any (like login), sets the cookie and redirects to `/dashboard`. Logged at `warn` as `Password reset completed` (`resetId`, `userId`, `issuedBy`, redacted `email`, `sessionsRevoked`, `tokensRevoked`, `issuedTokensRevoked`, `sessionId`, `ip`); a dead link on the POST is only `debug` `Password reset refused: invalid link` (like the invitation page, so an anonymous flood cannot fill the `warn` log). Never the token, its hash, the link or a password.

**Second factors.** A reset replaces only the `password` credential. No second factor exists yet; when #220 ships, a reset must leave the second factor in place and the session it opens must get `pending` assurance for an account that has one (a comment in `completePasswordReset` marks the spot).

## Service helpers

`password.service.ts`, `token.service.ts`, `owner-setup-policy.service.ts`, `session-policy.service.ts`, `invite-policy.service.ts`, `user-admin-policy.service.ts` and `password-reset-policy.service.ts` are pure: no I/O, no config. `owner.service.ts`, `session.service.ts`, `login.service.ts`, `invite.service.ts`, `user-admin.service.ts` and `password-reset.service.ts` touch the database, all through `withSanitizedErrors`; `invite-email.service.ts` sends mail.

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

### invite-email.service.ts

- `buildInviteEmail({ url, inviter, role, expiresAt }): { subject, text, html }`: pure; every dynamic value escaped in the HTML part and flattened to one line in the text part; exactly one link.
- `sendInviteEmail(input, deps?): Promise<InviteMailOutcome>`: the send decision above; never throws. `deps` (`from`, `findDomain`, `resolveDkim`, `send`, `hostname`) defaults to the real ones and is injected by the unit tests.

### invite.service.ts

Every write for an address runs in a transaction under its `bunmail:invite:<email>` advisory lock. Never logs a token, its hash or the link.

- `createInvitation(actor, email, role): Promise<IssueInvitationResult>`: checks, replaces the address's open invitations (never a higher-role one), sends or reports the email. `{ ok: true, invitation, url, delivery }` or `{ ok: false, reason }`.
- `resendInvitation(actor, id)`, `revokeInvitation(actor, id)`: as above, for a pending invitation of a role the actor may grant.
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
- `changeAccountRole(actorId, targetId, role)`, `deactivateAccount(actorId, targetId)`, `reactivateAccount(actorId, targetId)`, `removeAccount(actorId, targetId, confirm)`, `transferOwnership(actorId, targetId, password, limiter)`: `Promise<AccountActionResult>` (`{ ok: true }` or `{ ok: false, reason }`).
- `issuePasswordReset(actorId, targetId): Promise<IssuePasswordResetResult>` (#277): the rules, then `replaceResetToken`, in one locked transaction; returns the link for the one-time reveal.

### password-reset-policy.service.ts

- `PASSWORD_RESET_TTL_MINUTES` (60): lifetime of a reset link (a code constant, no env var).
- `buildPasswordResetUrl(appBaseUrl, port, token)`: `buildDashboardUrl` for `/dashboard/reset?token=...`.

### password-reset.service.ts

Never logs a token, its hash, the link or a password.

- `replaceResetToken(tx, userId, issuerId): Promise<IssuedPasswordReset>`: revokes the account's open reset links and mints a new one; the caller holds the owner lock.
- `revokeResetLinks(executor, { userId } | { issuedBy, targetRole? }): Promise<number>`: housekeeping for deactivation, role changes, ownership transfer and a completed reset (`targetRole` limits it to links for accounts of that role).
- `findLivePasswordReset(token): Promise<PasswordResetTarget | null>`: read-only lookup for the reset form (usable, with the issuer and account re-checks).
- `completePasswordReset(token, password, client?): Promise<CompletePasswordResetResult>`: the completion transaction above.

### owner.service.ts

Every write runs in a transaction under the `bunmail:owner` advisory lock (`withOwnerLock`, also used by account management). Never logs the token or its hash.

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
- `findActiveSession(token): Promise<ActiveSession | null>`: the guard's single lookup described above. `ActiveSession` is `{ sessionId, userId, email, role, assurance, matched, rotationDue, graceOver }`.
- `rotateSession(sessionId, presentedToken): Promise<RotatedSession | null>`: the conditional rotation; `null` when another request rotated first.
- `revokeSessionByToken(token): Promise<string | null>`: deletes the session whose current or previous hash matches; returns its `ses_` id.
- `revokeAllUserSessions(userId, executor?): Promise<number>`: deletes every session of a user.
- `purgeExpiredSessions(): Promise<number>`: deletes expired rows.

### login.service.ts

- `verifyPasswordLogin(email, password): Promise<LoginResult>`: the password step described above; `{ ok: true, userId, assurance }` or `{ ok: false, reason }`.

## Roles enforcement (#222)

Three roles, ranked owner > admin > member. The dashboard guard (`src/pages/pages.plugin.tsx`) exposes the signed-in account to every protected handler as `auth: DashboardAuth` (`{ user: { id, email, role }, session: { id, assurance } }`, type in `user.types.ts`), and each route carries one check from `src/pages/guards.tsx`:

| Role | Can do |
|---|---|
| `member` | Read the dashboard (emails, inbound, logs and stats, the view pages of domains, webhooks, DMARC reports and suppressions), send email, restore single messages from trash, view and create templates (editing existing templates is admin until #219 adds per-member ownership) |
| `admin` | Everything a member can, plus inviting members (#217), deactivating, reactivating and removing members (#218), issuing password reset links for members (#277), API keys, every domain, webhook and suppression change, template edit and delete, trash (single and bulk, since trash is purged after `TRASH_RETENTION_DAYS`), bulk and permanent deletes, empty trash |
| `owner` | Everything an admin can, plus inviting admins (#217), changing roles, deactivating, reactivating and removing admins, transferring ownership (#218), and issuing password reset links for admins (#277). No route carries `ownerGuard`: these owner-only rules are checked inside the invitation and account services, against the live role |

A role too low gets `403` and a `warn` log line with IDs only. The full route table and the 403 behaviour are in [docs/dashboard.md](dashboard.md#roles-222). The REST API does not use these roles: it authorizes API keys (`is_admin`, `allowed_senders`).

## Migration

`drizzle/0016_*.sql` creates the four tables, applied automatically on boot by the runner. The `CHECK` lists are rendered as quoted literals via `sql.raw` (code constants): bound parameters are not valid in DDL, and drizzle-kit would otherwise emit `$1, $2` placeholders into the migration.

`drizzle/0017_*.sql` (#216) adds the nullable `sessions.previous_token_hash` and `sessions.rotated_at` columns, the `sessions_previous_token_hash_idx` index, and the `session_token_history` table (`token_hash` PK, `session_id` FK `sessions` ON DELETE CASCADE, `superseded_at`, index on `session_id`). No backfill: existing rows simply have not rotated yet.

`drizzle/0018_*.sql` (#217) adds `user_tokens_invite_check`: `purpose <> 'invite' OR (email IS NOT NULL AND role IS NOT NULL AND role IN ('admin', 'member'))`. No invitation rows existed before, so nothing can violate it.

`drizzle/0019_*.sql` (#277) adds the nullable `sessions.credential_id` (FK `user_credentials(id)` ON DELETE CASCADE) and `sessions_credential_id_idx`. No backfill: existing sessions keep `NULL` (not bound) and age out within the 7-day cap; every session opened afterwards is bound.

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
- `test/unit/password-reset-policy.test.ts` (#277): the one-hour lifetime and the link builder (fallback, encoding); `test/unit/user-admin-policy.test.ts` covers the `reset_password` rule and `test/unit/pages-render.test.ts` the reset pages and the Users page action and reveal.
- `test/integration/password-reset.integration.test.ts` (#277): who may issue a link for whom (service and crafted HTTP, the owner, self, a member, a disabled account), one live link per account, the one-hour expiry on the database clock, the one-time reveal to the issuing session only, completion (old password fails and new one works through the login service, every session and every other open token revoked, a fresh session, concurrent completions), the browser's own session replaced, the log line without secrets, expired, used, revoked, unknown and malformed links getting the identical `400` without reaching argon2, a cross-origin POST refused, the issuer or the account changed after issuing (disabled, demoted, deleted, promoted beyond reach, deactivated then reactivated, promoted then demoted, an ownership round trip) making the link dead, the tokens the account issued revoked by its reset, and the credential binding of sessions (the cascade, a login racing a reset answered as a failed login, and login, owner setup, invitation acceptance and reset all binding their session).
- `test/integration/dashboard-route-access.integration.test.ts` (#222): the deny-by-default route table (every plugin route listed with its access level and carrying the matching role guard; no cookie, member, admin and owner requests per route), a role change applying on the next request, `requireAssurance("mfa")` on a test-only route, and one session lookup per request.
- `test/integration/dashboard-session.integration.test.ts`: login against real Postgres (only the hash stored, `last_used_at`, distinct cookies, session replacement, one argon2id verify on every failure branch), logout, the guard (expired, disabled user, `pending` assurance, tampered token, old HMAC cookie), rotation (after 60 s, the absolute cap, grace, exactly one winner among concurrent requests), reuse detection (every session of the user revoked; a token two rotations old only rejected) and the service helpers (sweep, per-user revoke, IP cleaning).
- `test/integration/owner-setup.integration.test.ts`: fresh install, restart before setup (including a changed email and `email-taken`), concurrency (parallel bootstraps, parallel completions, bootstrap racing completion, completion and recovery provably waiting on the held owner lock, lock released after commit), expiry, single use and a disabled owner (including one disabled while completion waits on the lock), behaviour after setup, sessions (completion deletes the owner's sessions and opens exactly one; a failed completion leaves them; `issueOwnerSetupLink` signs out only the owner), recovery, and a spawned `reset-owner.ts` smoke test (exit `0` with a live link and the sign-out line, also under `LOG_LEVEL=error`; exit `1` with no owner and no email).
