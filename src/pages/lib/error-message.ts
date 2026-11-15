import { loggableError } from "../../utils/db-error.ts";

/**
 * Message of an error for a log line. Users-module errors are already
 * `UserStoreError` (SQLSTATE only), but not every service these pages call
 * sanitizes its database errors (the audit log, for one), so a drizzle
 * query error is reduced to its SQLSTATE here too (#448): its message
 * embeds the query parameters (emails, token hashes).
 */
export function errorMessage(error: unknown): string {
  return loggableError(error);
}
