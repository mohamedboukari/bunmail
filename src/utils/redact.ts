import { config } from "../config.ts";

/**
 * Redacts an email address for logging.
 *
 * Examples (with `LOG_REDACT_PII=true`):
 *   alice@example.com  → "a***@example.com"
 *   x@example.com      → "*@example.com"
 *   "" / null          → empty string
 *   not-an-email       → returned unchanged (no `@` to anchor on)
 *
 * Domain is preserved deliberately — operators frequently need to
 * distinguish "Gmail rejected us" from "our own domain rejected us"
 * during incident response, and the domain alone isn't PII.
 *
 * When `config.logRedactPii` is false (the default in development),
 * the input is returned unchanged so dev logs stay debuggable.
 */
export function redactEmail(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (!config.logRedactPii) return value;

  const at = value.indexOf("@");
  if (at < 0) return value;

  const local = value.slice(0, at);
  const domain = value.slice(at);

  /** One-char locals collapse to "*" so we don't reveal the whole address. */
  if (local.length <= 1) return `*${domain}`;
  return `${local[0]}***${domain}`;
}

/**
 * Redacts a comma-separated list of email addresses (cc/bcc fields).
 * Whitespace around commas is preserved on output.
 */
export function redactEmailList(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (!config.logRedactPii) return value;
  return value
    .split(",")
    .map((part) => redactEmail(part.trim()))
    .join(", ");
}
