import { DrizzleQueryError } from "drizzle-orm";

/**
 * A database failure in the owner store (#215), stripped of everything the
 * query carried.
 *
 * Drizzle wraps every driver error in `DrizzleQueryError`, whose message is
 * `Failed query: <sql>\nparams: <params>`. On the owner paths those params
 * include the new argon2id password hash, setup token hashes and the owner
 * email, and the message reaches the logs (the global error handler, the
 * boot step and `reset-owner.ts` all log `error.message`). This error keeps
 * only the Postgres SQLSTATE, which is enough to diagnose the failure. The
 * driver's own message is dropped too: some Postgres messages quote the
 * offending input value.
 */
export class OwnerStoreError extends Error {
  /** Postgres SQLSTATE (e.g. `23505`), or `null` when the driver gave none. */
  readonly sqlState: string | null;

  constructor(sqlState: string | null) {
    super(`Owner store query failed${sqlState ? ` (SQLSTATE ${sqlState})` : ""}`);
    this.name = "OwnerStoreError";
    this.sqlState = sqlState;
  }
}

/**
 * Replaces a `DrizzleQueryError` with an `OwnerStoreError` that carries
 * only the SQLSTATE (Bun's `PostgresError` exposes it as `errno`). Any
 * other error is returned unchanged, so deliberate service errors keep
 * their messages.
 */
export function sanitizeOwnerStoreError(error: unknown): unknown {
  if (!(error instanceof DrizzleQueryError)) return error;
  const cause: unknown = error.cause;
  const sqlState =
    typeof cause === "object" && cause !== null ? Reflect.get(cause, "errno") : undefined;
  return new OwnerStoreError(typeof sqlState === "string" ? sqlState : null);
}
