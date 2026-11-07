# Domains Module

Manages sender domains, auto-generates DKIM keys, and verifies DNS records (SPF, DKIM, DMARC).

## Module Layout

```
src/modules/domains/
├── domains.plugin.ts               ← Elysia plugin (route group)
├── errors.ts                       ← DomainAlreadyRegisteredError, InvalidDomainNameError (#406), InvalidDkimSelectorError, DkimRotationError (#250)
├── services/
│   ├── domain.service.ts           ← CRUD + DKIM key generation
│   ├── domain-name.ts              ← Name normalisation and the host name rule on create (#406)
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
│   ├── sending-ips.service.ts      ← Sending IPs and the reverse DNS check (#247, #248)
│   ├── spf-evaluator.ts            ← SPF `checkHost()`, RFC 7208 strict: lookups, limits, deadline (#373)
│   ├── spf-syntax.ts               ← SPF record parsing, domain-spec and macro expansion (#373)
│   └── spf-address.ts              ← IP parsing, IPv4-mapped clients, CIDR matching (#373)
├── dtos/
│   ├── create-domain.dto.ts        ← POST body validation
│   └── update-domain.dto.ts        ← PATCH body validation (unsubscribe settings, tracking opt-in #187)
├── models/
│   └── domain.schema.ts            ← Drizzle pgTable definition
├── serializations/
│   └── domain.serialization.ts     ← Strips private keys, exposes DKIM DNS record
└── types/
    ├── domain.types.ts             ← Domain type, CreateDomainInput, DomainSettingsChanges (#187)
    ├── domain-check.types.ts       ← Check outcome (`pass`, `fail`, `unknown`) and result (#250)
    └── spf.types.ts                ← SPF result, DNS resolver, `checkHost()` input and options (#373)
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
| track_opens       | boolean        | NOT NULL, default `false`: open tracking opt-in, set by admins (#187). See [Open and click tracking](#open-and-click-tracking-187) |
| track_clicks      | boolean        | NOT NULL, default `false`: click tracking opt-in, set by admins (#187) |
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

## Domain Name (#406)

`POST /api/v1/domains` and the dashboard's add form normalise the name, then check it (`domain-name.ts`):

1. **Normalise**: trim; convert a Unicode IDN to its A-label with `node:url`'s `domainToASCII` (`bücher.example` becomes `xn--bcher-kva.example`; only a name with non-ASCII characters and no ASCII space or control character is converted); lowercase ASCII letters; drop one final dot (`Example.COM.` becomes `example.com`).
2. **Check**: a host name of at least two labels, each 1 to 63 letters, digits or inner hyphens (no leading or trailing hyphen), 253 characters at most, whose top label is not all digits (so an IPv4 address is refused). A URL (`https://example.com`), a port (`example.com:25`), a space, an `@`, an empty label (`example..com`, `example.com..`) and a single label (`localhost`) are all refused.

A refused name is `422 INVALID_DOMAIN_NAME` over REST (the message never repeats the submitted value) and an error flash on the dashboard; nothing is stored. The normalised name is what is stored and compared: `Example.COM.` and `example.com` are the same domain (`409 DOMAIN_ALREADY_REGISTERED`).

**Rows stored before #406** are never changed. At boot (`warnNonCanonicalDomainNames` in `src/boot.ts`), each stored name that creation would now refuse, or store differently than by case alone (a final dot, a Unicode IDN), is logged once as a `warn` with its `domainId`, `name` and `normalized` form (`null` when refused); the boot goes on. Such a name can miss sender-domain lookups and DNS checks: delete the domain and add it again under its normalised name (its DKIM key changes, so publish the new TXT record).

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
| SPF    | `<domain>`                              | exactly one `v=spf1` record that gives `pass` (RFC 7208, evaluated by the built-in evaluator, #373) for every sending IP of this server (#247) |
| DKIM   | `<selector>._domainkey.<domain>`        | TXT record containing the expected public key |
| DMARC  | `_dmarc.<domain>`, else `_dmarc.<organizational domain>` | exactly one record matching `v=DMARC1` with a valid `p=` (#250, see below) |

Trigger verification via `POST /api/v1/domains/:id/verify` or the dashboard "Verify DNS Records" button, or let the scheduled loop run it (below). The dashboard button (and its **Complete rotation**) allows 5 DNS checks per domain per minute (`src/pages/lib/dns-verify-throttle.ts`, shared by every replica with `REDIS_URL`, #185); the API route is under the per-key API rate limit.

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

### SPF evaluation (#373)

`spf-evaluator.ts` is `check_host()` of RFC 7208 for one domain and one IP, strict mode only, on `dns/promises` with no dependency (it replaced mailauth's `spf()`); its TXT queries go through `src/utils/dns-txt.ts`, which keeps a record of several strings whole where Bun's `resolveTxt` splits it (oven-sh/bun#44692):

- **Record**: exactly one TXT record starting `v=spf1` (then a space or the end, any case), its strings joined: none is `none`, two or more a `permerror`. A domain that is not a valid multi-label name is `none`.
- **Syntax**: the whole record is parsed before evaluation; any error anywhere is a `permerror`, even after a matching term. Terms are separated by spaces only. Mechanisms `all`, `include`, `a`, `mx`, `ptr`, `ip4`, `ip6`, `exists` (dual CIDR on `a` and `mx`), the `redirect` modifier; `exp` is checked for syntax but never evaluated; unknown modifiers must hold a valid macro-string. At most one `redirect` and one `exp`.
- **Macros**: `s l o d i p v h` with digit and `r` transformers and delimiters, `%%`, `%_`, `%-`, uppercase letters URL-escaped; `c r t` (explanation only) and any other letter are a `permerror`. An expanded name loses labels on the left until it fits in 253 characters; an expansion that is not a valid name makes `a`, `mx`, `ptr` and `exists` not match and makes `include` and `redirect` a `permerror`.
- **Limits**: at most 10 DNS-querying terms (`include`, `a`, `mx`, `ptr`, `exists`, `redirect`, plus the PTR lookup of each `%{p}`), counted when evaluated, across includes and redirects; an `mx` answer of more than 10 names is a `permerror`; only the first 10 `ptr` names are checked; more than 2 void lookups (empty answers to a term's query) is a `permerror`. Past the deadline (10 s) the result is `temperror`.
- **Results**: `include` maps the inner result per RFC 7208 5.2 (pass matches; fail, softfail and neutral do not; none is a `permerror`; errors propagate); `redirect` takes the target's result, with none as a `permerror`. No match and no redirect is `neutral`.
- **DNS errors**: `ENOTFOUND` and `ENODATA` are an empty answer (Bun reports both NXDOMAIN and no data as `ENOTFOUND`); anything else is a `temperror`, except in `ptr` and `%{p}` lookups, where a failed PTR lookup means no match (or `unknown`) and a failed address lookup skips that name.
- **Addresses**: an IPv4-mapped IPv6 client (`::ffff:192.0.2.1` or `::ffff:c000:201`) is an IPv4 client: it matches `ip4` terms and A records, never `ip6` terms. CIDR matching is done on the address bytes.

The tests run the OpenSPF RFC 7208 suite (`test/fixtures/spf/rfc7208-tests.yml`, BSD-3-Clause, vendored with its license) and BunMail's own cases (`bunmail-spf-tests.yml`), and compare every case with mailauth's recorded results (`mailauth-results.json`); see `test/unit/spf-evaluator.test.ts` for the two intended differences.

### Live DNS status: `dmarc` and `mx` (#250)

`domain-dns-status.service.ts` gives each domain's current DMARC check and MX status, for the API (`GET` and verify) and the domain page. Lookups use `dns/promises` for MX and `src/utils/dns-txt.ts` for TXT (Bun's `resolveTxt` splits a multi-string record into several, oven-sh/bun#44692), are cached in memory (an hour, five minutes after an error, at most 10,000 domains) and never fail a request: a DNS failure is an `error` status. The DMARC check and the MX lookup run in parallel under one overall 5 s deadline per domain; the DMARC fallback to the organizational domain runs after the domain's own lookup but within the same budget, so a request waits at most one timeout. A part still pending at the deadline is reported as `error` and its lookup keeps filling the cache. Create, update and delete never wait on DNS (`dmarc` and `mx` are `null`). `resolveDomainTxt()` is the TXT lookup `verifyDomain` uses by default, so one seam covers both. The MX answer shares the cache of the signed return path (`resolveMxStatus` in `bounces/services/return-path-mx.ts`, #236), so the page shows what the mailer does. `setDomainDnsDeps()` replaces the lookups in tests; the integration run installs an NXDOMAIN stub for everything in `test/integration/_preload.ts`, so no integration test does real DNS.

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
Creates a domain record and auto-generates a 2048-bit RSA keypair for DKIM signing. The name is normalised and checked (see Domain Name above; a refused one throws `InvalidDomainNameError`, `422 INVALID_DOMAIN_NAME`, #406) and stored in that form; a name already registered in any form throws `DomainAlreadyRegisteredError` (`409 DOMAIN_ALREADY_REGISTERED`). Lookups by name (`domainNameIs`, used by `getDomainByName`, `domainExistsByName`, the sender-domain check and the queue's legacy lookup) ignore case and normalise the name the same way; when that changes more than the case, the name trimmed and lowercased as before #406 matches too, so a row stored in that form is still found. The key is generated under `input.dkimSelector` (default `bunmail`; an invalid one throws `InvalidDkimSelectorError`, #250). `input.createdByUserId` (#219) records who added it: the dashboard user, or over REST the calling key's user (null = the owner). `input.trackOpens` / `input.trackClicks` (#187) set the tracking opt-in, off when omitted.

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

#### `updateDomainSettings(id, changes): Promise<Domain | undefined>`
Updates `unsubscribeEmail` and/or `unsubscribeUrl` (#243) and `trackOpens` / `trackClicks` (#187); only the fields present in `changes` are written, `null` clears an unsubscribe override. Called `updateDomainUnsubscribe` before #187. Used by `PATCH /api/v1/domains/:id` and the domain page in the dashboard.

#### `deleteDomain(id): Promise<Domain | undefined>`
Hard-deletes a domain and its keys.

#### `findNonCanonicalDomainNames(): Promise<NonCanonicalDomainName[]>`
The stored names that creation would now refuse or store differently than by case alone (#406), as `{ id, name, normalized }` (`normalized` is `null` when refused). Read-only; the boot logs one `warn` per entry.

### domain-name.ts (#406)

Pure helpers, no database: `normalizeDomainName(input)` (trim, IDN to A-label, ASCII lowercase, one final dot dropped; never refuses) and `parseDomainName(input)` (the normalised name, or `null` when it is not a host name; see Domain Name above). The label and length rule is `isLowerAsciiDomain` from `src/config/sso.ts`, shared with SSO's allowed domains (#224); the all-digit top label check is added here.

### dkim-keys.ts (#250)

Pure helpers shared by create, rotation and Verify: `generateDkimKeyPair()`, `isValidDkimSelector()` and `DKIM_SELECTOR_PATTERN` (also the DTO's pattern), `datedDkimSelector(now, taken)`, `dkimRecordValue(pem)`, `dkimRecordHost(selector, domain)` and `dkimRecordsMatchKey(records, pem)` (the publish comparison: one record or all of them joined carries `v=DKIM1` and `p=<key>`, whitespace ignored).

### dkim-rotation.service.ts (#250)

- `startDkimRotation(id, audit, now?)`, `completeDkimRotation(id, audit, deps?, now?)`, `cancelDkimRotation(id, audit)`: the steps above. Each returns the updated domain, or `undefined` for an unknown id, and throws `DkimRotationError` (`409` with `code`) when the domain's state refuses the step. Each locks the row (`FOR UPDATE`) and writes the change and its audit event in one transaction. Complete looks up DNS before the transaction and, inside it, checks that the pending key is still the one it looked up.
- `checkDkimKeyPublished(domain, selector, pem, deps?)`: the publish check with its reason; the TXT lookup goes through the domains DNS seam (`resolveDomainTxt`), so `setDomainDnsDeps()` stubs it in tests.

### domain-dkim.service.ts

- `resolveDomainDkim(domain): DkimOptions | undefined`: decrypts the domain's stored DKIM key (`DKIM_ENCRYPTION_KEY`; a plaintext key is used with a `warn`, a decrypt failure is logged at `error` and yields no key) and returns the signing options, or `undefined` when there is no usable key. Used by inbound notifications (#106: with no key at all they send unsigned; with a stored key that does not decrypt they are not sent in production, #244) and invitation emails (#217, which then do not send). The queue keeps its own copy of the decrypt step.

### dns-verification.service.ts

#### `verifyDomain(domain, deps?, options?): Promise<VerificationResult>`
Runs SPF, DKIM, and DMARC checks in parallel (`runDnsChecks`), stores the outcome with `applyDomainCheck` (the failure rule above), and returns `{ spf, dkim, dmarc, spfReason, dkimReason, dmarcReason, checks }`: the booleans are true only for `pass`, `checks` has each check's `status` and `reason`. `options.source` is `manual` (default) or `scheduled` (the loop: per-domain logs at `debug`, a failed DMARC lookup not cached). SPF (#247): the record must exist exactly once, contain no `<placeholder>`, and give `pass` for every sending IP (`MAIL_PUBLIC_IP`, or the A/AAAA records of `MAIL_HOSTNAME`, from `sending-ips.service.ts`), evaluated in strict RFC 7208 mode by `checkHost()` (see [SPF evaluation](#spf-evaluation-373)) with sender `postmaster@<domain>` and HELO `MAIL_HOSTNAME`; a failed DNS lookup or an SPF `temperror` is reported as temporary (`unknown`). The dashboard suggests `v=spf1 a:<MAIL_HOSTNAME> -all` (`suggestedSpfRecord()`), to be merged into an existing record. DMARC (#250): `checkDmarc()` from `dmarc-check.service.ts`, described above.

#### `runDnsChecks(domain, deps?, options?): Promise<DomainCheckResult>`
The three checks without storing anything. Never rejects on a DNS error: that check is `unknown`.

### spf-evaluator.ts (#373)

- `checkHost({ ip, domain, sender, helo }, { resolver?, timeoutMs? }): Promise<{ result, reason }>`: the evaluation described in [SPF evaluation](#spf-evaluation-373). `result` is `pass`, `fail`, `softfail`, `neutral`, `none`, `temperror` or `permerror`; `reason` says which term matched or what went wrong (for logs and tests). `resolver` (`SpfDnsResolver`: `resolveTxt`, `resolve4`, `resolve6`, `resolveMx`, `resolvePtr`) defaults to `dns/promises`, with `resolveTxt` from `src/utils/dns-txt.ts`; `timeoutMs` to 10 000. Never rejects for DNS errors; an invalid IP is a `temperror`.

`spf-syntax.ts` holds `parseSpfRecord()`, `parseDomainSpec()`, `expandMacros()`, `targetName()` and `isValidDomainName()`; `spf-address.ts` holds `parseIp()`, `clientAddress()` (IPv4-mapped to IPv4), `inNetwork()`, `reverseName()` and `macroIp()`.

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
`dkimSelector` (see Selector above). The `name` is normalised and checked
(see Domain Name above): `422 INVALID_DOMAIN_NAME` when it is not a host name.

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

## Open and click tracking (#187)

Each domain carries an opt-in for open and click tracking, `track_opens` and `track_clicks`, off by default. **Nothing is tracked yet in this version:** the opt-in and each email's decision are stored, and the open pixel and click redirect come later.

- **Who sets it:** admins only. Over REST with an admin key (`trackOpens` / `trackClicks` on `POST /api/v1/domains` and `PATCH /api/v1/domains/:id`; every domain route is admin-only), or on the domain page in the dashboard (two checkboxes, `POST /dashboard/domains/:id/tracking`, `adminGuard`; a box left unticked turns that kind off). Every change is audited as `domain.updated` with the field names.
- **Per domain, not per key:** the domain is the reputation and disclosure unit, and keys share domains. A send can opt out (`tracking: { opens: false }`) but never turn on what the domain has off, whatever its key's role.
- **Not alone:** tracking also needs `TRACKING_ENABLED=true` on the server, exactly one recipient and an `https://` `APP_BASE_URL`; `transactional` mail is tracked only when the send asks. See [emails.md](emails.md#open-and-click-tracking-187).
- **Queued mail keeps its decision:** it is made when the email is created and stored on it, so changing the opt-in affects mail created afterwards only.
