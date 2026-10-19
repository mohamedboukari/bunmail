import { customType } from "drizzle-orm/pg-core";

/**
 * A `bytea` column holding raw bytes (#181). Bun's SQL driver binds a
 * `Uint8Array` parameter as `bytea` and returns a `bytea` value as a
 * `Buffer` (a `Uint8Array`), so both directions pass the value through
 * as it is: no hex or base64 text is ever built.
 *
 * @example content: bytea("content")
 */
export function bytea(name: string) {
  return customType<{ data: Uint8Array; driverData: Uint8Array }>({
    dataType: () => "bytea",
    toDriver: (value) => value,
    fromDriver: (value) => value,
  })(name);
}
