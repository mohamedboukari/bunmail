/**
 * Message of an error for a log line. Users-module errors are already
 * `UserStoreError` (SQLSTATE only), so this never carries a token hash or
 * an email.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
