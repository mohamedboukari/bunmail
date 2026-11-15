/**
 * A timestamp column value as a real instant, or `null` when it has none
 * (#457).
 *
 * Postgres accepts `infinity` and `-infinity` in a `timestamp` column.
 * BunMail never writes them, but a hand-edited row can hold one, and the
 * driver decodes it as the number `Infinity` (`-Infinity`) under Bun 1.4,
 * as an invalid `Date` under Bun 1.3.14; drizzle passes either through
 * although the column is typed `Date`. Calling `toISOString()` or
 * `getTime()` on such a value throws, and writing it back throws in
 * drizzle's encoder. Anything that formats, measures or copies a read
 * timestamp goes through this first and treats `null` as "no date".
 *
 * The parameter admits `number` because that is what the driver hands
 * over at runtime; a `Date`-typed column value is accepted as it is.
 */
export function finiteDate(value: Date | number | null | undefined): Date | null {
  if (!(value instanceof Date)) return null;
  return Number.isFinite(value.getTime()) ? value : null;
}
