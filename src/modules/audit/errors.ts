import { DrizzleQueryError } from "drizzle-orm";

/**
 * A failed audit log query (#221), stripped of what the query carried.
 * Drizzle's message embeds the query parameters, which here are account
 * emails, key names and user agents: only the Postgres SQLSTATE is kept,
 * which is enough to diagnose the failure. Thrown inside a caller's
 * transaction (the change and its record then roll back together), and
 * logged, never thrown, on the best-effort path.
 */
export class AuditStoreError extends Error {
  override readonly name = "AuditStoreError";

  /** Postgres SQLSTATE (e.g. `P0001` from the append-only trigger), or `null`. */
  readonly sqlState: string | null;

  constructor(sqlState: string | null) {
    super(`Audit log query failed${sqlState ? ` (SQLSTATE ${sqlState})` : ""}`);
    this.sqlState = sqlState;
  }
}

/**
 * Turns any error of an audit query into an `AuditStoreError` (Bun's
 * `PostgresError` exposes the SQLSTATE as `errno`); an error that is
 * already one is returned as is.
 */
export function toAuditStoreError(error: unknown): AuditStoreError {
  if (error instanceof AuditStoreError) return error;
  const cause: unknown = error instanceof DrizzleQueryError ? error.cause : error;
  const sqlState =
    typeof cause === "object" && cause !== null ? Reflect.get(cause, "errno") : undefined;
  return new AuditStoreError(typeof sqlState === "string" ? sqlState : null);
}
