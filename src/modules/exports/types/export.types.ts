/**
 * Types of the dashboard CSV exports (#430).
 *
 * An export reads one dashboard table in batches (keyset pagination on
 * the table's ordering) and hands each batch on as rows of plain cells,
 * already projected to an explicit, metadata-only column list. The CSV
 * text itself is written by the dashboard (`src/pages/lib/csv.ts`): this
 * module only decides which rows and which columns leave the database.
 */

/**
 * Every exportable table, as it appears in the file name
 * (`bunmail-<table>-<date>.csv`) and in the `export.downloaded` audit
 * event. One per dashboard table.
 */
export const EXPORT_TABLES = [
  "emails",
  "emails-trash",
  "tombstones",
  "inbound",
  "inbound-trash",
  "suppressions",
  "audit-log",
  "dmarc-reports",
  "webhook-deliveries",
  "api-keys",
  "domains",
  "templates",
  "webhooks",
  "users",
  "invitations",
] as const;

/** One exportable table. */
export type ExportTable = (typeof EXPORT_TABLES)[number];

/**
 * One cell before CSV encoding. Dates are written as ISO 8601 UTC,
 * booleans as `true` / `false`, `null` as an empty field.
 */
export type CsvCell = string | number | boolean | Date | null;

/**
 * Where the next batch starts: the ordering column of the last row read,
 * as Postgres text (full microsecond precision, which a JS `Date` would
 * lose), and that row's id, the tie-breaker.
 */
export interface ExportCursor {
  /** The ordering timestamp of the last row, rendered by Postgres (`::text`). */
  at: string;
  /** The id of the last row. */
  id: string;
}

/** What every batch query returns beside its columns: the keyset of the row. */
export interface KeysetRow {
  /** Primary key, the keyset tie-breaker. */
  id: string;
  /** The ordering column as Postgres text (`ExportCursor.at`). */
  cursorAt: string;
}

/** One column of an export: its header and how a row fills it. */
export interface ExportColumn<Row> {
  /** Header cell, snake_case like the database column it comes from. */
  header: string;
  /** The cell for one row: metadata only, never a body, secret or token. */
  value: (row: Row) => CsvCell;
}

/** One batch of an export: rows of cells, and where the next batch starts. */
export interface ExportBatch {
  /** The rows of this batch, each with one cell per header. */
  rows: CsvCell[][];
  /** The cursor after the last row, or `null` when this batch was the last. */
  next: ExportCursor | null;
}

/**
 * One export, bound to the filters of the page it was started from. The
 * dashboard streams it: the header row first, then `fetchBatch` until it
 * returns no cursor or the row cap is reached.
 */
export interface ExportSource {
  /** Which table this is. */
  table: ExportTable;
  /** The header row, in column order. */
  headers: readonly string[];
  /**
   * The next `limit` rows after `cursor` (the first rows with `null`), in
   * the table's order. Throws the driver's error on a database failure.
   */
  fetchBatch: (cursor: ExportCursor | null, limit: number) => Promise<ExportBatch>;
}
