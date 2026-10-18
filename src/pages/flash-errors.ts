import { DrizzleQueryError } from "drizzle-orm";

/**
 * Text for an error flash message. Flash text travels in the redirect
 * URL, so it lands in browser history and proxy logs: a message the app
 * wrote for the user (a typed rejection, a validation message) is shown,
 * but a database error (its message carries the query and its bound
 * values) or a programming error (`TypeError` and friends, which can
 * quote internals) becomes `fallback`. The full error is logged by the
 * caller, through the logger's redaction.
 */
export function flashMessageFor(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  if (
    error instanceof DrizzleQueryError ||
    error instanceof TypeError ||
    error instanceof RangeError ||
    error instanceof ReferenceError ||
    error instanceof SyntaxError ||
    "errno" in error
  ) {
    return fallback;
  }
  return error.message;
}
