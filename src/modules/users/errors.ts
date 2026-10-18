import { DrizzleQueryError } from "drizzle-orm";

/**
 * A database failure in the users store (owner setup #215, login and
 * sessions #216), stripped of everything the query carried.
 *
 * Drizzle wraps every driver error in `DrizzleQueryError`, whose message is
 * `Failed query: <sql>\nparams: <params>`. On the users paths those params
 * include argon2id password hashes, setup and session token hashes and
 * account emails, and the message reaches the logs (the global error
 * handler, the boot step, the dashboard guard and `reset-owner.ts` all log
 * `error.message`). This error keeps only the Postgres SQLSTATE, which is
 * enough to diagnose the failure. The driver's own message is dropped too:
 * some Postgres messages quote the offending input value.
 */
export class UserStoreError extends Error {
  /** Postgres SQLSTATE (e.g. `23505`), or `null` when the driver gave none. */
  readonly sqlState: string | null;

  constructor(sqlState: string | null) {
    super(`User store query failed${sqlState ? ` (SQLSTATE ${sqlState})` : ""}`);
    this.name = "UserStoreError";
    this.sqlState = sqlState;
  }
}

/**
 * Replaces a `DrizzleQueryError` with a `UserStoreError` that carries
 * only the SQLSTATE (Bun's `PostgresError` exposes it as `errno`). Any
 * other error is returned unchanged, so deliberate service errors keep
 * their messages.
 */
export function sanitizeUserStoreError(error: unknown): unknown {
  if (!(error instanceof DrizzleQueryError)) return error;
  const cause: unknown = error.cause;
  const sqlState =
    typeof cause === "object" && cause !== null ? Reflect.get(cause, "errno") : undefined;
  return new UserStoreError(typeof sqlState === "string" ? sqlState : null);
}

/**
 * Runs a query and rethrows a database error as `UserStoreError`, with
 * the query parameters stripped (see `sanitizeUserStoreError`). Every
 * query of the users module goes through this, so no caller can leak a
 * hash or an email into a log line by logging `error.message`.
 */
export async function withSanitizedErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error: unknown) {
    throw sanitizeUserStoreError(error);
  }
}
