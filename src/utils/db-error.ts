import { DrizzleQueryError } from "drizzle-orm";

/**
 * The Postgres SQLSTATE of a failed write, or `null`: from a drizzle query
 * error's cause or a Postgres error (`errno`), or from an error that
 * already carries only its `sqlState` (`WebhookEnqueueError`).
 */
export function sqlStateOf(error: unknown): string | null {
  const source: unknown = error instanceof DrizzleQueryError ? error.cause : error;
  if (typeof source !== "object" || source === null) return null;
  const code: unknown = Reflect.get(source, "sqlState") ?? Reflect.get(source, "errno");
  return typeof code === "string" ? code : null;
}

/** A driver error code safe to log: an identifier, never free text. */
const DRIVER_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Describes a failed write for a log line (#184). A drizzle query error's
 * message embeds the query and its parameters (recipients, subjects), so
 * it is reduced to the Postgres SQLSTATE (Bun's `PostgresError` exposes it
 * as `errno`). Without a SQLSTATE, the driver's error code is kept when it
 * is a plain identifier (`ERR_POSTGRES_CONNECTION_CLOSED`): it tells a lost
 * connection from a failed query, and carries no data. Any other error
 * keeps its message: a Postgres error raised outside a drizzle query (a
 * failed COMMIT) carries no parameters, and `WebhookEnqueueError` is
 * already stripped.
 */
export function loggableError(error: unknown): string {
  if (error instanceof DrizzleQueryError) {
    const cause: unknown = error.cause;
    const isObject = typeof cause === "object" && cause !== null;
    const sqlState: unknown = isObject ? Reflect.get(cause, "errno") : undefined;
    if (typeof sqlState === "string")
      return `Database query failed (SQLSTATE ${sqlState})`;
    const code: unknown = isObject ? Reflect.get(cause, "code") : undefined;
    return typeof code === "string" && DRIVER_CODE.test(code)
      ? `Database query failed (${code})`
      : "Database query failed";
  }
  return error instanceof Error ? error.message : String(error);
}
