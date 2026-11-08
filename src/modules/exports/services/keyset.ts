import { asc, desc, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type {
  ExportColumn,
  ExportCursor,
  ExportSource,
  ExportTable,
  KeysetRow,
} from "../types/export.types.ts";

/**
 * Keyset pagination for the CSV exports (#430).
 *
 * Every export walks its table in a fixed order, `(timestamp, id)`, and
 * each batch starts strictly after the last row of the previous one. Unlike
 * `OFFSET`, a batch never rescans the rows already read, and a row added
 * or removed meanwhile neither repeats nor skips another.
 *
 * The cursor's timestamp travels as Postgres text (`::text`), not as a JS
 * `Date`: Postgres keeps microseconds and a `Date` only milliseconds, so a
 * `Date` cursor would skip every row whose timestamp falls inside the
 * same millisecond as the cursor but before it. The text is cast back to
 * the column's own type (`getSQLType()`, a code constant) for the
 * comparison.
 */

/** The order an export walks its table in. The timestamp column must be NOT NULL (or filtered to non-null). */
export interface KeysetOrder {
  /** The ordering timestamp column. */
  at: PgColumn;
  /** The primary key, the tie-breaker between rows with the same timestamp. */
  id: PgColumn;
  /** Newest first (`desc`, most tables) or oldest first (`asc`, the users page). */
  direction: "asc" | "desc";
}

/** What a source's batch query gets to build its `SELECT`. */
export interface KeysetPage {
  /** The condition "after the cursor", or `undefined` for the first batch: AND it with the filters. */
  after: SQL | undefined;
  /** The `ORDER BY` terms: spread them into `.orderBy(...)`. */
  orderBy: SQL[];
  /** The `cursorAt` field to select beside the columns. */
  cursorAt: SQL<string>;
  /** The batch size: pass it to `.limit()`. */
  limit: number;
}

/** The pieces of one batch query for `order`, after `cursor`. */
export function keysetPage(
  order: KeysetOrder,
  cursor: ExportCursor | null,
  limit: number,
): KeysetPage {
  const direction = order.direction === "asc" ? asc : desc;
  const comparison = sql.raw(order.direction === "asc" ? ">" : "<");
  const type = sql.raw(order.at.getSQLType());
  return {
    after: cursor
      ? sql`(${order.at}, ${order.id}) ${comparison} (${cursor.at}::${type}, ${cursor.id})`
      : undefined,
    orderBy: [direction(order.at), direction(order.id)],
    cursorAt: sql<string>`${order.at}::text`,
    limit,
  };
}

/** What `defineExportSource` needs for one table. */
interface ExportSpec<Row extends KeysetRow> {
  table: ExportTable;
  order: KeysetOrder;
  /** The explicit column list: metadata only. */
  columns: readonly ExportColumn<Row>[];
  /** One batch: the source's own `SELECT` of exactly the fields its columns read. */
  rows: (page: KeysetPage) => Promise<Row[]>;
}

/**
 * Builds an `ExportSource` from a table's order, columns and batch query:
 * runs the query, turns each row into its cells, and sets the next cursor
 * from the last row (none when the batch came back short: nothing follows).
 */
export function defineExportSource<Row extends KeysetRow>(
  spec: ExportSpec<Row>,
): ExportSource {
  return {
    table: spec.table,
    headers: spec.columns.map((column) => column.header),
    async fetchBatch(cursor, limit) {
      const rows = await spec.rows(keysetPage(spec.order, cursor, limit));
      const last = rows.at(-1);
      return {
        rows: rows.map((row) => spec.columns.map((column) => column.value(row))),
        next:
          last !== undefined && rows.length === limit
            ? { at: last.cursorAt, id: last.id }
            : null,
      };
    },
  };
}

/**
 * A JSON-ish list cell (`allowed_senders`, `events`, `variables`): the
 * values joined with `; `, or empty for none. Not JSON, so a spreadsheet
 * shows it plainly; no value of these lists contains `; `.
 */
export function listCell(values: readonly string[] | null | undefined): string {
  return (values ?? []).join("; ");
}
