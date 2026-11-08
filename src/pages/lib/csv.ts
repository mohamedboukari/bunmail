import { logger } from "../../utils/logger.ts";
import type { CsvCell } from "../../modules/exports/types/export.types.ts";

/**
 * A small RFC 4180 CSV writer for the dashboard exports (#430). In repo,
 * no dependency: the whole format is the few rules below.
 *
 * - Records end with CRLF (RFC 4180 section 2.1), the last one included.
 * - A field containing `"`, `,`, CR or LF is wrapped in double quotes,
 *   and every `"` inside it is doubled (section 2.5 to 2.7). A field
 *   containing `;` or a tab is quoted too, so a spreadsheet set to split
 *   on `;` (Excel in German, French or Dutch) keeps it in one cell.
 *   Other fields are written as they are.
 * - Formula injection (OWASP "CSV Injection"): a cell a spreadsheet would
 *   run as a formula (`=HYPERLINK(...)`, `@SUM(...)`, DDE `=cmd|...`) is
 *   neutralised with a `'`, which spreadsheets show as text and never
 *   evaluate. Dangerous are a text cell whose first character is a tab or
 *   a CR, or whose first visible character (after spaces, no-break spaces
 *   and the zero-width U+200B and U+FEFF) is `=`, `+`, `-` or `@`: the
 *   whole cell gets a leading `'`. Also, inside a cell, a `;` or a tab
 *   followed (after such spaces) by one of those characters: in a `;`
 *   locale that starts a new cell, so the character gets a `'` before it.
 *   Applied before quoting, so the quote rules still hold. Only text
 *   cells are escaped: numbers, booleans and dates are written by BunMail
 *   itself, never by a user.
 * - The file is UTF-8 and starts with a byte order mark (`CSV_BOM`):
 *   without it Excel reads a CSV as the local ANSI code page and garbles
 *   every accented name or subject. Other tools (LibreOffice, Google
 *   Sheets, Python's `csv` with `utf-8-sig`, `pandas`) skip it.
 * - A date that is not a valid instant (Postgres `infinity` becomes an
 *   invalid `Date`) is written as an empty field, never thrown on.
 */

/** UTF-8 byte order mark, written once before the header row. */
export const CSV_BOM = "﻿";

/**
 * A cell a spreadsheet would read as a formula: a leading tab or CR, or a
 * formula character as the first visible one (`\s` covers spaces, tabs,
 * the no-break space and U+FEFF; U+200B is added).
 */
const FORMULA_START = /^(?:[\t\r]|[\s​]*[=+\-@])/;

/** A `;` or tab separator, optional spaces, then a formula character. */
const FORMULA_AFTER_SEPARATOR = /([;\t][  ​﻿]*)([=+\-@])/g;

/** Characters that force a field into quotes (RFC 4180, plus the `;` locales' separator and tab). */
const NEEDS_QUOTES = /[",\r\n;\t]/;

/** A date as ISO 8601 UTC, or empty (logged at `debug`) when it is not a valid instant. */
function dateText(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    logger.debug("CSV export: invalid date written as an empty cell");
    return "";
  }
  return date.toISOString();
}

/** A cell as text: dates as ISO 8601 UTC, booleans as `true` / `false`, `null` as empty. */
function cellText(cell: CsvCell): string {
  if (cell === null) return "";
  if (cell instanceof Date) return dateText(cell);
  return String(cell);
}

/**
 * Neutralises a text value a spreadsheet would run as a formula: a `'`
 * before the whole value when it starts like a formula, and before each
 * formula character that follows a `;` or tab separator. Anything else is
 * returned unchanged.
 */
export function escapeFormula(value: string): string {
  const inner = value.replace(FORMULA_AFTER_SEPARATOR, "$1'$2");
  return FORMULA_START.test(inner) ? `'${inner}` : inner;
}

/** One field, formula-escaped (text cells only) and quoted when it must be. */
export function csvField(cell: CsvCell): string {
  const text = typeof cell === "string" ? escapeFormula(cell) : cellText(cell);
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One record: the fields joined by commas, ended by CRLF. */
export function csvRow(cells: readonly CsvCell[]): string {
  return `${cells.map(csvField).join(",")}\r\n`;
}
