# Exports (#430)

The read side of the dashboard CSV exports: which rows and which columns of each table may leave the database. The routes, the CSV format, the row cap, the limits and the audit event are described in [dashboard.md](dashboard.md#csv-exports-430); this page covers the module. No tables of its own (it adds indexes to others, below), no REST plugin.

## Module layout

```
src/modules/exports/
├── services/
│   ├── keyset.ts                  ← keyset batch pieces, defineExportSource, listCell
│   ├── mail-exports.service.ts    ← emails, emails trash, tombstones, inbound, inbound trash
│   ├── record-exports.service.ts  ← suppressions, audit log, DMARC reports, webhook deliveries
│   └── setting-exports.service.ts ← API keys, domains, templates, webhooks, users, invitations
└── types/
    └── export.types.ts            ← EXPORT_TABLES, CsvCell, ExportCursor, KeysetRow, ExportColumn, ExportBatch, ExportSource
```

The dashboard side lives in `src/pages/`: `plugins/exports.plugin.tsx` (the routes), `lib/csv.ts` (the writer), `lib/csv-export.tsx` (the stream, row cap, audit and log line), `lib/export-limiter.ts` (the budget), `components/export-csv-link.tsx` (the link).

## Types

- `ExportTable`: one of `EXPORT_TABLES` (`emails`, `emails-trash`, `tombstones`, `inbound`, `inbound-trash`, `suppressions`, `audit-log`, `dmarc-reports`, `webhook-deliveries`, `api-keys`, `domains`, `templates`, `webhooks`, `users`, `invitations`), used in the file name and the audit event.
- `CsvCell`: `string | number | boolean | Date | null`, encoded by the dashboard's writer.
- `ExportCursor`: `{ at, id }`, the ordering timestamp of the last row as Postgres text (`::text`, microseconds kept) and its id.
- `ExportColumn<Row>`: `{ header, value(row) }`.
- `ExportSource`: `{ table, headers, fetchBatch(cursor, limit) }`, one table bound to the page's filters; `fetchBatch` returns `{ rows: CsvCell[][], next }`, `next` being `null` after the last batch.

## Service methods

One factory per table, each returning an `ExportSource`:

| Factory | Filters | Order |
|---------|---------|-------|
| `emailsExport(filters)` | the email list's (`allEmailsWhere`: status, source, API key, tags), not trashed | `created_at DESC, id DESC` |
| `emailsTrashExport()` | trashed | `deleted_at DESC, id DESC` |
| `tombstonesExport(messageId)` | `allTombstonesWhere` | `purged_at DESC, id DESC` |
| `inboundExport()` / `inboundTrashExport()` | not trashed / trashed | `received_at` / `deleted_at DESC, id DESC` |
| `suppressionsExport({ email, apiKeyId })` | `allSuppressionsWhere` | `created_at DESC, id DESC` |
| `auditLogExport({ action, actor, outcome })` | `auditFilterClause` | `occurred_at DESC, id DESC` |
| `dmarcReportsExport(domain)` | the domain | `date_end DESC, id DESC` |
| `webhookDeliveriesExport(webhookId, status)` | the webhook, the status | `created_at DESC, id DESC` |
| `apiKeysExport(tab)` | `is_active` by the page's tab | `created_at DESC, id DESC` |
| `domainsExport()`, `templatesExport()`, `webhooksExport()` | none | `created_at DESC, id DESC` |
| `usersExport()` | none | `created_at ASC, id ASC` (like the page) |
| `invitationsExport()` | `liveInvite()` (pending) | `created_at DESC, id DESC` |

The filter clauses are the ones the list pages use, exported by their own modules (`allEmailsWhere`, `allTombstonesWhere`, `allSuppressionsWhere`, `auditFilterClause`, `liveInvite`), so an export cannot drift from its page.

Every factory goes through `defineExportSource({ table, order, columns, rows })`. `rows(page)` is the table's own `SELECT`, naming each field it reads (never `select()` of the whole row), with `page.cursorAt` beside them, `and(filters, page.after)` as the condition, `...page.orderBy` and `page.limit`. `keysetPage` builds those pieces: the condition `(at, id) < (cursor.at::<column type>, cursor.id)` (`>` for ascending order). A batch shorter than its limit ends the export.

A webhook URL is exported as `url_origin`, its origin only, through `redactUrl` (`src/utils/redact.ts`, the policy of the webhook audit label and log lines, #260): Slack, Discord, Teams, Mattermost and Zapier put the receiver's secret in the path, others in the query or user info, so no part past the host is safe. `listCell(values)` joins a list with `; `.

## Indexes

Migration `0044` adds a `(ts DESC, id DESC)` index (`NULLS FIRST`, the default of `ORDER BY ... DESC`, so it matches the batch query's order exactly) for each walk that had none: `idx_emails_live_created_id` (partial, `deleted_at IS NULL`), `idx_emails_trash_deleted_id` (partial, `deleted_at IS NOT NULL`), `suppressions_created_id_idx`, `idx_email_tombstones_purged_id`, `dmarc_reports_date_end_id_idx`. The other tables are small (keys, domains, templates, webhooks, users, invitations) or already ordered by an index (`audit_events`, inbound, deliveries per webhook).

## Memory

Batches are read in turn, but Bun 1.3.14 drains a streamed response as fast as it is produced, whatever the client reads: a stalled client still makes the server build and buffer the whole file. What bounds memory is the row cap (50 000 rows per export) and the per-process concurrency limit (2 exports producing at once, `src/pages/lib/export-limiter.ts`). For the same reason, the audit event's `rows` and outcome describe what the server produced, not what the client received.

## Tests

- `test/unit/csv-writer.test.ts`: the writer (quoting, CRLF, BOM, formula escape, also after invisible prefixes and `;` separators, invalid dates, unicode), `listCell`, the file name.
- `test/integration/csv-export-tables.integration.test.ts`: per table, the exact header row, the seeded rows, and none of the planted secrets or bodies; cell contents (Slack and Discord webhook URLs reduced to their origin); every page filter.
- `test/integration/csv-export-limits.integration.test.ts`: the concurrency limit and its slot release (finished, cancelled, 503, a failed first batch), `Sec-Fetch-Site`, a Postgres `infinity` timestamp.
- `test/integration/csv-export-indexes.integration.test.ts`: each keyset query is served by its `0044` index, in order, with no Sort node.
- `test/integration/csv-export-stream.integration.test.ts`: headers and BOM, batches (one chunk per batch, microsecond ties), the row cap, the audit event and log line, a failure mid-stream, the rate limit (and its audited refusal), access and the link.
- `test/integration/dashboard-route-access.integration.test.ts`: every export route is `admin`.
