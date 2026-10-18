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
 * Domain is preserved deliberately: operators frequently need to
 * distinguish "Gmail rejected us" from "our own domain rejected us"
 * during incident response, and the domain alone isn't PII.
 *
 * When `config.logRedactPii` is false (the default in development),
 * the input is returned unchanged so dev logs stay debuggable.
 */
export function redactEmail(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (!config.logRedactPii) return value;
  return maskEmail(value);
}

/**
 * Masks an email address whatever `LOG_REDACT_PII` says: the same
 * `a***@example.com` form as `redactEmail`, for display to someone who
 * should not see the full address (#219: account emails shown to members
 * on "Created by" labels). Input without `@` is returned unchanged.
 */
export function maskEmail(value: string): string {
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

/** An email address inside free text, such as a remote SMTP reply. */
const EMAIL_IN_TEXT = /[^\s<>()[\]"',;:@]+@[A-Za-z0-9.-]+/g;

/**
 * Masks every email address inside free text when `LOG_REDACT_PII` is on
 * (#260). Remote SMTP replies quote the recipient, for example
 * `550 5.1.1 <user@example.org>: Recipient address rejected`; the reply
 * code and wording stay readable.
 */
export function redactEmailsInText(value: string): string {
  if (!config.logRedactPii) return value;
  return value.replace(EMAIL_IN_TEXT, (address) => maskEmail(address));
}

/**
 * Reduces a URL to its origin (scheme, host and port) for logging (#260).
 * Webhook services such as Slack and Discord put the credential in the
 * path, and others in the query or user info, so only the origin is safe
 * to log. Applies whatever `LOG_REDACT_PII` says: the URL carries a
 * secret, not personal data. Unparsable input logs as `[invalid url]`.
 */
export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "[invalid url]";
  }
}
