# TLS reporting (TLS-RPT, RFC 8460)

BunMail can send SMTP TLS reports (RFC 8460) to the recipient domains that ask for them (#345, part of the deliverability epic #251). A domain asks by publishing a TXT record at `_smtp._tls.<domain>`; once a day BunMail tells it how its TLS sessions to that domain's MX hosts went: how many negotiated TLS, and which failed and why (no STARTTLS, a bad certificate, an MX outside the MTA-STS policy, a policy that could not be fetched). Gmail, Outlook and Yahoo all publish such a record, so turning this on makes BunMail a better-behaved sender to them and gives the receiving side a view of problems BunMail would otherwise only log.

This is the **sending side** only. Reports other senders send about your own domains are not ingested.

Off by default. Set `TLSRPT_ENABLED=true` to turn it on; off means no `_smtp._tls` lookup, no recording and no report job.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `TLSRPT_ENABLED` | `false` | Record TLS sessions and send the daily reports. Only `true` or `false`; anything else refuses to boot. |
| `TLSRPT_CONTACT_EMAIL` | `SYSTEM_MAIL_FROM` | The report's `contact-info`; its domain is the `TLS-Report-Submitter`. One bare address, trimmed and lower-cased. With `TLSRPT_ENABLED=true` and neither this nor `SYSTEM_MAIL_FROM` set, or a malformed value, BunMail refuses to boot. |
| `TLSRPT_ORGANIZATION_NAME` | the contact's domain | The report's `organization-name`: 1 to 100 printable characters, no control characters; anything else refuses to boot. |
| `TLSRPT_MAX_REPORTS_PER_DAY` | `500` | Most report deliveries (one report to one address, mail and HTTPS together, every replica together) per UTC day; see [Daily caps](#daily-caps). A whole number from 1 to 100000; anything else refuses to boot. |
| `TLSRPT_MAX_REPORTS_PER_DESTINATION_PER_DAY` | `50` | Most reports one destination (one mail address, or one HTTPS origin) gets per UTC day, every replica together; see [Daily caps](#daily-caps). A whole number from 1 to 1000; anything else refuses to boot. |

Reports go out by `https:` POST or by mail, whichever the domain's record lists. **Mail reports** are sent from `SYSTEM_MAIL_FROM`, which must be on a domain registered in BunMail with a verified DKIM record (as for invitations): RFC 8460 requires the DKIM signature, and receivers ignore unsigned reports. Without a usable `SYSTEM_MAIL_FROM`, `mailto:` addresses are skipped with a warning (`https:` ones are still served). RFC 8460 suggests the `s=tlsrpt` service type on the DKIM key record; BunMail's published key records use the default (`*`), which also covers it.

## What is recorded

Recording hooks into the MX delivery path (`mailer-delivery.service.ts`, `observeMxSession`, after each SMTP session; `mailer.service.ts`, `observeUnconnectedAttempt`, when an enforce-mode MTA-STS policy matches no MX host). It runs in the background: a send never waits for it, and a failure to record is logged at `warn` (`TLS-RPT session could not be recorded`, by error name only) and never reaches the send. At most 4 recordings run at once; past that a recording is dropped, counted as `bunmail_tlsrpt_sessions_total{result="dropped"}` and logged at `debug` at most once a minute, so a slow database cannot pile up background work under a send storm.

When several recipient domains share one MX session, each domain is classified from its own transactions' outcomes only: a domain whose transaction never reached a TLS decision in that session (it was not attempted, or failed before TLS) is not counted for it.

A session is recorded for a recipient domain only when that domain publishes a usable `_smtp._tls` record. The record is looked up through `src/utils/dns-txt.ts` (Bun's own `resolveTxt` splits multi-string records) and the answer cached in memory per domain for an hour (a failed lookup: five minutes, as "no record"), at most 10,000 domains, the oldest evicted, per replica.

**Policy** (`policy-type`, RFC 8460 section 4.4), from the MTA-STS discovery of the same attempt:

- `sts` with the policy's lines (`version`, `mode`, each `mx`, `max_age`) as `policy-string` and its MX patterns as `mx-host`, when an MTA-STS policy applied (any mode);
- `sts` with no policy string, when a policy was announced but could not be fetched (and none was cached): every session of the attempt counts as `sts-policy-fetch-error`, `sts-policy-invalid` or `sts-webpki-invalid`;
- `no-policy-found` otherwise. DANE is not implemented, so `tlsa` never appears.

**Result** (`result-type`, RFC 8460 section 4.3): only the types BunMail can genuinely tell apart, mapped from what the session showed (`tls-rpt-classify.ts`, checked against real receiving servers in `test/unit/tls-rpt-sessions.test.ts`):

| What BunMail saw | Recorded as |
|---|---|
| STARTTLS negotiated (whatever the SMTP outcome after it) | success |
| The session ran in plaintext (no STARTTLS offered, or it was refused) | `starttls-not-supported` |
| Enforce mode: the MX refused `STARTTLS` | `starttls-not-supported`, reason `starttls-refused` |
| Enforce mode: certificate expired | `certificate-expired` |
| Enforce mode: certificate for another name | `certificate-host-mismatch` |
| Enforce mode: self-signed, unknown CA, unverifiable chain | `certificate-not-trusted` |
| Enforce mode: certificate not yet valid | `validation-failure`, reason `certificate-not-yet-valid` |
| A STARTTLS handshake that never completed (a peer offering only TLS below 1.2) | `validation-failure`, reason `starttls-handshake-timeout` |
| Any other TLS failure | `validation-failure`, reason `tls-handshake-failed` |
| `testing` or `enforce` policy, MX host not named by it | `validation-failure`, reason `mx-not-in-policy` |
| MTA-STS policy announced, fetch failed / invalid / bad certificate | `sts-policy-fetch-error` / `sts-policy-invalid` / `sts-webpki-invalid` |

Not recorded: a session that failed before TLS mattered (refused connection, timeout, an SMTP reply before STARTTLS), which RFC 8460 leaves out as transient, and entries the rate budget deferred. Without an enforce policy certificates are not verified (opportunistic TLS), so the certificate types only appear for enforce-mode domains. The reason codes are BunMail's own fixed set: nothing a receiving server sent ever goes into a report.

Each failure carries the MX host name and the address BunMail connected to (`receiving-mx-hostname`, `receiving-ip`) and, when `MAIL_PUBLIC_IP` is set, the sending IP of the same family (`sending-mta-ip`). Never a recipient address, never message content.

## Storage

Three tables (migration `0041_tls_rpt`), touched only by `tls-rpt-store.service.ts`:

**`tlsrpt_reports`**: one row per recipient domain and UTC day, created by the day's first recorded session; it also holds the send state.

| Column | Type | Notes |
|---|---|---|
| `id` | `varchar(36)` PK | `trp_...` |
| `day` | `date` | the UTC day covered |
| `policy_domain` | `varchar(253)` | the recipient domain |
| `rfc_report_id` | `varchar(64)` | the report's `report-id` (a UUID), the same on every attempt and address |
| `next_attempt_at` | `timestamptz` | first due one to five hours after the day ends (random), then the retry backoff; a claim pushes it forward by a 3 h lease |
| `attempts` | `integer` | send attempts started, counted at claim |
| `delivered_rua` | `text` | short SHA-256 hashes of the reporting URIs already served, `\n`-joined (no URL is stored) |
| `created_at`, `updated_at` | `timestamptz` | |

Unique `(day, policy_domain)`; index on `next_attempt_at`.

**`tlsrpt_results`**: the counters of a report. `report_id` references `tlsrpt_reports(id)` `ON DELETE CASCADE`.

| Column | Type | Notes |
|---|---|---|
| `id` | `varchar(36)` PK | `trr_...` |
| `report_id` | `varchar(36)` FK | cascade |
| `policy_type` | `varchar(16)` | `sts` or `no-policy-found` |
| `policy_hash` | `varchar(32)` | identifies the policy within the report |
| `policy_string`, `mx_host` | `text` | the policy's lines and MX patterns, `\n`-joined, at most 4,000 characters each |
| `result_type` | `varchar(40)` | `success` or an RFC 8460 failure type |
| `receiving_mx_hostname`, `receiving_ip`, `failure_reason_code` | `varchar` | empty for a success or a counter past the detail cap |
| `session_count` | `integer` | |
| `created_at`, `updated_at` | `timestamptz` | |

Unique on the whole key `(report_id, policy_type, policy_hash, result_type, receiving_mx_hostname, receiving_ip, failure_reason_code)`.

**`tlsrpt_daily_sends`**: the [daily cap](#daily-caps) counter, one row per UTC day: `day` (`date` PK), `sent` (deliveries that day), `cap_warned` (the day's warning was logged), `updated_at`.

**`tlsrpt_destination_sends`**: the per-destination counter: `day` (`date`), `destination_hash` (`varchar(32)`, a SHA-256 of the destination: the address or URL origin itself is never stored), `sent`, `updated_at`; primary key `(day, destination_hash)`.

Counter rows past the report retention are deleted with the reports.

**Bounded per report**, however hostile the receiving side (`tls-rpt-aggregate.ts`): at most 4 policies (a session under a fifth is dropped, logged at `debug`), at most 100 detailed failure counters, and past that, each failure counts on its policy's counter for that result type without host details, so the totals stay exact. Recording is one transaction: the report row is upserted first, which locks it, so concurrent sessions of one domain count exactly and the caps hold.

## The report job

`tls-rpt-job.service.ts` (the run) and `tls-rpt-deliver.service.ts` (one report), started with the other background services when `TLSRPT_ENABLED=true`: about two minutes after boot, then every 15 minutes (plus or minus 20%), each run in its own log context (`job: "tlsrpt-report"`, `jobId: trj_...`). Each run:

1. Deletes reports more than 7 days old, sent or not.
2. Stops here when today's [daily cap](#daily-caps) is already reached.
3. Otherwise 3 workers each claim **one** due report at a time (its UTC day is over and `next_attempt_at` has passed; `FOR UPDATE SKIP LOCKED`, a 3 h lease), deliver it, then claim the next, at most 200 reports a run. A report takes a few minutes at most (see below), so a lease never expires under a live send, and several replicas never send the same report.
4. **Time budget:** a run claims nothing after 10 minutes, and a report still being delivered then is handed back before its next address: due at once, its claim's attempt given back, the addresses already served kept. The next run, or another replica, goes on with it.
5. For each report, looks the domain's record up again (no cache). No record any more: the report is deleted. A failed lookup is retried like a failed send.
6. Builds one JSON report (RFC 8460 section 4: `organization-name`, `date-range` of the whole UTC day, `contact-info`, `report-id`, one `policies` entry per policy with its `summary` and `failure-details`), gzips it, and drops it past 1,000,000 bytes (RFC 8460 notes receivers limit around 10 MB; with the caps a report is a few KB).
7. For each reporting address of the record (at most 5) that has not got it yet:
   - a `mailto:` address on BunMail's suppression list, under any API key and for any reason (the send gate's notion of an active suppression; `isSuppressedForAnyKey`), gets nothing: logged at `debug`, counted as `suppressed`, not retried;
   - it takes a slot of the destination's and of the instance's [daily caps](#daily-caps);
   - `mailto:`: from `SYSTEM_MAIL_FROM` through BunMail's own outbound path (`sendSystemMail`), `multipart/report; report-type=tlsrpt` with a short text part and the report as `application/tlsrpt+gzip`, file name `<submitter>!<policy-domain>!<begin>!<end>.json.gz`, subject `Report Domain: <policy-domain> Submitter: <submitter> Report-ID: <<report-id>>`, and the `TLS-Report-Domain` and `TLS-Report-Submitter` header fields, all DKIM-signed (both fields are in the signed set). MTA-STS is not applied to a report and its own sessions are not recorded (RFC 8460 section 5.3: a report about TLS failures must get through them). **Tighter limits** than an ordinary send (`sendMail`'s `deliveryLimits`): 2 minutes of SMTP session time in all and at most 2 MX hosts, so a domain whose MX hosts tarpit cannot hold the job;
   - `https:`: a `POST` of the gzipped report as `application/tlsrpt+gzip`, 30 s at most; any `2xx` is delivered. See [SSRF](#ssrf-https-reporting-addresses).
8. Every address served (or skipped for want of a mail sender, or suppressed): the report and its counters are deleted. A failed delivery: retried after 30 min, 1 h, 2 h, 4 h, then 8 h (about 15 h in all, inside RFC 8460 section 5.5's day), only to the addresses still owed, and dropped after the sixth attempt. Only a destination's cap held it back: deferred to tomorrow (see below).

**At least once:** a replica that dies after a delivery and before it records it leaves the report claimed; when the lease ends, another replica sends it again to the addresses it had not recorded, so a receiver can, rarely, get one report twice (the same `report-id`, which receivers use to de-duplicate).

## Daily caps

The reporting addresses come from the recipient domains' DNS, and any API caller picks the recipient domains, so without caps a sender who controls many domains could make BunMail mail or POST one report a day per domain to addresses of its choosing, and any domain can name any third party's mailbox or URL. Two caps bound that, both counted atomically in the database so every replica shares them:

- **`TLSRPT_MAX_REPORTS_PER_DAY`** (default 500): deliveries per UTC day for the whole instance (`tlsrpt_daily_sends`).
- **`TLSRPT_MAX_REPORTS_PER_DESTINATION_PER_DAY`** (default 50): deliveries per UTC day to one destination, the lower-cased mail address or the URL's origin, so different paths or address case do not escape it (`tlsrpt_destination_sends`, by hash). The default of 50 is a trade-off: shared report collectors receive many domains' reports on one HTTPS origin, and a much lower cap would defer legitimate reports every day, while 50 still bounds what any single victim can receive per day, under the global cap.

Each delivery takes one slot of each before it is attempted, in one transaction of two upserts that increment only while under their caps (a refused daily slot gives the destination slot back). A failed delivery keeps its slots (it reached the receiver); a `mailto:` skipped for want of a usable `SYSTEM_MAIL_FROM` gives them back.

- **Destination cap reached:** that address waits; once the report's other addresses are served, the report is deferred to tomorrow (its claim's attempt given back), for the addresses still owed. Counted as `outcome="capped"` with its scheme, logged at `debug`.
- **Daily cap reached:** the job stops for the rest of the UTC day (later runs, on every replica, check the counter and claim nothing) and defers every report of a past day still to send, the one it was sending included, to tomorrow, one to five hours after midnight UTC (random per report): none is sent later today in a burst, and tomorrow's cap applies to them. Nothing is lost while within the 7-day retention. One replica logs `TLS report daily cap reached` at `warn` once that day (`cap`, `reportsLeft`: the reports deferred then), and `bunmail_tlsrpt_reports_total{scheme="any",outcome="capped"}` counts them.

## SSRF: https reporting addresses

An `https:` reporting URL is chosen by whoever controls the recipient domain's DNS, so BunMail treats it as hostile, exactly like a webhook URL (#128), on every attempt (`tls-rpt-https.service.ts`):

- `https:` only (never `http:`, whatever `WEBHOOK_ALLOW_INSECURE_HTTP` says); no credentials or fragment in the URL; at most 2,048 characters.
- The host is resolved once and refused when any address is private, loopback, link-local, CGNAT, multicast, reserved or a scoped IPv6 address (`resolvePublicWebhookTarget`); the request then goes to that checked address (`buildPinnedRequest`), with the host name as SNI, `Host` header and certificate name. The certificate is verified (RFC 8460 lets a submitter skip that; BunMail does not).
- No redirects (`3xx` is a failure), no connection reuse, no decompression, a 30 s timeout, and the response body is never read, only cancelled.

A `mailto:` address must be one plain ASCII address after percent-decoding: no `?` header fields (which could add recipients or headers), no control characters (`%00`, `%0D%0A`), none of `( ) [ ] \ ; : ,` (comments, address literals, routes, lists), nothing outside ASCII. Its MX goes through the usual MX address check (`MAIL_ALLOW_PRIVATE_MX`). Addresses are de-duplicated by their normalised form (`mailto:` and the whole address lower-cased; for `https:`, the parsed URL), so a record cannot list one mailbox several times by changing its case.

## Logs and metrics

- `TLS report sent` (`info`), `TLS report skipped` and `TLS report not delivered` (`warn`), `TLS report not mailed: the address is suppressed` and `TLS report held back: the destination's daily cap is reached` (`debug`), one line per address and attempt: `policyDomain`, `day`, `attempt`, `scheme`, the address (`redactEmail` for mail, only the URL's origin for https: the path or query may carry a token), `policies`, `successful`, `failed`, `bytes`, and a fixed `reason` on failure.
- `TLS report dropped after its last attempt`, `TLS report dropped: larger than the size cap`, `TLS report not sent: TLS-RPT record lookup failed` (`warn`), `TLS report not sent: the domain no longer publishes a TLS-RPT record` (`info`), `TLS report handling failed` (`error`, error name only).
- `TLS report daily cap reached` (`warn`), once per UTC day across replicas, with `cap` and `reportsLeft`.
- `TLS report handed back: the run's time budget ran out` (`debug`).
- `TLS report run completed` (`info`) once per run that did anything, with its counts (`suppressed`, `destinationCapped`, `capped`, `released` included).
- `TLS-RPT session recorded` (`debug`) per recorded session; `TLS-RPT session not recorded: too many recordings running` (`debug`, at most once a minute).
- Prometheus (see [metrics.md](metrics.md)): `bunmail_tlsrpt_sessions_total{result}` (`success`, `failure`, `dropped`) and `bunmail_tlsrpt_reports_total{scheme,outcome}` (`mailto`/`https`; `sent`, `skipped`, `suppressed`, `capped` for the destination cap, `retry`, `dropped`; and `scheme="any"`, `outcome="capped"` for reports deferred by the daily cap).

## Module layout

```
src/modules/tls-rpt/
  ├── models/
  │   ├── tls-rpt-daily-send.schema.ts ← tlsrpt_daily_sends, tlsrpt_destination_sends (the caps)
  │   ├── tls-rpt-report.schema.ts    ← tlsrpt_reports
  │   └── tls-rpt-result.schema.ts    ← tlsrpt_results
  ├── services/
  │   ├── tls-rpt-record.ts           ← _smtp._tls parsing, lookup, cache
  │   ├── tls-rpt-classify.ts         ← policy and result type of a session
  │   ├── tls-rpt-aggregate.ts        ← counter keys, caps, UTC day, due time
  │   ├── tls-rpt-observe.service.ts  ← the mailer's hand-off (background recording)
  │   ├── tls-rpt-store.service.ts    ← the only DB access
  │   ├── tls-rpt-report.ts           ← JSON, file name, subject, gzip
  │   ├── tls-rpt-mailto.service.ts   ← mail delivery (sendSystemMail)
  │   ├── tls-rpt-https.service.ts    ← HTTPS delivery through the SSRF guard
  │   ├── tls-rpt-deliver.service.ts  ← one report to its addresses (caps, suppression, retries)
  │   └── tls-rpt-job.service.ts      ← the run: workers, time budget, daily cap, scheduling
  └── types/
      ├── tls-rpt.types.ts
      └── tls-rpt-job.types.ts        ← the job's steps and run summary
```

No REST endpoint and no dashboard page. The suppression check for reporting addresses is `src/modules/suppressions/services/suppression-check.service.ts`. Config: `src/config/tls-rpt.ts` (`buildTlsRptConfig`, `config.tlsRpt`).

## Limits

- Without an MTA-STS `enforce` policy, certificates are not verified, so certificate problems of other domains are not reported (their sessions count as successes when STARTTLS worked).
- `testing` policies are reported from the same opportunistic session: an MX outside the policy and plaintext sessions show, certificate problems do not.
- Recording is best-effort: a database error loses that session's count (logged). A report covers what this BunMail's replicas recorded, all replicas writing to the same rows.
- DANE (`tlsa`, `dnssec-invalid`, `dane-required`) is not implemented.
