/**
 * Rules for the sender display name (#250), the `name` in
 * `From: "name" <address>`.
 *
 * A display name is what most mail clients show instead of the address,
 * so it is a spoofing surface: a name like `support@paypal.com` reads as
 * an address, and bidi controls can reorder what is shown. The rules
 * keep it a plain label:
 *
 * - 1 to {@link MAX_FROM_NAME_LENGTH} characters (code points) after
 *   trimming;
 * - no control character (C0, DEL, C1, which covers CR, LF, NUL and
 *   tab), no Unicode line or paragraph separator;
 * - no bidi embedding, override or isolate control (U+202A to U+202E,
 *   U+2066 to U+2069);
 * - none of `@`, `<`, `>` and `"`, so it can neither look like an address
 *   nor break out of the quoted name.
 *
 * Every other character is allowed, so names in any script work.
 * Nodemailer does the RFC 2047 encoding of non-ASCII names.
 *
 * Pure: no I/O, no logging. The send API refuses a name that breaks a
 * rule; SMTP submission drops it and logs the field name.
 */

/** Longest accepted display name, in characters (code points), after trimming. */
export const MAX_FROM_NAME_LENGTH = 100;

/**
 * A raw value longer than this (in UTF-16 code units) is refused before
 * it is trimmed or counted: it cannot be a valid name, however much of
 * it is whitespace padding.
 */
const MAX_RAW_FROM_NAME_LENGTH = 1000;

/** Characters a display name must not contain (see the file comment). */
const FORBIDDEN_FROM_NAME_CHARS =
  // oxlint-disable-next-line no-control-regex -- matching control characters is the point
  /[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069@<>"]/;

/** Why a display name was refused. */
export type FromNameProblem = "empty" | "too_long" | "forbidden_character";

/** The outcome of {@link checkFromName}: the trimmed name, or why it was refused. */
export type FromNameCheck =
  { ok: true; name: string } | { ok: false; problem: FromNameProblem };

/**
 * Length in code points: a surrogate pair counts once, a lone surrogate
 * (stored as U+FFFD) counts once too.
 */
function codePointLength(value: string): number {
  let count = 0;
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    const next = value.charCodeAt(i + 1);
    if (unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) i += 1;
    count += 1;
  }
  return count;
}

/** Checks a display name against the rules and returns it trimmed. */
export function checkFromName(raw: string): FromNameCheck {
  if (raw.length > MAX_RAW_FROM_NAME_LENGTH) return { ok: false, problem: "too_long" };
  const name = raw.trim();
  if (name === "") return { ok: false, problem: "empty" };
  if (FORBIDDEN_FROM_NAME_CHARS.test(name)) {
    return { ok: false, problem: "forbidden_character" };
  }
  /** Code points, not UTF-16 units: an emoji counts once, as the column does. */
  if (codePointLength(name) > MAX_FROM_NAME_LENGTH) {
    return { ok: false, problem: "too_long" };
  }
  return { ok: true, name };
}

/** Caller-facing message for a refused display name. Names the field, never the value. */
export function describeFromNameProblem(problem: FromNameProblem): string {
  switch (problem) {
    case "empty":
      return "fromName must not be empty or only whitespace.";
    case "too_long":
      return `fromName must be at most ${MAX_FROM_NAME_LENGTH} characters.`;
    case "forbidden_character":
      return 'fromName must not contain control or bidi-control characters, nor any of @ < > ".';
  }
}
