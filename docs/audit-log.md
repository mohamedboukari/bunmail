# Audit log (#221)

A record of security-relevant actions, for the owner and admins: who did what, when, to what, from which IP, and whether it worked. Sign-ins (success and failure), sign-outs, session revocations, two-factor changes, password changes and resets, owner setup links, invitations, role changes, deactivations, removals, ownership transfers, and API key, domain, webhook and suppression changes, from the dashboard and from the REST API.

It is read on the **Audit log** page (`GET /dashboard/audit-log`, admins and the owner). There is no REST endpoint.

## Module layout

```
src/modules/audit/
  ├── errors.ts                         ← AuditStoreError (SQLSTATE only, never query params)
  ├── models/audit-event.schema.ts      ← the audit_events table
  ├── services/audit.service.ts         ← recordAuditEvent, listAuditEvents, listAuditActors, purgeOldAuditEvents
  ├── services/audit-context.service.ts ← who and from where: requestAuditClient, userAuditContext, restAuditContext
  └── types/audit.types.ts              ← actions, per-action metadata, labels, actor and target types
```

Dashboard side: `src/pages/plugins/audit-log.plugin.tsx` (the route), `src/pages/routes/audit-log.tsx` (the page), `src/pages/lib/audit.ts` (the audit context of a dashboard request). The retention sweep runs in `src/modules/trash/services/purge.service.ts` (`runAuditRetention`).

## Schema: `audit_events`

| Column | Type | Notes |
|---|---|---|
| `id` | varchar(36) PK | `aud_` + 24 hex |
| `occurred_at` | timestamptz, default `now()` | database clock |
| `actor_type` | varchar(10), CHECK | `user`, `api_key` or `system` |
| `actor_id` | text, nullable | `usr_` or `key_` id; null for `system`, and for a sign-in attempt whose email matched no account |
| `actor_label` | text, nullable | snapshot: the user's email or the key's name at the time; for `system`, what ran (`boot`, `reset-owner`, `session guard`, `retention purge`) |
| `action` | varchar(64) | see [Actions](#actions); a code-level union, not a CHECK, so a new action needs no migration |
| `outcome` | varchar(10), CHECK | `success` or `failure` |
| `target_type`, `target_id`, `target_label` | nullable | what the action touched (`user`, `session`, `invitation`, `api_key`, `domain`, `webhook`, `suppression`, `audit_log`) and a label snapshot |
| `ip` | text, nullable | the client IP, resolved like the login limiter (`DASHBOARD_TRUSTED_PROXY_HOPS`); stored only when it is an IP literal |
| `user_agent` | text, nullable | the `User-Agent`, cut to 256 characters |
| `metadata` | jsonb, nullable | small typed details per action (below); stored as real JSON (`src/db/jsonb.ts`) |

Indexes: `(occurred_at DESC, id DESC)` (the page and the purge), `(action, occurred_at DESC)`, `(actor_id, occurred_at DESC)`.

**No foreign keys.** Actor and target are snapshots: deleting a user, an API key or a domain never deletes, blocks or rewrites its history. A label left out by the caller is read from the live row in the same `INSERT` (users: email, API keys: name, domains: name); a deleted row's label is passed explicitly (a removed account keeps its email in `target_label`).

**Append-only.** The application inserts and, for retention only, deletes. Migration `0028` adds a statement-level trigger, `audit_events_no_update`, that raises `audit_events is append-only: UPDATE is not allowed` (SQLSTATE `42501`) on any `UPDATE` of the table, from any connection: a bug or an injected query through the application cannot rewrite an entry. `DELETE` stays allowed for the retention purge. A database superuser (or the table owner, who can drop the trigger) can still alter or delete rows; nothing is shipped off the host.

## Writing events

```ts
recordAuditEvent(input, tx?)
```

- **With `tx`** (the change already runs in a transaction): the row is inserted in that transaction, so the change and its record commit or roll back together. A failed insert throws `AuditStoreError` and the change rolls back with it. Used by owner setup and `reset-owner`, invitations (create, resend, revoke, accept), every account action of the Users page (role, deactivate, reactivate, remove, transfer, reset link), password reset completion, password change, and two-factor enable, disable and recovery code regeneration.
- **Without** (sign-in, sign-out, session revocation, token reuse, API key, domain, webhook and suppression changes, which are single statements): the row is inserted right after the outcome is decided. A failure is logged at `error` (`Audit event not recorded`, with the action, the actor and target ids and the SQLSTATE: never a label or the user agent) and never reaches the user's request.

`input` is typed per action (`AuditEventInput<A>`): `metadata` is required exactly when the action declares a shape, and can only carry that shape's fields. As a last line of defence, a metadata key that looks like a secret (`password`, `secret`, `token`, `hash`, `cookie`, `credential`, `private`, `code`) is dropped with a `warn`. Metadata never carries passwords, tokens or their hashes, API keys, TOTP or recovery codes, webhook secrets or URLs (a webhook is labelled by its origin only: Slack- and Discord-style URLs carry the credential in the path), or message content.

**Unknown accounts.** A failed sign-in whose email matches no account is stored with `actor_type = user`, no `actor_id`, no label, and `metadata.reason = unknown_account`: the typed address is never stored. A failed sign-in on an existing account names that account.

**Floods.** Every counted failed sign-in is recorded (each costs an argon2id verify and is already capped per IP by the login limiter); a refused attempt while an address is locked out is recorded once per address and window (`shouldAuditLockout` in `login-rate-limit.ts`, which reuses the limiter's own entry), so a flood from one address writes at most `DASHBOARD_LOGIN_RATE_LIMIT_MAX + 1` rows per window. Wrong second-factor codes are bounded by the code budget (5 per account per 15 minutes).

## Actions

| Action | Actor | Target | Metadata |
|---|---|---|---|
| `auth.login.succeeded` | user | session | `method` (`password`, `totp`, `recovery_code`), `recoveryCodesLeft` |
| `auth.login.failed` (failure) | user, or no id | | `step` (`password`, `two_factor`), `reason` (`unknown_account`, `no_password`, `deactivated`, `wrong_password`, `input_too_long`, `credential_replaced`, `wrong_code`) |
| `auth.login.rate_limited` (failure) | no id | | `retryAfterSec` |
| `auth.login.two_factor_required` | user | session | |
| `auth.login.two_factor_locked` (failure) | user | session | |
| `auth.logout` | user | session | |
| `auth.session.revoked` | user | session | `current`, `reason` (`user`, `code_budget_spent`, the latter a failure) |
| `auth.session.others_revoked` | user | user | `sessionsRevoked` |
| `auth.session.token_reuse_detected` (failure) | system (`session guard`) | user | |
| `auth.two_factor.enabled` | user | user | `sessionsRevoked` |
| `auth.two_factor.disabled` | user | user | `method` |
| `auth.two_factor.recovery_codes_regenerated` | user | user | |
| `auth.two_factor.removed` | user | user | `via` (`password_reset`, `owner_setup`) |
| `auth.password.changed` | user | user | `sessionsRevoked` |
| `auth.password_reset.issued` | user (the issuer) | user | `expiresAt`, `linksReplaced` |
| `auth.password_reset.completed` | user | user | `issuedBy`, `sessionsRevoked` |
| `auth.owner_setup.issued` | system (`boot`, `reset-owner`) | user (the owner) | `via`, `sessionsRevoked` |
| `auth.owner_setup.completed` | user (the owner) | user | |
| `user.invitation.created` / `resent` / `revoked` | user | invitation (label: the invited address) | `role`, `replaced` / `previousInvitationId` |
| `user.invitation.accepted` | user (the new account) | invitation | `role`, `invitedBy` |
| `user.role.changed` | user | user | `from`, `to` |
| `user.deactivated` | user | user | `sessionsRevoked`, `keysDisabled` |
| `user.reactivated` | user | user | |
| `user.removed` | user | user (label kept) | `role`, `keysDisabled` |
| `user.ownership.transferred` | user | user (the new owner) | on a wrong password: outcome `failure`, `reason` |
| `api_key.created` / `updated` / `admin_changed` / `revoked` | user or api_key | api_key | `isAdmin`, `allowedSenders` (a count), `fields` |
| `domain.created` / `updated` / `verified` / `deleted` | user or api_key | domain | `fields`; `spf`, `dkim`, `dmarc` |
| `domain.dkim_rotation_started` / `_completed` / `_cancelled` (#250) | user or api_key | domain | `selector` (the pending selector; on completion, the new active one) |
| `webhook.created` / `deleted` | user or api_key | webhook (label: origin only) | `events` |
| `suppression.created` / `deleted` | api_key or user | suppression (label: the address) | `reason` |
| `audit_log.purged` | system (`retention purge`) | audit_log | `deleted`, `retentionDays` |

The human labels the page shows live in `AUDIT_ACTION_LABELS` (a `Record` over every action, so an action without a label does not compile).

Not recorded (yet): SMTP submission AUTH failures and REST requests with an invalid API key (high volume, unauthenticated; they are logged), template changes, email sends.

## Service methods

| Function | What it does |
|---|---|
| `recordAuditEvent(input, tx?)` | Writes one event (see above). |
| `listAuditEvents({ action?, actor?, outcome?, page, limit })` | One page, newest first (ties broken by id), with the total. |
| `listAuditActors()` | The users and keys seen as actors, each with its latest label, for the page's filter (at most 500). |
| `purgeOldAuditEvents(retentionDays, batchSize = 5000)` | Deletes events older than the cutoff (database clock), in batches, at most 100 batches per call. |
| `requestAuditClient(request, socketIp)` / `userAuditContext` / `restAuditContext` | Build the actor, IP and user agent of an HTTP request. |

## Retention

`AUDIT_LOG_RETENTION_DAYS` (default `365`, a whole number from `30` to `3650`; anything else refuses to boot). The purge worker (on boot and every 6 hours) runs `runAuditRetention`: it deletes older events in batches and, when it deleted any, records `audit_log.purged` with the count and the retention, so the log itself shows when history was dropped. Logged at `info` (`Audit log retention sweep completed`).

## The page

`GET /dashboard/audit-log` (`adminGuard`: the owner and admins; a member gets the 403 page; the sidebar link is shown to admins and the owner only). `Cache-Control: no-store`. A table of time (UTC, exact), actor (label and id), action (label, code and metadata), target, outcome and client (IP and user agent), 50 per page by default (`?page=`, `?limit=` up to 100). Filters: `action` (one of the actions), `actor` (`user:<id>`, `api_key:<id>` or `system`) and `outcome`; an unknown value is ignored, never an error. Every value from the log is escaped (`safe`): user agents and key names are chosen by whoever sent the request. Read-only: there is no edit or delete action.

## Tests

- `test/integration/audit-log.integration.test.ts`: labels resolved from the live rows and kept after a delete; IP, user agent and metadata cleaning; an unknown account stored without id or label; a transaction rollback dropping the record with the change; a record refused by the database rolling an account deactivation back; a best-effort failure logged and swallowed; the `UPDATE` trigger (ORM and raw SQL) with `DELETE` still working; retention boundaries across batches and the purge recording itself; a login flood writing `max + 1` rows per address; the page (admins and the owner, a member's 403, the sidebar link, the filters, escaping, paging).
- `test/integration/audit-events.integration.test.ts`: every wired action, table-driven through the real dashboard and REST plugins (or the service for `boot` and `reset-owner`), with its actor, target, outcome, metadata, IP and user agent; and a sweep proving no password, session token, API key, webhook secret or URL path, invitation or reset token, or TOTP code ever lands in a row.
- `test/unit/audit-log.test.ts` (retention bounds, the action list) and `test/unit/login-rate-limit.test.ts` (`shouldAuditLockout`).
