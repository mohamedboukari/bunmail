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

/**
 * SQLSTATE classes of a database error that can pass on its own (#474):
 * `08` connection exception, `40` transaction rollback (serialization
 * failure, deadlock), `53` insufficient resources (too many connections,
 * out of memory or disk), `57` operator intervention (query canceled by a
 * statement timeout, server shutting down or starting up).
 */
const TRANSIENT_SQLSTATE_CLASSES: ReadonlySet<string> = new Set(["08", "40", "53", "57"]);

/** Single SQLSTATEs outside those classes that pass on their own: `55P03` lock not available. */
const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set(["55P03"]);

/**
 * Error codes of a connection or pool failure (#474): Bun SQL's own codes
 * for a lost, refused or timed-out connection and a cancelled query (no
 * SQLSTATE: the server never answered), and the socket errors under them.
 */
const TRANSIENT_ERROR_CODES: ReadonlySet<string> = new Set([
  "ERR_POSTGRES_CONNECTION_CLOSED",
  "ERR_POSTGRES_CONNECTION_FAILED",
  "ERR_POSTGRES_CONNECTION_REFUSED",
  "ERR_POSTGRES_CONNECTION_TIMEOUT",
  "ERR_POSTGRES_IDLE_TIMEOUT",
  "ERR_POSTGRES_LIFETIME_TIMEOUT",
  "ERR_POSTGRES_QUERY_CANCELLED",
  "ERR_POSTGRES_TLS_UPGRADE_FAILED",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EAI_AGAIN",
]);

/**
 * Whether an error is a database or connection failure that can pass on
 * its own (#474), so the work that hit it is worth trying again later: a
 * SQLSTATE in a transient class (see {@link TRANSIENT_SQLSTATE_CLASSES}),
 * or a connection, pool or socket error code. Reads a drizzle query
 * error's cause, or the error itself. Anything else, including a database
 * error with another SQLSTATE (a constraint, a syntax error), is not.
 */
export function isTransientDbError(error: unknown): boolean {
  const sqlState = sqlStateOf(error);
  if (sqlState !== null) {
    return (
      TRANSIENT_SQLSTATE_CLASSES.has(sqlState.slice(0, 2)) ||
      TRANSIENT_SQLSTATES.has(sqlState)
    );
  }
  const source: unknown = error instanceof DrizzleQueryError ? error.cause : error;
  if (typeof source !== "object" || source === null) return false;
  const code: unknown = Reflect.get(source, "code");
  return typeof code === "string" && TRANSIENT_ERROR_CODES.has(code);
}
