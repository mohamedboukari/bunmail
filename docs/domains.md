# Domains Module

Manages sender domains, auto-generates DKIM keys, and verifies DNS records (SPF, DKIM, DMARC).

## Module Layout

```
src/modules/domains/
├── domains.plugin.ts               ← Elysia plugin (route group)
├── errors.ts                       ← DomainAlreadyRegisteredError, InvalidDkimSelectorError, DkimRotationError (#250)
├── services/
│   ├── domain.service.ts           ← CRUD + DKIM key generation
│   ├── dkim-keys.ts                ← Key generation, selector rules, dated selectors, TXT match (#250)
│   ├── dkim-rotation.service.ts    ← DKIM key rotation: start, complete, cancel (#250)
│   ├── domain-dkim.service.ts      ← DKIM options for mail sent outside the queue (#106, #217)
│   ├── dns-verification.service.ts ← SPF/DKIM/DMARC DNS verification (pass, fail or unknown)
│   ├── domain-check-state.ts       ← Verification state machine: failure count, flip, schedule (#250)
│   ├── domain-check.service.ts     ← Stores a check and its webhook event in one transaction (#250)
│   ├── domain-reverify.service.ts  ← Scheduled re-verification worker: claim, check, reschedule (#250)
│   ├── dmarc-check.service.ts      ← DMARC discovery, org-domain fallback, strict tag parsing (#250)
│   ├── domain-dns-status.service.ts ← Cached live DMARC check + MX status, mail-flow summary (#250)
│   ├── required-dns-records.ts     ← The DNS records to publish (`dnsRecords`, #250)
│   ├── sending-ip-dnsbl.service.ts ← Daily DNSBL self-check of the sending IPs (#250)
│   └── sending-ips.service.ts      ← Sending IPs and the reverse DNS check (#247, #248)
├── dtos/
│   ├── create-domain.dto.ts        ← POST body validation
│   └── update-domain.dto.ts        ← PATCH body validation (unsubscribe settings)
├── models/
│   └── domain.schema.ts            ← Drizzle pgTable definition
├── serializations/
│   └── domain.serialization.ts     ← Strips private keys, exposes DKIM DNS record
└── types/
    ├── domain.types.ts             ← Domain type + CreateDomainInput
    └── domain-check.types.ts       ← Check outcome (`pass`, `fail`, `unknown`) and result (#250)
```

## Database Schema

Table: `domains`

| Column            | Type           | Constraints                  |
|-------------------|----------------|------------------------------|
| id                | varchar(36)    | PK, prefixed `dom_`          |
| name              | varchar(255)   | NOT NULL, UNIQUE             |
| dkim_private_key  | text           | nullable (auto-generated, **AES-256-GCM encrypted at rest**: `v1:<iv>:<ct>:<tag>` format, see #23) |
| dkim_public_key   | text           | nullable (auto-generated, plaintext: published in DNS) |
| dkim_selector     | varchar(63)    | NOT NULL, default `'bunmail'`: the active key's selector, chosen on create (#250) or set by a completed rotation |
| dkim_pending_selector | varchar(63) | nullable: the dated selector of a pending key rotation (#250) |
| dkim_pending_private_key | text     | nullable: the pending private key, AES-256-GCM encrypted like `dkim_private_key` (#250) |
| dkim_pending_public_key | text      | nullable: the pending public key (#250) |
| dkim_pending_created_at | timestamp | nullable: when the pending rotation started (#250) |
| dkim_previous_selector | varchar(63) | nullable: the selector active before the last completed rotation, informational only (#250) |
| dkim_previous_public_key | text     | nullable: its public key, to recognise the record to keep for now (#250) |
| dkim_rotated_at   | timestamp      | nullable: when the last rotation switched keys (#250) |
| unsubscribe_email | varchar(255)   | nullable: overrides the default `unsubscribe@<from-domain>` mailto in the `List-Unsubscribe` header (#40). On single-recipient mail with inbound SMTP off it is kept next to the per-recipient link; with inbound SMTP on, the `unsub+<token>` mailto replaces it (#249) |
| unsubscribe_url   | text           | nullable: adds an `https` URL form to `List-Unsubscribe` and enables `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (#40). Used only for mail with cc, bcc or several recipients, or when `APP_BASE_URL` is not `https://`: otherwise BunMail's per-recipient `/u/<token>` link takes precedence, since a static URL cannot tell who clicked (#249) |
| notify_email      | varchar(255)   | nullable, when set, inbound mail received for this domain triggers a summary notification email to this address (#106). Use an external mailbox. |
| spf_verified      | boolean        | NOT NULL, default `false`    |
| dkim_verified     | boolean        | NOT NULL, default `false`    |
| dmarc_verified    | boolean        | NOT NULL, default `false`    |
| verified_at       | timestamp      | nullable: when every required check (SPF, DKIM, DMARC) passed; kept while they keep passing or a lookup fails, cleared only when the domain flips to failing (#250) |
| last_checked_at   | timestamptz    | nullable: when the checks last ran, by Verify or the loop (#250) |
| next_check_at     | timestamptz    | nullable, indexed: when the loop checks the domain next; NULL = due now (#250) |
| consecutive_failures | integer     | NOT NULL, default `0`: checks in a row with a definitive failure (#250) |
| last_check_result | jsonb          | nullable: `{ spf, dkim, dmarc, checkedAt }`, each check `{ status: "pass" \| "fail" \| "unknown", reason }` (#250) |
| created_at        | timestamp      | NOT NULL, default `now()`    |
| updated_at        | timestamp      | NOT NULL, default `now()`    |
| created_by_user_id | varchar(36) | nullable, FK → users ON DELETE SET NULL, indexed: who created it (#219, attribution only; NULL = the owner) |

## DKIM Key Generation

When a domain is created, BunMail automatically generates a 2048-bit RSA keypair:

- **Private key**: generated as PEM, then encrypted with AES-256-GCM using `DKIM_ENCRYPTION_KEY` from `.env` before insert (#23). The plaintext PEM only lives in memory inside `createDomain()` and is never logged. Decrypted on read by the queue's domain lookup. **A key that does not decrypt fails closed in production (#244):** the boot refuses to start, naming the domains (`findUndecryptableDomainKeys`), and the queue never sends unsigned: the email is held on the retry backoff and fails once it is too old to retry. Development warns and sends unsigned.
- **Public key**: stored plaintext in `dkim_public_key`, provided as a DNS TXT record value

The DKIM DNS record the user needs to add is returned in the API response as `dkimDnsRecord`.

### Selector (#250)

The key's TXT record lives at `<selector>._domainkey.<domain>`. The selector defaults to `bunmail`; `POST /api/v1/domains` (and the dashboard's add form) accept an optional `dkimSelector`, for example when `bunmail` is already taken in the zone. It must be one lowercase DNS label: 1 to 63 characters, `[a-z0-9]`, with inner hyphens allowed (`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`). Anything else is `422` (`VALIDATION_ERROR` from the DTO, `INVALID_DKIM_SELECTOR` from the service), and the dashboard shows the reason as an error flash.

### Key rotation (#250)

A key can be replaced without a window where mail is unsigned or fails verification. Rotation is admin-only (admin API key, or `adminGuard` on the dashboard) and takes three steps:

1. **Start**: `POST /api/v1/domains/:id/dkim/rotate` (dashboard: **Rotate DKIM key** on the domain page, with a confirmation). BunMail generates a new RSA 2048 key pair, the same way as on create, under a dated selector `bm<YYYYMMDD>` (UTC). When that name is the current or the previous selector (a second rotation the same day), `-2`, `-3`, ... is appended, so it is never the current selector. The pending selector, the encrypted private key, the public key and the start time are stored. The response carries the TXT record to publish (`dnsRecord`), which also appears in `dnsRecords` with `pending: true`. Only one rotation can be pending: starting another is `409 DKIM_ROTATION_PENDING`.
2. **Publish** the pending TXT record at your DNS provider **next to** the current one. Do not replace the current record: mail is still signed with the current key while the rotation is pending.
3. **Complete**: `POST /api/v1/domains/:id/dkim/rotate/complete` (dashboard: **Complete rotation**). BunMail looks up `<pending selector>._domainkey.<domain>` and compares it with the pending public key, the same way Verify compares the active key. Only when it matches does one transaction switch: the pending key becomes the active key, the old selector and public key are kept as `previous` with the switch time (`dkim_rotated_at`), and `dkim_verified` is set (the new record was just found). Otherwise the answer is `409 DKIM_PENDING_NOT_PUBLISHED` with the reason (no record yet, a record with another key, or a temporary DNS failure) and nothing changes. A pending private key that does not decrypt with `DKIM_ENCRYPTION_KEY` is refused with `409 DKIM_PENDING_KEY_UNREADABLE`: cancel and start again. **Verify DNS** never switches on its own: the operator decides when.

**Cancel** with `DELETE /api/v1/domains/:id/dkim/rotate` (dashboard: **Cancel rotation**): the pending fields are cleared and the active key is untouched. Completing or cancelling with nothing pending is `409 DKIM_NO_PENDING_ROTATION`.

**The previous selector.** After a switch, the API (`dkimPrevious`) and the domain page show the previous selector with the advice: keep its DNS record published for at least 7 days after the switch, then remove it. Messages signed before the switch (still queued, delayed, forwarded or re-checked later) are verified against it. It is informational only: its private key is dropped at the switch and BunMail never signs with it. A later rotation replaces it.

**Audit.** `domain.dkim_rotation_started`, `domain.dkim_rotation_completed` and `domain.dkim_rotation_cancelled` are recorded in the same transaction as the change (actor: the dashboard user or the API key; target: the domain; metadata: `{ selector }` only, never key material). A complete refused because the record is not published changes nothing, so it is only logged (`info`, `DKIM rotation not completed: pending key not published`).

**Boot check.** `findUndecryptableDomainKeys()` also checks pending keys and returns `{ active, pending }`. An active key that does not decrypt refuses the boot in production (#244); a pending one only warns, in every environment, since mail is never signed with it.

## DNS Verification

The `dns-verification.service.ts` checks three DNS record types:

| Record | Host                                    | What it checks                              |
|--------|-----------------------------------------|---------------------------------------------|
| SPF    | `<domain>`                              | exactly one `v=spf1` record that gives `pass` (RFC 7208, evaluated with mailauth) for every sending IP of this server (#247) |
| DKIM   | `<selector>._domainkey.<domain>`        | TXT record containing the expected public key |
| DMARC  | `_dmarc.<domain>`, else `_dmarc.<organizational domain>` | exactly one record matching `v=DMARC1` with a valid `p=` (#250, see below) |

Trigger verification via `POST /api/v1/domains/:id/verify` or the dashboard "Verify DNS Records" button, or let the scheduled loop run it (below).

Each check is `pass`, `fail` (a definitive answer: the record is missing or does not match) or `unknown` (the lookup itself failed: SERVFAIL, a timeout, the network, an SPF `temperror`, or no known sending IP). `verified_at` is set only when all three pass (#250).

### Scheduled re-verification (#250)

`domain-reverify.service.ts` re-checks every domain in the background, so a record removed or changed after verification is noticed. It is started at boot (`DOMAIN_REVERIFY_ENABLED`, default `true`) and never sends mail.

- **Schedule.** The worker wakes every 5 minutes (plus or minus 20%, so replicas do not wake in lockstep). A run claims due domains in batches of 50 (at most 10 batches) and checks them 8 at a time with the same code as Verify (`runDnsChecks` + `applyDomainCheck`). After a pass the next check is `DOMAIN_REVERIFY_INTERVAL_HOURS` later (default 24, 6 to 168) plus or minus one hour; after a failure or an `unknown`, one hour later. A new domain (`next_check_at` NULL) is due at once.
- **Claim.** One statement: `UPDATE domains SET next_check_at = NOW() + 15 minutes WHERE id IN (SELECT id FROM domains WHERE next_check_at IS NULL OR next_check_at <= NOW() ORDER BY next_check_at NULLS FIRST LIMIT n FOR UPDATE SKIP LOCKED) RETURNING *`. Concurrent claims return disjoint domains, and the lease means a replica that dies mid-check releases its domains after 15 minutes.
- **DMARC cache.** The loop always looks DMARC up afresh (never the page's status cache) and stores its answer in that cache, except a failed lookup, so a DNS blip never replaces a good cached answer.
- **Logs.** Each run runs in `runWithLogContext({ job: "domain-reverify", jobId: "drv_..." })` and logs one line, `Domain re-verification run completed` with `checked`, `passed`, `failed`, `unknown`, `flipped`, `recovered`, `errors` and `durationMs` (at `debug` when nothing was due). Per-domain detail is at `debug`; a domain whose check or store throws is logged at `error` and retried when its lease ends.

### Failure rule (#250)

DNS blips must never stop sending. `domain-check-state.ts` decides what one check does, for Verify, the inline check of `REQUIRE_VERIFIED_DOMAIN` and the loop alike:

| Outcome | `consecutive_failures` | Flags | `verified_at` | Next check |
|---------|------------------------|-------|---------------|------------|
| All pass | reset to 0 | all true | kept, or set now (event `domain.verified`) | interval plus or minus 1 h |
| No failure, some `unknown` | unchanged | passing checks set, the others kept | kept | 1 h |
| A failure, first in a row | +1 | passing checks set, a true flag stays true | kept | 1 h |
| A failure, second (or later) in a row | +1 | follow the result | cleared (event `domain.verification_failed` when it was set) | 1 h |

The overall outcome is a failure when any check failed, else `unknown` when any lookup failed, else a pass. The flip runs in one transaction (`applyDomainCheck`): the row is locked and re-read, the new state written, and the event enqueued through the webhook outbox (`enqueueEvent(tx, ...)`, #184), so the flip and its event commit together. It also logs `Domain verification failed: verifiedAt cleared` at `warn` with the domain id and the failed checks. Both events go to admin keys' webhooks only (`{ adminOnly: true }`): a domain has no owning API key and managing domains is admin-only, like `email.received`. Payloads: `domain.verification_failed` `{ domainId, domain, failedChecks, checkedAt }`, `domain.verified` `{ domainId, domain, checkedAt }`. See [webhooks.md](webhooks.md).

With `REQUIRE_VERIFIED_DOMAIN=true` a send needs the DKIM flag: it stays true through an `unknown` and through one failure, and turns false at the flip when DKIM is among the failed checks; the send is then refused (after the usual inline re-check). The domain page shows **Last checked**, each check's last result and reason, and a banner while the domain is failing (two or more failures in a row and not verified).

Migration `0033` cleared `verified_at` on domains where a flag was false: it used to be set by every Verify, whatever the result.

### DMARC rules (#250)

`dmarc-check.service.ts` follows RFC 7489 6.6.3:

- The TXT records at `_dmarc.<domain>` are read with their chunks joined, and only those matching `/^v\s*=\s*DMARC1\s*(;|$)/i` count (`xv=DMARC1` or `v=DMARC10` do not).
- No such record: the organizational domain's record applies (`inherited`). More than one, at either name: the check fails (`multiple`), since receivers then apply no policy. A DNS error, or the 5 s budget the two lookups share running out, is `error`, without a further fallback; NXDOMAIN and "no TXT" count as no record.
- The tags `p`, `sp`, `pct`, `adkim`, `aspf` and `rua` are parsed strictly: names and values case-insensitive, unknown tags ignored, an invalid value reported in `problems` and replaced by its default (`pct` 100, alignment `r`); `rua` keeps only `mailto:` URIs.
- The check passes when exactly one record has a valid `p=` (`none`, `quarantine` or `reject`). The effective policy is `sp` when the record is inherited and `sp` is set, else `p`. `p=none` (or an inherited `sp=none`) passes with a warning that it only monitors; `pct` below 100 and a missing `rua` warn too.

**The organizational domain heuristic.** There is no Public Suffix List dependency: the organizational domain is the last two labels, or the last three when the second-to-last label is a common second-level label (`co`, `com`, `net`, `org`, `gov`, `ac`, `edu`, `ne`, `or`, `mil`) under a two-letter TLD, so `mail.example.co.uk` gives `example.co.uk`. It is wrong for other public suffixes (`github.io`, `pvt.k12.ma.us`, `blogspot.com`...): the fallback then queries a name above the real organizational domain, which normally has no record, so the check reports `missing` instead of a wrong policy, and the fix is to publish a record at `_dmarc.<domain>` itself.

The result is returned as `dmarc` (below). `verifyDomain` stores `dmarc_verified` and refreshes the cached check, so the page shows it at once.

### Live DNS status: `dmarc` and `mx` (#250)

`domain-dns-status.service.ts` gives each domain's current DMARC check and MX status, for the API (`GET` and verify) and the domain page. Lookups use `dns/promises`, are cached in memory (an hour, five minutes after an error, at most 10,000 domains) and never fail a request: a DNS failure is an `error` status. The DMARC check and the MX lookup run in parallel under one overall 5 s deadline per domain; the DMARC fallback to the organizational domain runs after the domain's own lookup but within the same budget, so a request waits at most one timeout. A part still pending at the deadline is reported as `error` and its lookup keeps filling the cache. Create, update and delete never wait on DNS (`dmarc` and `mx` are `null`). `resolveDomainTxt()` is the TXT lookup `verifyDomain` uses by default, so one seam covers both. The MX answer shares the cache of the signed return path (`resolveMxStatus` in `bounces/services/return-path-mx.ts`, #236), so the page shows what the mailer does. `setDomainDnsDeps()` replaces the lookups in tests; the integration run installs an NXDOMAIN stub for everything in `test/integration/_preload.ts`, so no integration test does real DNS.

`mx` is `{ status, hosts }`: `here` (the MX set names `MAIL_HOSTNAME`), `elsewhere` (other hosts only), `none` (NXDOMAIN, no MX or a null MX) or `error`, with the host names lowercased. It is informational and never required: a domain whose MX serves mailboxes elsewhere (Google Workspace, Microsoft 365) sends normally. With `SMTP_ENABLED`, `mailFlowFeatures()` says on the page whether signed return paths, async bounces, DMARC reports and inbound mail are active for the domain: all four need inbound SMTP on and the MX `here`.

### DNS records to publish: `dnsRecords` (#250)

`getRequiredDnsRecords(domain, { mailHostname, publicIps })` (pure; defaults from `config`) returns `{ type, host, value, purpose, optional, note?, pending? }` entries, in this order:

| Type | Host | Value | Notes |
|------|------|-------|-------|
| TXT | `<domain>` | `v=spf1 a:<MAIL_HOSTNAME> -all` | merge the `a:` term into an existing SPF record instead |
| TXT | `<selector>._domainkey.<domain>` | the DKIM record as quoted strings of at most 255 characters | left out when the domain has no public key |
| TXT | `<pending selector>._domainkey.<domain>` | the pending key's DKIM record, split the same way | only while a key rotation is pending; `pending: true` (#250) |
| TXT | `_dmarc.<domain>` | `v=DMARC1; p=none; rua=mailto:dmarc@<domain>` | BunMail stores the reports when inbound SMTP is on and the MX points here; otherwise use an address you read |
| A / AAAA | `MAIL_HOSTNAME` | each `MAIL_PUBLIC_IP` | described ("this server's public IP address") when `MAIL_PUBLIC_IP` is unset; once per server |
| PTR | each sending IP | `MAIL_HOSTNAME` | set at the hosting provider, not in the zone |
| MX | `<domain>` | `10 <MAIL_HOSTNAME>` | `optional`: only to receive bounces, DMARC reports and inbound mail; leave an MX that serves mailboxes as it is |

There is no DMARC report address setting, so the suggestion is `dmarc@<domain>`.

## Service Methods

### domain.service.ts

#### `createDomain(input): Promise<Domain>`
Creates a domain record and auto-generates a 2048-bit RSA keypair for DKIM signing. The name is trimmed and stored lowercase; a name already registered in any case throws `DomainAlreadyRegisteredError` (`409 DOMAIN_ALREADY_REGISTERED`), and lookups by name ignore case. The key is generated under `input.dkimSelector` (default `bunmail`; an invalid one throws `InvalidDkimSelectorError`, #250). `input.createdByUserId` (#219) records who added it: the dashboard user, or over REST the calling key's user (null = the owner).

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

### dkim-keys.ts (#250)

Pure helpers shared by create, rotation and Verify: `generateDkimKeyPair()`, `isValidDkimSelector()` and `DKIM_SELECTOR_PATTERN` (also the DTO's pattern), `datedDkimSelector(now, taken)`, `dkimRecordValue(pem)`, `dkimRecordHost(selector, domain)` and `dkimRecordsMatchKey(records, pem)` (the publish comparison: one record or all of them joined carries `v=DKIM1` and `p=<key>`, whitespace ignored).

### dkim-rotation.service.ts (#250)

- `startDkimRotation(id, audit, now?)`, `completeDkimRotation(id, audit, deps?, now?)`, `cancelDkimRotation(id, audit)`: the steps above. Each returns the updated domain, or `undefined` for an unknown id, and throws `DkimRotationError` (`409` with `code`) when the domain's state refuses the step. Each locks the row (`FOR UPDATE`) and writes the change and its audit event in one transaction. Complete looks up DNS before the transaction and, inside it, checks that the pending key is still the one it looked up.
- `checkDkimKeyPublished(domain, selector, pem, deps?)`: the publish check with its reason; the TXT lookup goes through the domains DNS seam (`resolveDomainTxt`), so `setDomainDnsDeps()` stubs it in tests.

### domain-dkim.service.ts

- `resolveDomainDkim(domain): DkimOptions | undefined`: decrypts the domain's stored DKIM key (`DKIM_ENCRYPTION_KEY`; a plaintext key is used with a `warn`, a decrypt failure is logged at `error` and yields no key) and returns the signing options, or `undefined` when there is no usable key. Used by inbound notifications (#106: with no key at all they send unsigned; with a stored key that does not decrypt they are not sent in production, #244) and invitation emails (#217, which then do not send). The queue keeps its own copy of the decrypt step.

### dns-verification.service.ts

#### `verifyDomain(domain, deps?, options?): Promise<VerificationResult>`
Runs SPF, DKIM, and DMARC checks in parallel (`runDnsChecks`), stores the outcome with `applyDomainCheck` (the failure rule above), and returns `{ spf, dkim, dmarc, spfReason, dkimReason, dmarcReason, checks }`: the booleans are true only for `pass`, `checks` has each check's `status` and `reason`. `options.source` is `manual` (default) or `scheduled` (the loop: per-domain logs at `debug`, a failed DMARC lookup not cached). SPF (#247): the record must exist exactly once, contain no `<placeholder>`, and give `pass` for every sending IP (`MAIL_PUBLIC_IP`, or the A/AAAA records of `MAIL_HOSTNAME`, from `sending-ips.service.ts`), evaluated in strict RFC 7208 mode with mailauth (10-lookup and 2-void-lookup limits, 10 s cap); a failed DNS lookup is reported as temporary. The dashboard suggests `v=spf1 a:<MAIL_HOSTNAME> -all` (`suggestedSpfRecord()`), to be merged into an existing record. DMARC (#250): `checkDmarc()` from `dmarc-check.service.ts`, described above.

#### `runDnsChecks(domain, deps?, options?): Promise<DomainCheckResult>`
The three checks without storing anything. Never rejects on a DNS error: that check is `unknown`.

### domain-check-state.ts (#250)

- `nextDomainCheckState(previous, result, now, intervalMs, random?)`: the failure rule, pure. Returns the next state, the overall outcome, the next check time, the failed checks and the event (`failed`, `verified` or none).
- `overallOutcome(result)`, `nextCheckAfterPass(now, intervalMs, random?)`; constants `FLIP_AFTER_FAILURES` (2), `RECHECK_AFTER_PROBLEM_MS` (1 h), `RECHECK_JITTER_MS` (1 h).

### domain-check.service.ts (#250)

- `applyDomainCheck(domainId, result, now?, intervalMs?)`: one transaction that locks the row, applies `nextDomainCheckState`, writes `last_checked_at`, `next_check_at` and `last_check_result`, and enqueues `domain.verification_failed` or `domain.verified` through the outbox. Logs the flip at `warn`. `undefined` when the domain was deleted meanwhile.

### domain-reverify.service.ts (#250)

- `start()` / `stop()`: the worker (no-op while `DOMAIN_REVERIFY_ENABLED=false`).
- `runReverifyCycle(deps?)`: one run, in its own log context; returns the run summary. Does nothing while disabled.
- `claimDueDomains(limit, executor?)`: the claim described above.

### dmarc-check.service.ts

- `checkDmarc(domain, { resolveTxt, timeoutMs? }): Promise<DmarcCheck>`: the DMARC check described above, within one budget (`timeoutMs`, 5 s) for both lookups. Never rejects. Logs the status and record count at `debug` (never the TXT values) and a failed lookup at `warn`.
- `parseDmarcRecord(record): ParsedDmarcRecord`: strict tag parsing of one record.
- `organizationalDomain(domain): string`: the heuristic above.

### domain-dns-status.service.ts

- `getDomainDnsStatus(name): Promise<{ dmarc, mx }>`: the cached live status. Never rejects.
- `getDomainsDnsStatus(names, concurrency = 8)`: the same for a list, in order, with at most `DNS_STATUS_CONCURRENCY` (8) domains looked up at once (a small worker pool), so listing a large install with a cold cache stays bounded. Used by `GET /api/v1/domains`.
- `rememberDmarcCheck(name, check)`: stores a fresh check (used by `verifyDomain`).
- `mailFlowFeatures(mx, smtpEnabled)`: the four mail flows with `active` and a one-line explanation.

### required-dns-records.ts

- `getRequiredDnsRecords(domain, settings?)`: the table above. `pendingDkimDnsRecord(domain)` is the pending rotation's entry alone (or `null`). `splitTxtValue(value)` splits a TXT value into quoted strings of at most 255 characters.

### sending-ip-dnsbl.service.ts (#250)

The DNSBL self-check of the sending IPs (`MAIL_PUBLIC_IP`, or the A/AAAA records of `MAIL_HOSTNAME`, via `resolveSendingIps`) against Spamhaus ZEN, Barracuda and SpamCop. Information only: nothing gates on it. Results live in memory, per replica.

- `start()` / `stop()`: the worker, first run 45 to 75 s after boot, then every 24 hours plus or minus 5% (no-op while `SENDING_IP_DNSBL_CHECK=false`).
- `runDnsblSelfCheck(deps?, memory?)`: one run in its own log context (`job: "dnsbl-self-check"`), one `DNSBL self-check completed` line with the counts; `warn` when an address becomes listed on a zone, `info` when it is delisted, nothing while a state holds. `null` while disabled.
- `checkAddress(ip, deps?, zones?)` / `checkSendingIpsDnsbl(deps?)`: the lookups. IPv4 as reversed octets, IPv6 as reversed nibbles and only on zones that list IPv6 (ZEN), an IPv4-mapped address as its IPv4; addresses that are not publicly routable are skipped. 5 s timeout per lookup.
- `classifyAnswers(zone, answers)` / `classifyError(error)`: `127.0.0.2` to `127.0.0.11` listed (ZEN codes named: SBL, CSS, XBL, DROP, PBL; PBL marked as a policy listing), any `127.255.255.x` `unavailable` (query refused, typically a public resolver), NXDOMAIN or no record `not-listed`, any other answer, error or timeout `unknown`.
- `getDnsblStatus()`: `{ enabled, snapshot }` for the dashboard home, no lookup. `setDnsblDeps(override | null)`: the DNS seam for tests.

## Serialization

The `serializeDomain(domain, dns)` function:
- **Strips** every private key, active and pending, and the public keys (never exposed in API responses)
- **Exposes** `dkimDnsRecord`: the TXT record value users need to add to their DNS (unsplit)
- **Exposes** `dkimPending` (`{ selector, host, dnsRecord, createdAt }` or `null`) and `dkimPrevious` (`{ selector, host, dnsRecord, rotatedAt, advice }` or `null`) for key rotation (#250)
- **Adds** `dnsRecords` (always), and `dmarc` and `mx` from `dns`, which is `null` on `DELETE` (no lookup for a removed domain) (#250)
- **Exposes** `lastCheckedAt` and `lastCheckResult` (`{ spf, dkim, dmarc, checkedAt }`, each check `{ status, reason }`, or `null` before the first check) (#250); `next_check_at` and `consecutive_failures` stay internal

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
| POST   | /api/v1/domains/:id/dkim/rotate | Start a DKIM key rotation (#250) |
| POST   | /api/v1/domains/:id/dkim/rotate/complete | Switch to the pending key once published (#250) |
| DELETE | /api/v1/domains/:id/dkim/rotate | Cancel the pending rotation (#250) |

`POST /api/v1/domains` accepts an optional `notifyEmail` field to set the
inbound-notification address at create time (see below), and an optional
`dkimSelector` (see Selector above).

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
