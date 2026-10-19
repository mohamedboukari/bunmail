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

/**
 * Describes a failed write for a log line (#184). A drizzle query error's
 * message embeds the query and its parameters (recipients, subjects), so
 * it is reduced to the Postgres SQLSTATE (Bun's `PostgresError` exposes it
 * as `errno`). Any other error keeps its message: a Postgres error raised
 * outside a drizzle query (a failed COMMIT) carries no parameters, and
 * `WebhookEnqueueError` is already stripped.
 */
export function loggableError(error: unknown): string {
  if (error instanceof DrizzleQueryError) {
    const cause: unknown = error.cause;
    const sqlState =
      typeof cause === "object" && cause !== null
        ? Reflect.get(cause, "errno")
        : undefined;
    return typeof sqlState === "string"
      ? `Database query failed (SQLSTATE ${sqlState})`
      : "Database query failed";
  }
  return error instanceof Error ? error.message : String(error);
}
