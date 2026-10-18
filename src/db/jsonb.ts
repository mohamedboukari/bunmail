import { customType } from "drizzle-orm/pg-core";

/**
 * A `jsonb` column that stores real JSON (#261).
 *
 * Drizzle's built-in `jsonb` serializes the value with `JSON.stringify`
 * before handing it to the `bun-sql` driver, which then encodes that
 * string again: every row was stored as a jsonb **string**
 * (`jsonb_typeof = 'string'`), so SQL containment (`@>`), key and path
 * operators and jsonb indexes matched nothing. Passing the value itself
 * lets the driver encode it once, as the array or object it is. (A
 * `::jsonb` cast on the stringified value is encoded twice too; checked
 * against Bun 1.3.14.)
 *
 * The same applies to query parameters: `${'["a"]'}::jsonb` binds a jsonb
 * string. Build JSON values in SQL from plain parameters instead, e.g.
 * `col @> jsonb_build_array(${value}::text)`.
 *
 * Reads parse a string value back, so rows written before the fix (and
 * before migration `0022` rewrote them) still load as arrays and objects.
 *
 * @example deliveryState: jsonb<DeliveryState | null>("delivery_state")
 */
export function jsonb<T>(name: string) {
  return customType<{ data: T; driverData: T }>({
    dataType: () => "jsonb",
    toDriver: (value) => value,
    fromDriver: (value): T => {
      if (typeof value !== "string") return value;
      /** A legacy string-stored row: parse it back (`JSON.parse` is untyped). */
      const parsed: T = JSON.parse(value);
      return parsed;
    },
  })(name);
}
