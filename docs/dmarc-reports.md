# DMARC Reports Module

Ingests **DMARC aggregate (`rua`) reports** that arrive at BunMail's inbound SMTP, parses the XML, and stores them as queryable rows for the dashboard + REST API. Each report covers a 24-hour window of authentication outcomes for messages claiming to be from your domain.

When you publish `_dmarc.<your-domain>` with `rua=mailto:dmarc@<your-domain>`, every major receiver (Microsoft, Google, Yahoo, Mail.ru, …) sends you a **daily aggregate report** as an XML attachment. These reports are how operators discover **misaligned source IPs** — the signal that someone else's mail is getting forwarded with your `From:` header, or that a third-party sender (Mailchimp, transactional ESP, marketing tool) has been onboarded without DKIM/SPF being wired up correctly.

This module turns that XML stream into a usable view.

## Inbound branching

The DMARC handler sits in [`smtp-receiver`](../src/modules/inbound/services/smtp-receiver.service.ts) **after the bounce branch** and **before the generic inbound storage**:

```
Inbound message
  ├── Looks like a bounce?                → bounce-handler            (#24)
  ├── Looks like a DMARC aggregate report? → dmarc-handler            (#41) ← this module
  └── Otherwise                            → inbound_emails (generic)
```

A successfully parsed-and-stored DMARC report **short-circuits** the generic inbound insert — there's no point keeping the raw report wrapped as a generic inbound row, the parsed shape is what operators actually want.

## Detection heuristic

[`looksLikeDmarcReport`](../src/modules/dmarc-reports/services/dmarc-parser.service.ts) is a cheap pre-filter that runs against the raw RFC 5322 bytes before we attempt the (more expensive) XML parse. Any of:

- **Sender** matches `noreply@enterprise.protection.outlook.com`, `noreply-dmarc-support@google.com`, `dmarcreport@yahoo.com`, etc.
- **Subject** mentions `Report Domain:` or `DMARC` aggregate language.
- **Content-Type** is `application/zip` / `multipart/report` **and** the body mentions DMARC.

The full parse is only attempted when the heuristic matches **and** there's at least one attachment that decompresses-and-parses to an RFC 7489 `<feedback>` document. If neither of those holds, the message falls through to the generic inbound path (a regular customer email mentioning "DMARC" in the subject won't get accidentally classified).

## Parser strategies (attachment formats)

DMARC reports are XML, but receivers compress them three different ways depending on vendor preference. The parser sniffs **magic bytes** rather than trusting `Content-Type` or filename, since both are notoriously inconsistent across implementations.

| Format       | Magic bytes        | Used by              | Decompression                  |
| ------------ | ------------------ | -------------------- | ------------------------------ |
| **gzip**     | `1f 8b`            | Google, Yahoo        | `fflate.Gunzip` (capped)       |
| **zip**      | `50 4b 03 04`      | Microsoft            | `fflate.Unzip` (capped)        |
| **raw XML**  | `<?xml`            | Some smaller vendors | none                           |

Anything else returns `null` and the attachment is skipped. Multi-attachment messages are walked in order — the first one that parses wins.

### DoS hardening (#129)

The inbound receiver is **unauthenticated** — anyone can send a crafted report — so decompression is bounded:

- **Output-size cap (decompression bomb):** gzip/zip are inflated with fflate's **streaming** decompressors (`Gunzip`/`Unzip`), fed in 64 KB input slices, and aborted the moment cumulative output crosses **25 MB** (`MAX_DECOMPRESSED_BYTES`). A tiny attachment can otherwise expand ~1000:1 and OOM the process; the cap bounds it (a real RFC 7489 report is far smaller). On abort the attachment is dropped (`null`) and normal inbound storage takes over.
- **XML entity expansion (billion laughs):** the parser runs with `processEntities: false`, and any input containing a `<!DOCTYPE` is rejected before parsing (RFC 7489 reports never carry one; its only use here would be a nested-entity CPU bomb). fast-xml-parser doesn't fetch external entities, so there's no classic file-read/SSRF XXE.

## XML shape (RFC 7489 `<feedback>`)

The parser maps the canonical DMARC schema into two flat shapes:

### Report-level (one row per report)

| Field         | Source XPath                                            |
| ------------- | ------------------------------------------------------- |
| `orgName`     | `feedback.report_metadata.org_name`                     |
| `orgEmail`    | `feedback.report_metadata.email`                        |
| `reportId`    | `feedback.report_metadata.report_id`                    |
| `domain`      | `feedback.policy_published.domain`                      |
| `dateBegin` / `dateEnd` | `feedback.report_metadata.date_range.begin/end` (unix-seconds → JS `Date`) |
| `policyP`     | `feedback.policy_published.p`                           |
| `policyPct`   | `feedback.policy_published.pct`                         |
| `rawXml`      | The decompressed XML string, kept verbatim for forensics |

### Per-record (one row per source IP, child of the report)

| Field            | Source XPath                                       |
| ---------------- | -------------------------------------------------- |
| `sourceIp`       | `record.row.source_ip`                             |
| `count`          | `record.row.count`                                 |
| `disposition`    | `record.row.policy_evaluated.disposition`          |
| `dkimAligned`    | `record.row.policy_evaluated.dkim` (`pass` → true) |
| `spfAligned`     | `record.row.policy_evaluated.spf` (`pass` → true)  |
| `headerFrom`     | `record.identifiers.header_from`                   |
| `dkimAuthDomain` | `record.auth_results.dkim.domain`                  |
| `dkimSelector`   | `record.auth_results.dkim.selector`                |
| `dkimResult`     | `record.auth_results.dkim.result`                  |
| `spfAuthDomain`  | `record.auth_results.spf.domain`                   |
| `spfResult`      | `record.auth_results.spf.result`                   |

### `fast-xml-parser` scalar/array quirk

When a `<feedback>` document has **exactly one `<record>`**, `fast-xml-parser` collapses it into a scalar object instead of a single-element array. The parser coerces both shapes via a `toArray()` helper so downstream code always sees a list.

## Dedup

The unique constraint is `UNIQUE (org_email, report_id)`. Re-receiving the same report — common when receivers retry on transient SMTP failures — is detected via `ON CONFLICT DO NOTHING`. The handler returns `outcome: "duplicate"` with the original report id so the caller can log "we already have this" without polluting metrics.

`reportId` alone is **not** unique: different receivers happily reuse short numeric ids ("1", "2", …), so we scope by their `org_email` to disambiguate.

## Storage shape

Two tables under `src/modules/dmarc-reports/models/`:

- [`dmarc_reports`](../src/modules/dmarc-reports/models/dmarc-report.schema.ts) — one row per received report, with `rawXml` for forensics.
- [`dmarc_records`](../src/modules/dmarc-reports/models/dmarc-record.schema.ts) — one row per source-IP record, FK to `dmarc_reports.id` with `ON DELETE CASCADE`.

Indexed on `(domain, date_end DESC)` — the dashboard's hot path is "show me the latest reports for `yourdns.example`".

### Why no tenant scoping?

DMARC aggregate reports are **operator-level** data — they describe authentication outcomes for the whole domain, not per-API-key. A single self-hosted BunMail instance is one operator's domain; tenant scoping would be modelling a multi-tenant cloud service we don't run. The `domain` column is plain text, not a FK to `domains` — receivers send reports for whatever you publish in `_dmarc`, including domains you've since removed.

## Read API

REST endpoints under `/api/v1/dmarc-reports/` (Bearer auth + rate limit, like every other API):

| Verb | Path                            | Description                           |
| ---- | ------------------------------- | ------------------------------------- |
| GET  | `/api/v1/dmarc-reports`         | Paginated list, optional `?domain=`   |
| GET  | `/api/v1/dmarc-reports/:id`     | Single report + per-source-IP records |

Dashboard pages mirror the REST endpoints:

- `/dashboard/dmarc-reports` — filterable list (pill buttons per domain)
- `/dashboard/dmarc-reports/:id` — summary cards + per-source-IP table + raw XML

## What we do **not** do (yet)

- **No webhook event** — `email.dmarcReceived` was deliberately deferred. Aggregate reports arrive once per day from a small set of receivers; consumers who want notifications can poll `GET /api/v1/dmarc-reports`. We'll revisit if there's demand.
- **No backfill** — only reports that arrive after this module shipped are stored. Receivers don't re-send historical reports anyway.
- **No `ruf` (failure / forensic) reports** — those are a separate format and almost no major receiver actually sends them anymore (privacy concerns). Out of scope.
- **No alerting on misalignment** — the dashboard highlights misaligned rows in amber, but there's no email/webhook on threshold breach. Operators read the dashboard.

## Testing

- **Unit:** [`test/unit/dmarc-parser.test.ts`](../test/unit/dmarc-parser.test.ts) — RFC 7489 happy path, gzip + zip + raw decompression, the scalar/array quirk, malformed/missing-field drop paths, the `looksLikeDmarcReport` heuristic, and DoS resistance (#129: gzip/zip decompression bombs → `null`, billion-laughs DOCTYPE → `null`, a just-under-cap report still parses). Stored-XSS escaping of report fields is covered by [`test/unit/dmarc-xss.test.ts`](../test/unit/dmarc-xss.test.ts) (#131).
- **Integration:** [`test/integration/dmarc-handler.integration.test.ts`](../test/integration/dmarc-handler.integration.test.ts) — 8 cases covering happy-path persistence, `ON CONFLICT` dedup, `ON DELETE CASCADE`, the skip-when-not-DMARC path, and the read-side `listDmarcReports` + `getDmarcReportById` plumbing against real Postgres.

## Manual smoke test (against staging)

```bash
# 1. Publish your DMARC TXT record (one-time, outside BunMail)
#    _dmarc.your-domain.com. IN TXT "v=DMARC1; p=quarantine; pct=100; rua=mailto:dmarc@your-domain.com"

# 2. Wait ~24h for the first reports to arrive (Microsoft is usually first).

# 3. Confirm via the REST API
curl https://your-host/api/v1/dmarc-reports \
  -H "Authorization: Bearer YOUR_KEY"

# 4. Inspect the dashboard
open https://your-host/dashboard/dmarc-reports
```
