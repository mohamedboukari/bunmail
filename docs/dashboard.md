# Dashboard

Server-rendered web UI for managing BunMail. Built with Elysia JSX (`@elysiajs/html` + `@kitajs/html`).

## Configuration

| Env Variable                       | Required | Default       | Description                                  |
|------------------------------------|----------|---------------|----------------------------------------------|
| APP_BASE_URL                       | No       | _(empty)_     | Public base URL (no trailing slash) used for the owner setup link, invitation links and password reset links. Unset or not an `http(s)://` URL: links point at `http://localhost:PORT` and invitations are never emailed (the inviter sees the link instead). |
| BUNMAIL_OWNER_EMAIL                | **Prod** | _(empty)_     | Email of the dashboard owner account (#215), stored lowercased. **Required when `BUNMAIL_ENV=production`** (app refuses to start when it is unset); a malformed address or one over 254 characters is refused in every environment; unset in dev skips the owner bootstrap with a warning, which leaves the dashboard without an account to sign in with (#216). See [Owner setup](#owner-setup-215). |
| DASHBOARD_TRUSTED_PROXY_HOPS       | No       | `0`           | Trusted reverse-proxy hops in front of BunMail, used to resolve the real client IP for login rate limiting. `0` = trust only the raw socket IP. Set to `1` behind a single nginx/Caddy/Cloudflare (`N` for `N` chained proxies). |
| DASHBOARD_LOGIN_RATE_LIMIT_ENABLED | No       | `true`        | Master switch for login brute-force protection |
| DASHBOARD_LOGIN_RATE_LIMIT_MAX     | No       | `5`           | Failed attempts per IP per window before lockout: a whole number from 1 to 100; anything else (not a number, 0, a decimal, out of range) refuses to boot (#220). Also budgets the password checks of the ownership transfer, the password change and the 2FA enrolment start. Two-factor code checks have a fixed budget of their own (5 per 15 minutes), whatever this says |
| DASHBOARD_LOGIN_RATE_LIMIT_WINDOW  | No       | `900`         | Lockout window in seconds (default 15 minutes): 60 to 86400; anything else refuses to boot (#220) |
| REQUIRE_2FA                        | No       | `none`        | Who must set up two-factor authentication before using the dashboard (#220): `none` (nobody), `owner` (the owner), `admin` (admins and the owner). Case-insensitive; anything else refuses to boot. An account it covers without a second factor can open only its Two-factor page until it enrols. The default `none` means upgrading never locks anyone out. See [Two-factor authentication](#two-factor-authentication-220). |
| AUDIT_LOG_RETENTION_DAYS           | No       | `365`         | Days audit log entries are kept (#221): a whole number from 30 to 3650; anything else refuses to boot. See [Audit log](#audit-log-221). |
| INVITE_EXPIRY_DAYS                 | No       | `7`           | Days an invitation link stays valid (#217): a whole number from 1 to 90; anything else refuses to boot. |
| SYSTEM_MAIL_FROM                   | No       | _(empty)_     | Sender of invitation emails (#217) and new-device sign-in alerts (#282): one bare address on a domain registered and DKIM-verified in BunMail; malformed refuses to boot. Unset, or its domain unusable: the inviter gets the link once on the Invitations page instead, and a sign-in from a new device is only logged. See [Invitations](#invitations-217) and [New-device alerts](#new-device-alerts-282). |

`DASHBOARD_PASSWORD` and `SESSION_SECRET` were removed by account login (#216). A value left in `.env` does nothing except one boot warning: `Dashboard auth env vars are no longer used since #216, remove from .env`.

## Auth Flow

Account login (#216): email and password against the `users` and `user_credentials` tables, then a server-side session in `sessions`. Internals: [docs/users.md](users.md#sessions-216).

**Login** (`POST /dashboard/login`, form fields `email`, `password`), in order:

1. Auth-page headers (`Cache-Control: no-store`, `Referrer-Policy: strict-origin`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`), also on `GET /dashboard/login`.
2. Same-origin check: a cross-origin `Origin`/`Referer`, or neither header, gets `403` `Forbidden: cross-origin request rejected` and a `warn` log (`Dashboard login POST rejected: cross-origin (possible CSRF)`). This blocks login CSRF (signing a victim into someone else's account).
3. The per-IP limiter (#109), before any database or argon2id work: `429` with `Retry-After`.
4. Input bounds: an email over 254 or a password over 256 characters fails without any lookup. (Over 320 or 1024 characters the route's schema rejects the body with the global `422` JSON error.)
5. `verifyPasswordLogin` runs exactly one argon2id verify on every branch (a missing account or credential is verified against a dummy hash), so the response time does not reveal whether an account exists.
6. Failure, whatever the reason: counted against the IP, `warn` log `Dashboard login failed` with `ip`, `reason` (`unknown`, `no_password`, `disabled`, `bad_password`, `too_long`) and the email through `redactEmail` (none for `too_long`), and a `302` to `/dashboard/login?error=invalid`, which shows `Invalid email or password.`. The email never goes in the URL.
7. Success: the IP's failure count is cleared; a well-formed session cookie the browser already sent is revoked first (no session stacking, no planted cookie survives login); a new session is created (`info` log `Dashboard login successful` with `userId`, `sessionId`, `ip`) and the browser is sent to the fixed `/dashboard` (no `next` parameter, no open redirect). The response also sets the `bm_device` cookie and the new-device check starts in the background (#282, see [New-device alerts](#new-device-alerts-282)). A database error answers `503` `Dashboard temporarily unavailable`.
8. Success for an account with two-factor authentication (#220): the session is created `pending` instead, for 10 minutes (cookie `Max-Age=600`), `info` log `Dashboard login: password accepted, second factor required`, and a `302` to `/dashboard/login/two-factor`. A pending session opens no other page. The `bm_device` cookie, the new-device check and the location lookup wait for the second step. See [Two-factor authentication](#two-factor-authentication-220).

**Cookie:** `bm_session=<token>`, where the token is 32 random bytes as base64url (43 characters); only its SHA-256 is stored. `HttpOnly; SameSite=Lax; Path=/dashboard`, plus `Secure` in production (#133), so over plain HTTP the browser drops it (most browsers make an exception for `localhost`). `Max-Age` is 7 days at login; after a rotation it is what is left of the 7 days.

**Lifetimes:** a session expires after 24 hours without use (idle timeout) and 7 days after login at the latest (absolute cap). Both are code constants in `session-policy.service.ts`, not env vars. All expiry math runs on the Postgres clock, so replicas agree.

**Guard** (every route registered after the public login, logout, setup and invitation accept routes), in order:

1. No cookie: `302` to `/dashboard/login`.
2. A value that is not a 43-character token, including a pre-#216 `<timestamp>.<hmac>` cookie: cleared and `302`, with no database query.
3. One query (`findActiveSession`) matches the token's hash against the current and the previous token hash of an unexpired session whose user is not disabled and whose assurance is `mfa`, or `password` while the account has no TOTP second factor (#220: so a password-level session, even one a login opened while a 2FA confirmation was committing, stops working the moment the account has 2FA); the same row says whether the account has a TOTP second factor. A `pending` session (password passed, second factor still to come) is no session here, on every protected route: it opens only the public second login step. No row: cookie cleared, `302`. A database error: `503` `Dashboard temporarily unavailable` (fail closed, and no false logout).
4. Reuse detection (see below): every session of the user is revoked, cookie cleared, `302`.
5. A cross-origin `POST`: `403` (CSRF second layer, #133). It runs before rotation, so a rejected request never carries a new token.
6. Rotation, when due (see below).
7. `REQUIRE_2FA` (#220): an account whose role the policy covers and that has no second factor gets a `302` to `/dashboard/account/two-factor` from every route except that page and its actions (logout and the assets are public routes, so they stay reachable). Logged at `debug` (`Two-factor enrolment required: redirected to the Two-factor page`).
8. The request goes on with `auth` (#222), then the route's role check (see [Roles](#roles-222)).

The guard is an Elysia `resolve`, so its result is typed on every handler registered after it. A `resolve` can only stop a request by returning `status()`, so each refusal above sets its headers (`location`, `set-cookie`) on `set` and returns `status(302 | 403 | 503, body)`.

### Roles (#222)

Every protected handler gets `auth` on its context, built from the guard's single `findActiveSession` query (the account's email and role and the session's assurance come back with the session row, so there is no second lookup):

```ts
auth: {
  user: { id: string; email: string; role: "owner" | "admin" | "member" };
  session: { id: string; assurance: "password" | "mfa" };
}
```

The role is read on every request, so a role change applies on the next request. `src/pages/guards.tsx` holds the checks, used as each route's own `beforeHandle` (they run after the guard):

| Helper | Lets through | Used for |
|---|---|---|
| `memberGuard` | any signed-in account | home, change password (form and `POST`, #279), active sessions (the page and both sign-out actions, own sessions only, #281), two-factor authentication (the page and its four actions, own account only, #220), send (form and `POST`), emails and inbound lists and detail pages, restore from trash (single message), inbound reply form, tombstones, templates (view and create; edit and delete of the member's own templates, checked in the service, #219), API keys (#219: the page, create, allowed senders and revoke, scoped in the service to the member's own keys; a member's keys are always restricted), and the view pages (`GET`) of domains, webhooks and their deliveries, DMARC reports and suppressions |
| `adminGuard` | admins and the owner | the Invitations page and its actions (#217; which roles an account may grant is checked in the service), the Users page and its actions (#218, including Reset password #277; the owner-only and members-only rules are checked in the service), the API key admin toggle (`POST /dashboard/api-keys/:id/admin`; admins and the owner also see and manage every key and create admin keys, #219), every domain, webhook and suppression change (create, verify, delete, edit, replay a delivery), edit and delete of any template (#219), trash (single and bulk), bulk restore, permanent delete (single and bulk) and empty trash, outbound and inbound. Trash is admin-only because the purge worker hard-deletes it after `TRASH_RETENTION_DAYS` |
| `ownerGuard` | the owner | no route: role changes and ownership transfer (#218) are owner-only inside the account service, which checks the live role in its transaction |

They are thin wrappers of `requireRole(min)`, which ranks owner > admin > member. `requireAssurance(level)` is the same kind of check on the session: `requireAssurance("mfa")` refuses a `password` session. No route uses it: two-factor authentication (#220) is enforced by the login (a `pending` session until the code) and by the `REQUIRE_2FA` policy in the guard, so accounts without a second factor keep working unchanged.

A denial answers `403` with a small "Forbidden" page in the dashboard layout (it names the required and the current role, nothing else) and logs `warn` `Dashboard access denied: role too low` with `userId`, `role`, `required`, `method` and `path` (`Dashboard access denied: session assurance too low` with `userId`, `sessionId`, `assurance`, `required`, `method`, `path` for `requireAssurance`). The navigation is not filtered by role yet: a member still sees links to admin pages and gets the 403 page there. The Invitations page has no sidebar entry for that reason (the shared sidebar does not know the viewer's role); admins and the owner get an **Invite teammates** link on the dashboard home instead.

Deny by default: `test/integration/dashboard-route-access.integration.test.ts` reads every route from the plugin and fails when one is missing from its table, when a protected route does not carry exactly the role guard its table entry names, or when a request gets the wrong answer (no cookie: `302` to the login page; a role too low: `403`; a role high enough: neither). A new dashboard route needs a role guard and a table entry.

**Token rotation and reuse detection.** When a request presents the current token and that token is older than 60 seconds, the session gets a fresh token: one conditional `UPDATE` moves the old hash to `previous_token_hash`, stores the new one, and slides `last_seen_at` and `expires_at` forward (this write is also the idle-timeout refresh, so an active session costs at most one write a minute). The response carries the new cookie. Then:

- A request that still carries the replaced token (parallel tabs, a page and its form post) is served normally for 30 more seconds, without a new cookie.
- Two requests that race to rotate: exactly one wins and sets the new cookie; the other is served without one.
- The replaced token presented **after** those 30 seconds means two parties hold the session: every session of the user is revoked, the `warn` log `Session token reuse detected: all sessions of the user revoked` (with `userId`, `sessionId`, `ip`) is written, the cookie is cleared and the browser is sent to the login page. If revoking fails, the request gets `503`.
- A token two or more rotations old is reuse too: every replaced hash is kept in `session_token_history` until the session ends, so any superseded token, however old, revokes every session of the user, on protected pages and also when presented to the login or logout page. A token that was never issued, or belongs to an expired or revoked session, is simply rejected (cookie cleared, `302`).
- A rotation error is logged (`Dashboard session rotation failed`) and the request is served; the old token stays current.

So a copied cookie is detected as soon as both copies are used: whichever side falls behind a rotation presents a superseded token, and the account is signed out everywhere. A thief who keeps the session active while the real user is idle is caught the moment the real browser returns, however many rotations have passed. The limit: if the real browser never comes back, the thief's session lives until the 7-day cap, a `reset-owner`, or a sign-out from the [Active sessions](#active-sessions-281) page (#281). The cost is a rare false logout: if the response carrying a new cookie never reaches the browser (a dropped connection), its next request after the grace period looks like reuse.

**Logout** (`POST /dashboard/logout`, public): same-origin only (`403` and a `warn` log otherwise). It deletes the session row (matched by the current or the previous token hash, so a just-rotated cookie still logs out), logs `Dashboard logout` with `sessionId` and `ip`, and always clears the cookie and redirects to `/dashboard/login`, also for a missing, malformed, already revoked or legacy cookie, and after a database error (logged as `Dashboard logout: session revoke failed`). Replaying the old cookie afterwards gets a `302` to the login page.

The login page also shows a static first sign-in hint (open the owner setup link from the server logs, or run `reset-owner`); there is no database lookup behind it, so the public page says nothing about the setup state. Expired rows are deleted by the purge worker on boot and every 6 hours (`Expired session sweep completed`); the guard enforces expiry itself, so security never depends on that sweep.

### Owner setup (#215)

On first boot BunMail creates the owner account for `BUNMAIL_OWNER_EMAIL` and logs a one-time link at `warn` (at `error` when `LOG_LEVEL=error`) (`Owner setup link`): `<APP_BASE_URL>/dashboard/setup?token=...`, or `http://localhost:PORT/...` (with a `hint` field) when `APP_BASE_URL` is unset or not an `http(s)://` URL. The link is single use and valid for 24 hours; until setup is done each restart replaces it, so only the most recent link works. `bun run src/db/reset-owner.ts` (in Docker: `docker compose exec app bun run src/db/reset-owner.ts`) prints a fresh one.

1. `GET /dashboard/setup?token=...` is public (registered before the session guard, so the guard never runs for it). It only reads the token: a missing, malformed, unknown, expired, used or replaced token gets the same `400` "invalid link" page, which never echoes the token (missing and malformed tokens are rejected before any database call). A `token` longer than 128 characters, or a repeated `token` parameter, fails the route's schema instead and gets the global `422` JSON error.
2. A live token renders the form (`200`): the owner email, a hidden token field, password and confirmation (15 to 256 characters, counted in code points).
3. `POST /dashboard/setup` (form fields `token`, `password`, `confirm`) checks same-origin itself first, since the guard's CSRF check does not run on public routes: a cross-origin `Origin`/`Referer`, or neither header, gets `403` `Forbidden: cross-origin request rejected` and a `warn` log (`Owner setup POST rejected: cross-origin (possible CSRF)`). Then the token (the same `400` invalid page), then the password policy (a policy error re-renders the form with `200`, no hashing and no write), then it spends the token and stores the argon2id password hash. A token spent by a concurrent submission in between also gets the `400` invalid page.
4. On success the server logs `Owner setup completed` at `warn` (`owner` through `redactEmail`, client `ip`). In the same transaction that stores the password, every session of the owner is deleted and a new one is opened (#216); its token is set as the `bm_session` cookie (the same attributes and 7-day `Max-Age` as a login) and the browser is redirected (`302`) to `/dashboard`.

Every response from the setup handlers, including the `403` and `302` (but not a `422` schema rejection, which never reaches the handler), sends `Cache-Control: no-store`, `Referrer-Policy: strict-origin` (the pages also carry a matching meta tag; a `Referer` carries the origin only, never the token URL, and `no-referrer` would make browsers send `Origin: null` on the form POST, which the same-origin check rejects), `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY`.

After setup the owner signs in at `/dashboard/login` with `BUNMAIL_OWNER_EMAIL` and that password. `reset-owner` signs the owner out of every session as soon as it runs, and completing its link does so again. Internals: [docs/users.md](users.md#owner-bootstrap-215).

### Invitations (#217)

Admins and the owner invite teammates at **Invitations** (`/dashboard/invitations`, linked from the dashboard home). Internals and the full rules: [docs/users.md](users.md#invitations-217).

- **Invite form:** an address and a role. The owner may grant `admin` or `member`, an admin only `member` (the select lists only those). The service re-checks the role against the signed-in account's role: a crafted `role=owner`, or an admin posting `role=admin`, gets `403`. An address that already has an account is refused with an error flash; inviting a pending address replaces its link, except that an admin cannot replace (or downgrade) a pending admin invitation from the owner: that gets the error flash `A pending invitation from a higher role exists for this address.` and nothing changes.
- **Pending list:** email, role, invited by, created, expires, with **Resend** (a new link for the same address and role; the old one stops working) and **Revoke**. Rows of a role the viewer cannot grant (admin invitations, for an admin) show "Owner only".
- **Email or one-time link:** when `SYSTEM_MAIL_FROM` is set and its domain is registered and DKIM-verified, the invitation is emailed (`Invitation sent by email.`). Otherwise, or when the send fails, the flash says why (`no system sender is configured`, `the system sender's domain is not registered or not DKIM-verified`, `sending failed`, or `APP_BASE_URL is not set, so no usable link could be emailed`: a link that falls back to `localhost` is never emailed) and the accept link is shown **once**, through the one-time reveal store (kind `invite_link`, bound to the inviter's user and session, 60 seconds, #280). The link never appears in a URL, a flash message or a log. The Invitations, Users, API Keys and Webhooks pages, which can show a one-time secret, are sent with `Cache-Control: no-store`.

**Accepting** (public, registered before the session guard like owner setup):

1. `GET /dashboard/invite?token=...` only reads the token. Missing, malformed, unknown, expired, used and revoked tokens, and invitations whose inviter was since deleted, disabled or demoted below the role it granted, all get the same `400` "This invitation link is not valid" page, which never echoes the token. A live token renders the form (`200`): the invited address and role, a hidden token field, a name (1 to 100 characters, no control or invisible formatting characters) and a password with confirmation (15 to 256 characters, the owner setup policy).
2. `POST /dashboard/invite` (form fields `token`, `name`, `password`, `confirm`) checks same-origin first (`403` and a `warn` log `Invitation accept POST rejected: cross-origin (possible CSRF)`), then the token (the same `400` page), then the policy (a problem re-renders the form with `200`, no hashing, no write), then creates the account, its password and its session in one transaction and spends the token.
3. When an account took the address after the invitation was sent, the answer is `409` with a page pointing at the login page, and the address's invitations are revoked.
4. On success the session the browser already presented is revoked (as at login), the new session's cookie is set (same attributes and 7-day `Max-Age` as a login) and the browser goes to `/dashboard`. Logged at `warn` as `Invitation accepted`.

Every response from the accept handlers sends the same auth-page headers as owner setup (`Cache-Control: no-store`, `Referrer-Policy: strict-origin` plus the meta tag, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`).

### Users (#218)

Admins and the owner manage accounts at **Users** (`/dashboard/users`). Internals, side effects and log lines: [docs/users.md](users.md#account-management-218).

- **List:** every account with name, email, role, status (active or disabled) and creation date; the viewer's own row is marked `(you)`; a button opens Invitations. Every stored value is escaped.
- **Buttons:** only the actions the viewer may use on that row (`allowedAccountActions`); every action is checked again in the service against the live roles, under the owner lock.

| Action | Route | Who | Confirmation |
|---|---|---|---|
| Make admin / Make member | `POST /dashboard/users/:id/role` (`role`) | owner, on any non-owner | none |
| Deactivate | `POST /dashboard/users/:id/deactivate` | owner on any non-owner, admin on members | browser confirm; signs the account out everywhere |
| Reactivate | `POST /dashboard/users/:id/reactivate` | same as deactivate | none |
| Remove | `POST /dashboard/users/:id/remove` (`confirm`) | same as deactivate | type the account's email |
| Make owner (transfer) | `POST /dashboard/users/:id/transfer` (`password`) | owner, to an active admin | the owner's current password, throttled like login (per account and per client IP, `DASHBOARD_LOGIN_RATE_LIMIT_*`) |
| Reset password (#277) | `POST /dashboard/users/:id/reset-password` | same as deactivate, active accounts only | browser confirm; shows a one-time link |

Demoting an admin to member makes every admin API key it created restricted (they stay active). Deactivating or removing an account disables every active API key it created (the API keys page shows "Disabled: creator deactivated" or "creator removed"); reactivating does not re-enable them. A transfer moves the old owner's templates, domains and webhooks to the new owner, never its API keys (#219). Only keys of an active admin or the owner (or with no creator) get a **Make admin** button; a crafted promotion of a member's key is refused with a flash. Template and webhook creates attach to the user's own active key (a member without one gets "Create an API key first"). For members, the emails and suppressions key filters and the inbound reply key picker list only their own keys, and "Created by" shows a masked email when the account has no name.

Nobody acts on their own account, and the owner is never demoted, deactivated, removed or given a reset link (the owner uses `reset-owner`). A refusal that no button leads to (own account, the owner, a role too low, an unknown role) gets the `403` page; a race or a typo (already changed, wrong confirmation, wrong password, target no longer eligible, account gone) goes back to the page with an error flash, and so does an exhausted transfer budget (`Too many failed attempts, try again later.`, no password check runs). Reactivation also signs the account out of any session left over from a login that raced its deactivation. Every outcome is logged.

### Password reset (#277)

**Reset password** on the Users page issues a one-time link for the account and shows it **once** to the issuer, through the one-time reveal store (kind `password_reset_link`, bound to the issuer's user and session, 60 seconds, #280): copy it and hand it to the account holder privately. It is never emailed, and never in a URL, a flash message or a log. It works once, for one hour (database clock); issuing a new one kills the previous one. A deactivated account must be reactivated first (error flash `Reactivate the account before resetting its password.`). When `APP_BASE_URL` is unset the flash says the link points at localhost. Internals: [docs/users.md](users.md#password-resets-277).

**Completing** (public, registered before the session guard like the invitation accept page, with the same auth-page headers):

1. `GET /dashboard/reset?token=...` only reads the token. Missing, malformed, unknown, expired, used and revoked tokens, and links whose account was since disabled, or whose issuer was since deleted, disabled or demoted (or no longer manages the account's role), all get the same `400` "This password reset link is not valid" page, which never echoes the token. A live token renders the form (`200`): the account's address (escaped), a hidden token field, a new password with confirmation (15 to 256 characters, the owner setup policy).
2. `POST /dashboard/reset` (form fields `token`, `password`, `confirm`) checks same-origin first (`403` and a `warn` log `Password reset POST rejected: cross-origin (possible CSRF)`), then the token (the same `400` page, logged only at `debug`), then the policy (a problem re-renders the form with `200`, no hashing, no write), then, in one transaction, spends the token, replaces the password, signs the account out of every session, revokes its other open tokens and the invitations and reset links it issued (its pending invitations must be sent again), and opens a new session. A login that checked the old password while the reset ran gets the generic invalid email or password answer.
3. On success the session the browser already presented is revoked (as at login), the new session's cookie is set and the browser goes to `/dashboard`. Logged at `warn` as `Password reset completed` (with `twoFactorRemoved`).

A completed reset also removes the account's two-factor authentication and recovery codes (#220): it is the recovery path when the authenticator app is lost. The new session is a `password` one; under `REQUIRE_2FA` the user is then sent to enrol again.

### Change password (#279)

Every signed-in account, the owner included, changes its own password at **Change password** (`/dashboard/account/password`, linked from the bottom of the sidebar for every role). Internals: [docs/users.md](users.md#password-change-279).

1. `GET /dashboard/account/password` renders the form (`no-store`): the account's address (escaped), the current password, a new password and its confirmation. Fields are never refilled after a refusal.
2. `POST /dashboard/account/password` (form fields `current`, `password`, `confirm`, `memberGuard`): the session guard refuses a cross-origin POST first (`403`). Then the failed-attempt budget: the login limiter's settings (`DASHBOARD_LOGIN_RATE_LIMIT_*`) under keys of its own, `password:user:<userId>` and `password:ip:<client IP>` (IPv6 by `/64`); over budget the form comes back with `429` and `Too many attempts. Try again later.`, before any argon2id work. Then the policy, with no argon2id and no attempt counted (current password required; the new one 15 to 256 characters, confirmed, different from the current one; `200` with the message). Then the attempt is counted and the current password verified, exactly one argon2id verify; a wrong one gets `200` and the generic `Current password is incorrect.` and stays counted. A completed change clears both keys.
3. On success, in one transaction: the password is replaced, every session of the account is signed out (this browser's too), the account's open reset links are revoked, and a fresh session bound to the new password is opened for this browser; its cookie is set and the browser goes back to the form with `Password changed. You were signed out on every other device.` If the password was reset elsewhere, or the account deactivated, between the check and the change, nothing changes (`409`). Two-factor authentication (#220) is kept, and the new session has the assurance of the one the change was made from (an `mfa` session stays `mfa`). Logged at `warn` as `Password changed` (`userId`, the new `sessionId`, `previousSessionId`, `sessionsRevoked`, `resetLinksRevoked`, `ip`); a refusal is `warn` `Password change refused` with a `reason`. Never a password.

### Active sessions (#281)

Every signed-in account, the owner included, sees and signs out its own sessions at **Active sessions** (`/dashboard/account/sessions`, in the Account group at the bottom of the sidebar, next to Change password). Only the account's own sessions: other accounts' sessions are managed from the Users page (deactivation signs an account out everywhere). Internals: [docs/users.md](users.md#active-sessions-281).

1. `GET /dashboard/account/sessions` (`memberGuard`, `no-store`) lists one row per **live** session of the account, most recently active first: the same predicate the session guard uses (unexpired, which covers the 24 h idle and 7 d absolute rules, and `password` or `mfa` assurance), so an expired or `pending` session is never listed. Each row shows the device (browser and system parsed from the stored user agent, for example `Chrome on macOS`; `Unknown browser` when unrecognized), the IP address, the approximate location when one is stored (the column appears only then, labelled "Approximate location": a VPN or proxy shows its own location), signed in at and last active (moved forward by each token rotation, so at most a minute behind), and a **This device** badge on the session of the request. Every stored value is escaped.
2. `POST /dashboard/account/sessions/:id/revoke` (`memberGuard`; the session guard refuses a cross-origin POST with `403`) signs out one session. The delete is scoped to the account in SQL, so another account's session id, or an unknown one, changes nothing: the page comes back with `404` and `That session was not found: nothing was changed.` (logged at `warn` as `Session revoke refused: not one of the user's sessions`). Another of the account's sessions: back to the page with `Signed out that device.`; its cookie stops working at once. The current session: this browser is signed out (cookie cleared, `302` to the login page). Logged at `warn` as `Session revoked by its user` (`userId`, the revoked `sessionId`, `currentSessionId`, `current`, `ip`).
3. `POST /dashboard/account/sessions/revoke-others` (`memberGuard`, same-origin) signs out every session of the account except the current one (their token history goes with them) and comes back with `Signed out N other devices.` Logged at `warn` as `Other sessions revoked by their user` (`userId`, the kept `sessionId`, `sessionsRevoked`, `ip`).

**Approximate location** is off by default. With `GEOIP_DB_PATH` (an offline DB-IP Lite or GeoLite2 `.mmdb` file) or the opt-in online provider (`GEOIP_PROVIDER=ipinfo` with `GEOIP_API_TOKEN`, which sends every sign-in IP to ipinfo.io), the location of a new session's IP is looked up once, in the background, after the session is created (login, owner setup, invitation accept, password reset, password change), and stored on the session; it never delays or fails a sign-in. Setup: [docs/self-hosting.md](self-hosting.md#approximate-session-locations-geoip-281).

**Sidebar by role.** Members do not see links to admin-only pages: the Users entry (and the Invitations link on the home page) are shown to admins and the owner only. API Keys is a member page since #219 (a member's own keys). The session guard records the viewer's role in a request-scoped holder (`src/pages/viewer.ts`, keyed on the request's log context, never added to log lines), which the sidebar reads; when the role is unknown the links are hidden (fail closed). Display only: every route checks the role itself.

### New-device alerts (#282)

A successful `POST /dashboard/login` sets `bm_device` (32 random bytes as base64url; `HttpOnly; SameSite=Lax; Path=/dashboard`, `Secure` in production, `Max-Age` 400 days): the browser's own value when it sent a well-formed one, a new one otherwise (a malformed or oversized value counts as absent). It is set again at every sign-in, which refreshes it, and logout leaves it. It is not a credential: no route accepts it for anything, it only lets the login recognize a browser that signed in before. Then, in the background (the response does not wait and the login never fails because of it):

1. The browser is recorded for the account in `user_devices` (only the cookie's SHA-256, the device label, IP and approximate location).
2. Seen by this account within the last 30 days: nothing more. The account's first browser ever: recorded without an alert.
3. Otherwise (new to the account, or not seen for over 30 days): "New sign-in to your BunMail account" goes to the account's address from `SYSTEM_MAIL_FROM` (DKIM-signed), with the masked address, browser and OS, IP, approximate location when known, the time (UTC) and what to do (sign in, **Account > Active sessions > Sign out all other devices**, change the password, tell an administrator). The email contains **no links** at all. Without a usable `SYSTEM_MAIL_FROM` nothing is sent and the event is logged (`New-device sign-in`, `info`).

For an account with two-factor authentication (#220) all of this happens at the second step (`POST /dashboard/login/two-factor`), once the code is accepted: the password alone sets no `bm_device` cookie and sends no alert.

Owner setup, invitation accept, password reset and password change never send this alert. Internals and log lines: [docs/users.md](users.md#new-device-alerts-282).

### Two-factor authentication (#220)

Every account, the owner included, can protect its sign-in with a time-based code (TOTP, RFC 6238: 6 digits, 30 seconds, SHA-1) from an authenticator app, at **Two-factor** (`/dashboard/account/two-factor`, in the Account group of the sidebar). Internals: [docs/users.md](users.md#two-factor-authentication-220).

**Turning it on** (all `memberGuard`, own account only; the session guard refuses cross-origin `POST`s):

1. `GET /dashboard/account/two-factor` (`no-store`) shows the state: off (a **Set up** button), an enrolment in progress, or on (since when, recovery codes left, with a warning at 3 or fewer).
2. `POST /dashboard/account/two-factor/start` (form field `password`): the **current password** first, so a stolen session cookie alone cannot turn 2FA on (which would sign the owner's other devices out and lock the account behind a code only the thief has). It uses the password change's budget (`password:user:<userId>`, `password:ip:<client IP>`, `DASHBOARD_LOGIN_RATE_LIMIT_*`): over budget `Too many attempts. Try again later.` before any argon2id work, then exactly one argon2id verify; a wrong password gets `Current password is incorrect.` and nothing is written (`warn` `Two-factor enrolment start refused` with `reason`). Then a new random secret (20 bytes), kept encrypted on this session until confirmed (only this step writes it, so confirming cannot happen without a start that passed the password); `302` back to the page, which shows a QR code (inline SVG drawn on the server, no script, no image request) and the key in groups of four for typing in by hand. The `otpauth://` URI is never written into the page, a URL or a log. Starting again replaces the secret. `info` log `Two-factor enrolment started`.
3. `POST /dashboard/account/two-factor/confirm` (form field `code`): the first code from the app. Wrong: back to the page with `Invalid code. Try again.` (the enrolment stays). Right, in one transaction: the second factor is stored, ten recovery codes are created, **every other session of the account is signed out**, and this one counts as verified with a second factor (`mfa`). The page then shows the recovery codes **once** (one-time reveal bound to this user and session, kind `recovery_codes`, 60 seconds, #280). `warn` log `Two-factor authentication enabled` (`userId`, `sessionId`, `sessionsRevoked`, `ip`). The account is emailed (see **Security emails** below).

**Signing in** with it on:

1. `POST /dashboard/login` with the right password opens a `pending` session (10 minutes) and redirects to `/dashboard/login/two-factor` (see [Auth Flow](#auth-flow) step 8).
2. `GET /dashboard/login/two-factor` (public, auth-page headers) shows the code form when the browser holds a pending session; anything else goes to `/dashboard`, where the guard decides.
3. `POST /dashboard/login/two-factor` (form field `code`): same-origin first (`403`), then the pending session (none: `302` to `/dashboard`, cookie untouched, so a double click cannot sign out the winner). The field takes the 6-digit code or a recovery code (case, spaces and dashes ignored). Then the failed-attempt budget (below), then, in one transaction, the code is checked and spent and the session becomes `mfa` with a **new token** (the pending token stops working at once). Success: `302` to `/dashboard`, `info` log `Dashboard login successful` with `method` (`totp` or `recovery_code`); a recovery code adds `warn` `Recovery code used` with `recoveryCodesLeft`. Then the `bm_device` cookie, the new-device check (#282) and the location lookup (#281), as for a password-only sign-in. A wrong code: the form again with `Invalid code. Try again.` (`warn` `Two-factor sign-in failed: invalid code`). **Cancel and use another account** signs the pending session out (`POST /dashboard/logout`).
4. **Replay protection:** a code is accepted only once. Its time step must be newer than the last accepted one (window: the current step and one either side), and the new step is stored by a compare-and-swap in the same transaction, so even two simultaneous submissions of one code cannot both pass.

**Failed-attempt budgets.** Every check of a code is budgeted with fixed numbers, **5 failures per 15 minutes** per key (`TWO_FACTOR_MAX_FAILURES`, `TWO_FACTOR_WINDOW_SECONDS`), **always on**, whatever `DASHBOARD_LOGIN_RATE_LIMIT_*` says (a 6-digit code needs a budget). The attempt is counted before the code is checked, so a parallel burst checks at most the budget. Two budgets, so neither can be spent to block the other:

- **The second login step**: `totp:user:<userId>` and `totp:ip:<client IP>` (IPv6 by `/64`). Once spent the pending session is revoked and the browser goes back to the login page (`/dashboard/login?error=two_factor_locked`: `Too many invalid codes. Wait a few minutes, then sign in again.`; `warn` `Two-factor sign-in blocked: too many attempts, pending session revoked`); the account stays blocked until the window ends, from any address. The account key is reached only through this step, which needs the password, so blocking it costs an attacker the password first; when it runs out the account is emailed (once per window, see below). A success clears the account key and gives back its own count on the address key.
- **Checks inside a session** (turning 2FA off, new recovery codes): `totp:session:<sessionId>` and the same address key, **never** the account key, so a stolen session cannot lock the real user's sign-in. Wrong codes and, on the disable form, wrong passwords count. Once the session's own key is spent the session is **revoked** (`warn` `Two-factor code budget spent in a session: session revoked`, with `action`) and the browser goes to the login page.

**Recovery codes.** Ten codes (`xxxx-xxxx-xxxx-xxxx`, 80 random bits each), each works once in place of a code from the app. `POST /dashboard/account/two-factor/recovery-codes` (form field `code`, a code **from the app**, not a recovery code) replaces all of them with ten new ones, shown once (`warn` `Recovery codes regenerated`); the account is emailed.

**Turning it off.** `POST /dashboard/account/two-factor/disable` (form fields `password`, `code`): on an account without 2FA the answer is `Two-factor authentication is off.` at once, before any password work, so the form never says whether a password is right. Otherwise the current password **and** a code (from the app, or a recovery code), under the session's budget; a wrong one gets `The password or the code is incorrect.` The second factor and every recovery code are deleted; sessions are kept. `warn` `Two-factor authentication disabled` (with `method`); the account is emailed. Under `REQUIRE_2FA` the account is then sent back to the page until it enrols again.

**Lost authenticator.** Use a recovery code. Without one: an admin (or the owner) issues a password reset link (#277) for the account, which removes its two-factor authentication when completed; the owner runs `reset-owner`, whose link does the same when completed (issuing it changes nothing). A password change keeps 2FA, and an ownership transfer keeps both accounts' 2FA.

**Security emails.** Like the new-device alert (#282): from `SYSTEM_MAIL_FROM`, DKIM-signed, never unsigned, **no links**, in the background (never delays or fails the action), each with the masked address, the IP and the time (UTC) and the advice to change the password, check Two-factor and sign out other devices. Sent when 2FA is turned on, turned off, when the recovery codes are replaced, when a completed reset link or `reset-owner` link removed it, and when the second login step's account budget runs out (password right, codes failing: a likely password compromise; at most once per account per 15 minutes, per replica). Logged `warn` `Two-factor security alert sent` (redacted address) or `Two-factor security alert not sent` (`info` with `reason: not_configured` when `SYSTEM_MAIL_FROM` is unset, `warn` otherwise), always with `event` and `userId`.

**Policy.** `REQUIRE_2FA` (`none` by default, `owner`, or `admin` for admins and the owner) holds an account it covers on its Two-factor page until it enrols (see the guard above); the page says `Your role requires two-factor authentication`. It applies to every session of such an account, including those opened by owner setup, invitation accept and a password reset.

### Audit log (#221)

`GET /dashboard/audit-log`, **Audit log** in the sidebar (admins and the owner; `adminGuard`, a member gets the 403 page and no sidebar link). Security-relevant actions, newest first: time (UTC), actor (an account's email, an API key's name, or BunMail itself for the boot, `reset-owner`, token reuse detection and the retention purge), action, target, outcome (`success`/`failure`) and client (IP and user agent). Filters by action, actor and outcome (unknown values are ignored); 50 per page. Read-only and `Cache-Control: no-store`; every value is escaped. What is recorded, how, and the append-only trigger: [docs/audit-log.md](audit-log.md).

Recorded from the dashboard: sign-in (success, each failure with its reason, a lockout once per address and window, the 2FA step and its lock), sign-out, session revocations and token reuse, two-factor changes, password change, reset links issued and completed, owner setup, invitations, role changes, deactivation, reactivation, removal, ownership transfer (and a wrong-password attempt), API key, domain, webhook and suppression changes. The REST API records its API key, domain, webhook and suppression changes with the calling key as the actor.

### Brute-force protection (#109)

`POST /dashboard/login` throttles failed logins per client IP using
an in-memory sliding window (`src/middleware/login-rate-limit.ts`). Every kind
of failure counts (unknown email, no password, disabled account, wrong
password, over-long input), and the check runs before any database or argon2id
work. After `DASHBOARD_LOGIN_RATE_LIMIT_MAX` failures within
`DASHBOARD_LOGIN_RATE_LIMIT_WINDOW` seconds, further attempts from that IP get
HTTP `429` with a `Retry-After` header until the window expires. A successful
login gives back only its own attempt; earlier failures from the address stay
until the window ends (#256), so signing in to an account of one's own does
not buy more guesses at another. IPv6 clients are counted per `/64` (a client
usually controls a whole `/64`), and an IPv4-mapped address counts as its IPv4.
There is no per-account lockout (it would let anyone lock the owner out) and
no global budget across addresses (it would let anyone lock everyone out);
guessing across many IPs is slowed only by argon2id and the 15-character
password minimum.
The same settings budget the current-password checks of the ownership transfer
(#218), of the password change (#279) and of the 2FA enrolment start (#220),
under keys of their own (`transfer:` and `password:`, per account and per
client IP), so a stolen session cannot guess faster than a login could. Both
numbers are validated at boot (1 to 100 attempts, 60 to 86400 seconds; anything
else refuses to start). Two-factor code checks (#220, `totp:`) have a fixed
budget of their own, 5 per 15 minutes, always on (see
[Two-factor authentication](#two-factor-authentication-220)).

The client IP is resolved by counting `DASHBOARD_TRUSTED_PROXY_HOPS` entries from
the **right** of `X-Forwarded-For` (the leftmost entry is attacker-controlled and
never trusted). With the default `0`, the header is ignored and the raw socket IP
is used. Behind a reverse proxy set it to the number of trusted hops (`1` for a
single proxy) so lockouts are per-attacker rather than shared across the proxy's
IP, and make sure the origin can only be reached **through** the proxy, or
`X-Forwarded-For` can't be trusted. When a request carries fewer
`X-Forwarded-For` entries than the configured hops, BunMail logs `Request
bypassed the trusted proxy` (at most once an hour, #256): the app is reachable
directly, so bind its port to `127.0.0.1` or firewall it. State is in-memory and
per-replica.

## Pages

| Route                            | Description                                                       |
|----------------------------------|-------------------------------------------------------------------|
| GET /dashboard/login             | Email + password login form (standalone, no nav, #216)            |
| GET /dashboard/login/two-factor  | Second login step: the authenticator or recovery code (standalone, public, needs a pending session, #220) |
| GET /dashboard/assets/dashboard.css | Self-hosted stylesheet, public, cached 1 year (#255)              |
| GET /dashboard/assets/dashboard.js  | Dashboard script, public, cached 1 year (#255)                    |
| GET /dashboard/setup             | Owner setup form from the one-time link (standalone, public, #215) |
| GET /dashboard/invite            | Invitation accept form from the invitation link (standalone, public, #217) |
| GET /dashboard/reset             | Password reset form from an admin-issued link (standalone, public, #277) |
| GET /dashboard                   | Stats overview: outbound, inbound, configuration sections; for admins and the owner, a **Server identity** card (#248): each sending IP (`MAIL_PUBLIC_IP` or the A/AAAA records of `MAIL_HOSTNAME`) with whether its PTR names `MAIL_HOSTNAME` and resolves back. The result comes from the boot check and refreshes in the background every 10 minutes, so the page never waits on DNS |
| GET /dashboard/account/password  | Change your own password; signs out every other session (any role, #279) |
| GET /dashboard/account/sessions  | Your own live sessions: device, IP, approximate location, signed in, last active, this device marked; sign out one or all others (any role, #281) |
| GET /dashboard/account/two-factor | Your own two-factor authentication: set up (QR code and key), recovery codes left, new recovery codes, turn off; recovery codes shown once (any role, #220) |
| GET /dashboard/send              | Compose & send emails from dashboard; the key picker lists every active key (admins, owner) or the member's own active keys (#219) |
| GET /dashboard/emails            | Email logs with status tabs (All / Queued / Sending / Sent / Failed / Bounced) + **Source** (API / SMTP) and **API-key** dropdown filters (#137), a per-row source badge, bulk-select, per-row trash. Filters compose and are preserved across pagination. |
| GET /dashboard/emails/trash      | Trashed emails: bulk Restore / Delete-forever / Empty trash      |
| GET /dashboard/emails/:id        | Single email detail + preview (Restore/Delete-forever if trashed) |
| GET /dashboard/emails/tombstones | Post-purge audit snapshots with a Message-ID search (#34)        |
| GET /dashboard/api-keys          | API keys list + create form: every key with its creator and why it is disabled (admins, owner), or the member's own keys (#219) |
| GET /dashboard/invitations       | Pending invitations + invite form, one-time link reveal (admin, #217) |
| GET /dashboard/users             | Every account, role and status, with the actions the viewer may take, one-time reset link reveal (admin, #218, #277) |
| GET /dashboard/audit-log         | Security-relevant actions (sign-ins, account, 2FA, API key, domain, webhook, suppression changes), filter by action, actor and outcome; read-only (admin, #221) |
| GET /dashboard/domains           | Domains list (with who added each, #219) + add form               |
| GET /dashboard/domains/:id       | Domain detail + DNS status                                        |
| GET /dashboard/templates         | Templates list (with creators, #219) + create form (live HTML preview) |
| GET /dashboard/templates/:id     | Template detail + edit form (live HTML preview); read-only for a member on someone else's template (#219) |
| GET /dashboard/webhooks          | Webhooks list (with creators, #219) + create form                 |
| GET /dashboard/webhooks/:id/deliveries | Delivery history of one webhook, filter by status (#30)     |
| GET /dashboard/webhooks/deliveries/:deliveryId | Delivery detail: payload, last response, Replay (#30) |
| GET /dashboard/inbound           | Inbound emails list: bulk-select, per-row trash                  |
| GET /dashboard/inbound/trash     | Trashed inbound: bulk Restore / Delete-forever / Empty trash     |
| GET /dashboard/inbound/:id       | Inbound email detail + HTML preview                               |
| GET /dashboard/inbound/:id/reply | Send form pre-filled as a reply (#86)                             |
| GET /dashboard/dmarc-reports     | DMARC aggregate reports list + domain filter (#41)                |
| GET /dashboard/dmarc-reports/:id | DMARC report detail, per source IP (#41)                          |
| GET /dashboard/suppressions      | Suppressions across every API key (#89)                           |

## Security headers (#255)

Every response (dashboard, landing page, API, error pages) carries a `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and `Referrer-Policy: same-origin` (`src/middleware/security-headers.ts`, applied in `onRequest`). Every `/dashboard` response is `Cache-Control: no-store` (except the static assets below). `Strict-Transport-Security: max-age=31536000` is added when `APP_BASE_URL` is `https://`. The public auth pages still set `Referrer-Policy: strict-origin` themselves.

The CSP depends on the path:

| Where | Policy |
|-------|--------|
| `/`, `/dashboard`, `/dashboard/...`, and the HTML 404 page on any path | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` |
| Everything else (API, `/api/docs`, `/health`, `/favicon.svg`) | `object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` |

`script-src 'self'` with no `'unsafe-inline'`: the pages load no third-party code and carry no inline script or `on*=` attribute (#255, part 2), so an injected script does not run. `style-src` keeps `'unsafe-inline'` because the email preview is a `srcdoc` iframe, which inherits the page's policy, and email HTML relies on inline styles; `img-src https: data:` keeps remote images in previews working. A previewed email's plain `http:` images, remote fonts and remote stylesheets no longer load. The OpenAPI reference at `/api/docs` (Scalar, from a CDN with inline scripts) keeps the baseline policy.

## Assets and scripts (#255)

The pages load exactly two files, both served by BunMail (`src/pages/static-assets.tsx`) and linked from every page's `<head>` with a content hash (`?v=<12 hex>`, computed at startup), so they are cached for a year (`Cache-Control: public, max-age=31536000, immutable`) and a deploy reaches every browser at once:

- **`/dashboard/assets/dashboard.css`**: built by the Tailwind v4 CLI from `src/pages/assets/dashboard.input.css` (`bun run build:css`). It is a build artefact: gitignored, built by `bun run dev` before the server starts and by the Docker image (`css` stage). While it is missing the server logs `Dashboard asset missing` once, answers 404 for it and the pages render unstyled. In development the files are re-read on every page, so `bun run dev:css` (the Tailwind watcher, in a second terminal) shows new classes on the next reload.
- **`/dashboard/assets/dashboard.js`**: hand-written browser JavaScript, served as committed. It is loaded synchronously in `<head>` so the dark theme is applied before the first paint; everything else waits for `DOMContentLoaded`. Markup asks for behaviour with attributes, never with inline code:

| Attribute | Behaviour |
|-----------|-----------|
| `data-action="toggle-theme"` | Switch light / dark, remembered in `localStorage('bm-theme')` |
| `data-confirm="..."` | On a button or link: confirm before the click; on a form: confirm before it submits |
| `data-navigate-on-change` | On a `<select>`: open the URL of the chosen option (email filters) |
| `data-submit-once` | On `<body>` (dashboard layout): a submitted form's button is disabled with "Processing…" |
| `data-bulk`, `data-bulk-all`, `data-bulk-row`, `data-bulk-bar`, `data-bulk-count` | Bulk selection: select-all, row boxes, the action bar and its count |
| `data-chip-input` | Email chip input (`email-chip-input.tsx`) |
| `time[data-bm-time]` | Timestamp in the viewer's locale and timezone (`time-display.tsx`) |
| `iframe.html-preview-frame`, `iframe.live-html-preview-frame` | Email / template previews: theme sync and auto height; the live preview reads its style block and sample values from a `<script type="application/json" id="bm-live-preview-data">` data block |

Server data a script needs goes in a `data-*` attribute or a JSON data block, never in code. `bun run lint:xss` fails on any `on*=` attribute, inline `<script>` or Tailwind CDN reference under `src/pages`.

## Design System

- **CSS:** Tailwind CSS v4, built to a self-hosted `dashboard.css` (see Assets and scripts). The source keeps the v3 look the pages were written for: the v4 upgrade guide's compatibility base styles (gray-200 default borders, gray-400 placeholders, pointer cursor on buttons), v3's colour palette and sans-serif stack, and v3's `dark:` selector. Use v4 class names (`outline-hidden`, `shrink-0`, `border-red-500!`). Tailwind v4 needs Safari 16.4+, Chrome 111+ or Firefox 128+.
- **Dark mode:** Class-based (`@custom-variant dark (&:is(.dark *))`, v3's `darkMode: 'class'` selector), stored in `localStorage('bm-theme')`
- **Color palette:** Neutral grays: `gray-50` to `gray-950`
- **Cards:** `bg-white dark:bg-gray-900` with subtle borders
- **Status badges:** Muted colors (emerald for sent, amber for queued, blue for sending, red for failed)

## File Structure

```
src/pages/
├── pages.plugin.tsx          ← Parent plugin: public routes, then the session guard, then the area plugins (#291)
├── plugins/                  ← One functional plugin per area, each with only its routes (#291)
│   ├── auth.plugin.tsx       ← Public: login (both steps, #220), logout, owner setup, invitation accept, password reset
│   ├── home.plugin.tsx       ← Stats overview
│   ├── account.plugin.tsx    ← The signed-in user's own account: active sessions (#281), change password (#279), two-factor (#220)
│   ├── emails.plugin.tsx     ← Send form, email list, trash, tombstones, detail
│   ├── api-keys.plugin.tsx   ← API keys
│   ├── invitations.plugin.tsx ← Invitations
│   ├── users.plugin.tsx      ← Accounts: role, status, removal, ownership transfer, reset link
│   ├── audit-log.plugin.tsx  ← Audit log page (#221)
│   ├── domains.plugin.tsx    ← Domains, DNS verify (with its throttle), detail
│   ├── templates.plugin.tsx  ← Templates
│   ├── webhooks.plugin.tsx   ← Webhooks, deliveries, replay
│   ├── inbound.plugin.tsx    ← Inbound list, trash, detail, reply
│   ├── dmarc.plugin.tsx      ← DMARC reports
│   └── suppressions.plugin.tsx ← Suppressions
├── lib/                      ← Helpers shared by the area plugins (#291)
│   ├── session-guard.ts      ← The session guard (`resolve` putting `auth` on the context) and the `PublicDashboard` / `GuardedDashboard` types
│   ├── session-helpers.ts    ← Issue / clear the session cookie, token-reuse revoke
│   ├── same-origin.ts        ← CSRF same-origin check
│   ├── responses.ts          ← `redirect`, `setNoStore`, `toFlash`
│   ├── record-ownership.ts   ← Record actor, "Created by" names (#219)
│   ├── audit.ts              ← Audit context (user, IP, user agent) of a dashboard request (#221)
│   ├── reveal-owner.ts       ← Owner a one-time reveal is bound to (#280)
│   ├── two-factor-limiter.ts ← Failed-attempt budget of every two-factor code check (#220)
│   ├── error-message.ts      ← Error text for a log line
│   └── form.ts               ← Repeated form field to `string[]`
├── guards.tsx                ← Role and assurance checks per route (#222)
├── reveal-store.ts           ← One-time secret reveal (API keys, webhook secrets, invitation and password reset links, recovery codes), bound to kind, user and session (#132, #280, #217, #277, #220)
├── session.ts                ← Session cookie read/set/clear (pure, unit-tested; sessions live in the users module)
├── viewer.ts                 ← Request-scoped viewer role for the sidebar (#218)
├── landing.plugin.tsx        ← Public landing page at /
├── static-assets.tsx         ← Serves dashboard.css / dashboard.js, content-hash URLs, 1-year cache (#255)
├── assets/
│   ├── dashboard.input.css   ← Tailwind v4 source of dashboard.css (`bun run build:css`, output gitignored)
│   ├── dashboard.js          ← The only script every page loads (#255)
│   └── icons.tsx             ← Inline SVG icons
├── layouts/
│   └── base.tsx              ← HTML shell, self-hosted CSS + JS, sidebar nav (admin-only links by viewer role; the Account group, Active sessions, Change password and Two-factor, for every role)
├── routes/
│   ├── login.tsx             ← Email + password login page (#216)
│   ├── login-two-factor.tsx  ← Second login step: the code form (#220)
│   ├── setup.tsx             ← Owner setup form and invalid-link page (#215); its shell is shared with invite.tsx and reset.tsx
│   ├── invite.tsx            ← Invitation accept form, invalid-link and account-exists pages (#217)
│   ├── invitations.tsx       ← Invitations page: invite form, pending list, one-time link (#217)
│   ├── users.tsx             ← Users page: accounts, role change, deactivate, remove, transfer (#218), reset link (#277)
│   ├── audit-log.tsx         ← Audit log page: events table, filters (#221)
│   ├── reset.tsx             ← Password reset form and invalid-link page (#277)
│   ├── account-password.tsx  ← Change password form for the signed-in user (#279)
│   ├── account-sessions.tsx  ← Active sessions page for the signed-in user (#281)
│   ├── account-two-factor.tsx ← Two-factor page for the signed-in user: QR code, recovery codes, disable (#220)
│   ├── home.tsx              ← Stats cards grid
│   ├── landing.tsx           ← Public marketing landing page
│   ├── not-found.tsx         ← Custom 404 page
│   ├── forbidden.tsx         ← 403 page for a role or session assurance too low (#222)
│   ├── send-email.tsx        ← Compose & send email form
│   ├── emails.tsx            ← Email table with filters
│   ├── email-detail.tsx      ← Email detail view
│   ├── api-keys.tsx          ← API keys management
│   ├── domains.tsx           ← Domains management
│   ├── domain-detail.tsx     ← Domain verification status
│   ├── templates.tsx         ← Templates list + create
│   ├── template-detail.tsx   ← Template edit form
│   ├── webhooks.tsx          ← Webhooks list + create
│   ├── inbound.tsx           ← Inbound emails list (bulk-select + trash)
│   ├── inbound-detail.tsx    ← Inbound email detail + preview
│   ├── inbound-trash.tsx     ← Trashed inbound (Restore / Delete-forever / Empty)
│   ├── emails-trash.tsx      ← Trashed outbound (Restore / Delete-forever / Empty)
│   ├── email-tombstones.tsx  ← Post-purge audit snapshots + Message-ID search (#34)
│   ├── webhook-deliveries.tsx ← Delivery history of one webhook (#30)
│   ├── webhook-delivery-detail.tsx ← Delivery detail + replay (#30)
│   ├── suppressions.tsx      ← Suppressions across every API key (#89)
│   ├── dmarc-reports.tsx     ← DMARC reports list + domain filter (#41)
│   └── dmarc-report-detail.tsx ← DMARC report detail (#41)
└── components/
    ├── stats-card.tsx        ← Metric display card
    ├── status-badge.tsx      ← Status + verification badges
    ├── pagination.tsx        ← Page navigation
    ├── flash-message.tsx     ← Success/error banners
    ├── empty-state.tsx       ← Empty table placeholder
    ├── qr-code.tsx           ← QR code as inline SVG, drawn on the server from the `uqr` module matrix (#220)
    └── time-display.tsx      ← <TimeDisplay> + hydration script (#104)
```

## Timestamps

Every timestamp on the dashboard goes through `<TimeDisplay value={date} />`
([src/pages/components/time-display.tsx](../src/pages/components/time-display.tsx)).
The server renders a `<time datetime>` element with a static UTC fallback;
a single hydration script in `BaseLayout` rewrites every such element on
load with relative-time text (`5m ago`, `Yesterday 14:32`, `Jan 5, 14:32`,
`Jan 5, 2024, 14:32`) in the **viewer's browser locale + timezone**.

The full absolute timestamp is always available via the `title` tooltip.
The component intentionally exposes no date-only format: the dashboard
never shows a bare date; every rendered value carries date and time.

When adding a new dashboard route that displays a timestamp:

```tsx
import { TimeDisplay } from "../components/time-display.tsx";

<TimeDisplay value={row.createdAt} />               // most cases
<TimeDisplay value={key.lastUsedAt} fallback="Never" />  // null-safe
```

Do not call `toLocaleString()` / `toLocaleDateString()` / `toISOString()`
directly in JSX: those run on the server and bake in the server's tz/locale.

## Form Actions

Dashboard uses standard HTML forms with POST actions. After each action the user is redirected back with a flash message in query params. A small client-side script (in the list pages) tracks checkbox state and toggles the bulk action bar visibility.

**General**
- Send email → `POST /dashboard/send` (a member may submit only its own key's id; any other is refused with an error flash and nothing is sent, #219). The success flash names the sender domain's DNS records that are not verified (DKIM, SPF, DMARC) or says the domain is unregistered (development), #245; a send refused on its sender domain or subject shows the reason as an error flash
- Create API key → `POST /dashboard/api-keys` (form fields: `name`, `allowedSenders`, `isAdmin`; `isAdmin` is ignored for members, #219)
- Promote / demote API key → `POST /dashboard/api-keys/:id/admin` (admins and the owner)
- Set allowed senders → `POST /dashboard/api-keys/:id/senders`
- Revoke API key → `POST /dashboard/api-keys/:id/revoke`
- Invite an address → `POST /dashboard/invitations` (form fields: `email`, `role`)
- Revoke invitation → `POST /dashboard/invitations/:id/revoke`
- Resend invitation → `POST /dashboard/invitations/:id/resend`
- Change an account's role → `POST /dashboard/users/:id/role` (form field: `role`)
- Deactivate / reactivate an account → `POST /dashboard/users/:id/deactivate`, `POST /dashboard/users/:id/reactivate`
- Remove an account → `POST /dashboard/users/:id/remove` (form field: `confirm`, the account's email)
- Transfer ownership → `POST /dashboard/users/:id/transfer` (form field: `password`, the owner's)
- Issue a password reset link → `POST /dashboard/users/:id/reset-password`
- Reset a password → `POST /dashboard/reset` (public; form fields: `token`, `password`, `confirm`)
- Change your own password → `POST /dashboard/account/password` (any role; form fields: `current`, `password`, `confirm`; signs out every other session, #279)
- Sign out one of your sessions → `POST /dashboard/account/sessions/:id/revoke` (any role, own sessions only; the current one signs this browser out, #281)
- Sign out all your other sessions → `POST /dashboard/account/sessions/revoke-others` (any role, #281)
- Start two-factor setup → `POST /dashboard/account/two-factor/start` (any role; form field: `password`, the current one, #220)
- Turn two-factor on → `POST /dashboard/account/two-factor/confirm` (form field: `code`; signs out every other session, #220)
- New recovery codes → `POST /dashboard/account/two-factor/recovery-codes` (form field: `code`, from the app, #220)
- Turn two-factor off → `POST /dashboard/account/two-factor/disable` (form fields: `password`, `code`, #220)
- Second login step → `POST /dashboard/login/two-factor` (public, needs a pending session; form field: `code`, #220)
- Accept invitation → `POST /dashboard/invite` (public; form fields: `token`, `name`, `password`, `confirm`)
- Add domain → `POST /dashboard/domains`
- Delete domain → `POST /dashboard/domains/:id/delete` (hard delete; emails detach via `ON DELETE SET NULL`)
- Verify domain DNS → `POST /dashboard/domains/:id/verify`
- Set or clear the inbound notification address → `POST /dashboard/domains/:id/notify-email` (#106)
- Set or clear the List-Unsubscribe overrides → `POST /dashboard/domains/:id/unsubscribe` (#243)
- Create template → `POST /dashboard/templates`
- Edit template → `POST /dashboard/templates/:id/edit`
- Delete template → `POST /dashboard/templates/:id/delete`
- Create webhook → `POST /dashboard/webhooks`
- Delete webhook → `POST /dashboard/webhooks/:id/delete`
- Replay a webhook delivery → `POST /dashboard/webhooks/deliveries/:deliveryId/replay`
- Remove a suppression → `POST /dashboard/suppressions/:id/delete`

**Email trash**
- Move email to trash → `POST /dashboard/emails/:id/trash`
- Bulk move to trash → `POST /dashboard/emails/bulk-trash` (form fields: `ids`)
- Restore → `POST /dashboard/emails/:id/restore`
- Permanently delete → `POST /dashboard/emails/:id/permanent`
- Bulk restore → `POST /dashboard/emails/trash/bulk-restore` (uses `formaction` from the trash bar)
- Bulk permanent delete → `POST /dashboard/emails/trash/bulk-permanent`
- Empty trash → `POST /dashboard/emails/trash/empty`

**Inbound trash**: same shape under `/dashboard/inbound/...`.
