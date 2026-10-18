import { InvalidCustomHeaderError } from "../errors.ts";
import type { CustomHeaders } from "../models/email.schema.ts";

/**
 * Validation of caller-supplied custom headers (#177).
 *
 * Custom headers are a header-injection surface: a line break in a name or
 * value would let a caller add any header (a `Bcc:`, a second `From:`),
 * and overriding BunMail's own headers would undo the allowed-senders
 * check (#126), DKIM signing and the unsubscribe headers. Every path that
 * accepts them (REST, SMTP submission) and the mailer itself run them
 * through the rules here, so there is one definition of what is allowed.
 *
 * Pure: no I/O, no logging. Callers log, with header names only.
 */

/** At most this many custom headers on one email. */
export const MAX_CUSTOM_HEADERS = 20;

/** Longest accepted header name, in characters. */
export const MAX_CUSTOM_HEADER_NAME_LENGTH = 64;

/** Longest accepted header value, in characters (RFC 5322 line limit). */
export const MAX_CUSTOM_HEADER_VALUE_LENGTH = 998;

/** Cap on all names plus all values together, in UTF-8 bytes. */
export const MAX_CUSTOM_HEADERS_BYTES = 8 * 1024;

/**
 * RFC 5322 field name: printable US-ASCII except the colon (`\x21` to
 * `\x39` and `\x3b` to `\x7e`), so no space, control character or colon.
 */
const HEADER_NAME_PATTERN = /^[\x21-\x39\x3b-\x7e]+$/;

/**
 * Characters a value must not contain: every C0 control except HTAB
 * (so CR, LF and NUL), DEL, the C1 controls, and the Unicode line and
 * paragraph separators. Folding is done by Nodemailer, never by callers.
 */
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const FORBIDDEN_VALUE_CHARS = /[\x00-\x08\x0a-\x1f\x7f-\x9f\u2028\u2029]/;

/**
 * Header names BunMail sets or that receivers trust, compared
 * case-insensitively. A caller setting any of these could spoof the
 * sender, add hidden recipients, forge authentication results or replace
 * the unsubscribe headers. `In-Reply-To` and `References` (threading)
 * are deliberately not here.
 */
const RESERVED_HEADER_NAMES: ReadonlySet<string> = new Set([
  "from",
  "sender",
  "to",
  "cc",
  "bcc",
  "reply-to",
  "subject",
  "date",
  "message-id",
  "return-path",
  "received",
  "dkim-signature",
  "authentication-results",
  "received-spf",
  "mime-version",
  "list-unsubscribe",
  "list-unsubscribe-post",
  "list-id",
  "feedback-id",
  "precedence",
  "auto-submitted",
]);

/** Reserved name prefixes, lowercase: MIME structure, ARC, BunMail's own. */
const RESERVED_HEADER_PREFIXES: readonly string[] = ["content-", "arc-", "x-bunmail-"];

/** Why a custom header was refused. */
export type CustomHeaderProblem =
  | "invalid_name"
  | "invalid_value"
  | "value_too_long"
  | "reserved"
  | "duplicate"
  | "too_many"
  | "too_large";

/** A header {@link filterCustomHeaders} left out, and why. */
export interface DroppedHeader {
  /**
   * The header name, or `null` when the name itself is invalid: an invalid
   * name is never echoed (it may hold a line break or be very long).
   */
  name: string | null;
  problem: CustomHeaderProblem;
}

/** Whether `name` is a reserved header name or has a reserved prefix. */
export function isReservedHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  if (RESERVED_HEADER_NAMES.has(lower)) return true;
  return RESERVED_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** Whether `name` is a syntactically valid field name of accepted length. */
function isValidHeaderName(name: string): boolean {
  return name.length <= MAX_CUSTOM_HEADER_NAME_LENGTH && HEADER_NAME_PATTERN.test(name);
}

/** The problem with a single header, ignoring count, size and duplicates. */
function checkHeader(name: string, value: string): CustomHeaderProblem | null {
  if (!isValidHeaderName(name)) return "invalid_name";
  if (isReservedHeaderName(name)) return "reserved";
  if (FORBIDDEN_VALUE_CHARS.test(value)) return "invalid_value";
  if (value.length > MAX_CUSTOM_HEADER_VALUE_LENGTH) return "value_too_long";
  return null;
}

/**
 * Applies every rule to `entries` in order and keeps the headers that pass:
 * valid name, not reserved, a value without line breaks or control
 * characters and at most 998 characters, not a case-insensitive duplicate
 * of an earlier kept header, within the count cap and the total size cap.
 * The rest are reported in `dropped`. First come, first kept.
 *
 * SMTP submission uses this directly (it drops what fails); the REST path
 * uses {@link validateCustomHeaders}, which refuses the whole send instead.
 */
export function filterCustomHeaders(entries: Iterable<readonly [string, string]>): {
  headers: CustomHeaders;
  dropped: DroppedHeader[];
} {
  /** Built as entries, then `Object.fromEntries`: a `__proto__` key stays a plain key. */
  const kept: [string, string][] = [];
  const dropped: DroppedHeader[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  for (const [name, value] of entries) {
    const problem = checkHeader(name, value);
    if (problem) {
      dropped.push({ name: problem === "invalid_name" ? null : name, problem });
      continue;
    }
    const lower = name.toLowerCase();
    if (seen.has(lower)) {
      dropped.push({ name, problem: "duplicate" });
      continue;
    }
    if (kept.length >= MAX_CUSTOM_HEADERS) {
      dropped.push({ name, problem: "too_many" });
      continue;
    }
    const bytes = Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8");
    if (totalBytes + bytes > MAX_CUSTOM_HEADERS_BYTES) {
      dropped.push({ name, problem: "too_large" });
      continue;
    }
    seen.add(lower);
    totalBytes += bytes;
    kept.push([name, value]);
  }

  return { headers: Object.fromEntries(kept), dropped };
}

/** Caller-facing message for a refused header. Names the header only, never its value. */
function describeProblem(dropped: DroppedHeader): string {
  const name = dropped.name ?? "";
  switch (dropped.problem) {
    case "invalid_name":
      return `A custom header name is invalid: use 1 to ${MAX_CUSTOM_HEADER_NAME_LENGTH} printable ASCII characters, without spaces or colons.`;
    case "invalid_value":
      return `Custom header "${name}" has an invalid value: line breaks and control characters are not allowed.`;
    case "value_too_long":
      return `Custom header "${name}" has a value longer than ${MAX_CUSTOM_HEADER_VALUE_LENGTH} characters.`;
    case "reserved":
      return `Custom header "${name}" is reserved and cannot be set.`;
    case "duplicate":
      return `Custom header "${name}" is set more than once (names are case-insensitive).`;
    case "too_many":
      return `At most ${MAX_CUSTOM_HEADERS} custom headers are allowed.`;
    case "too_large":
      return `Custom headers exceed ${MAX_CUSTOM_HEADERS_BYTES} bytes in total (names plus values).`;
  }
}

/**
 * Strict variant for the send API: returns the headers when every one
 * passes {@link filterCustomHeaders}, and otherwise throws an
 * {@link InvalidCustomHeaderError} (`422`, SMTP `550`) for the first one
 * that does not. Nothing is sent with a partial set.
 */
export function validateCustomHeaders(headers: CustomHeaders): CustomHeaders {
  const { headers: kept, dropped } = filterCustomHeaders(Object.entries(headers));
  const first = dropped[0];
  if (first) {
    throw new InvalidCustomHeaderError(first.problem, first.name, describeProblem(first));
  }
  return kept;
}
