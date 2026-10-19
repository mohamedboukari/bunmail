import type { EmailTags } from "../models/email.schema.ts";
import { codePointLength } from "./from-name.ts";

/**
 * Rules for email tags (#189): labels a caller puts on a send, key to
 * value, to filter the email log (`GET /api/v1/emails?tag=key:value`)
 * and route webhook events.
 *
 * - at most {@link MAX_TAGS} tags;
 * - a key is 1 to {@link MAX_TAG_KEY_LENGTH} characters of `A-Z a-z 0-9
 *   _ -`, and no two keys are the same ignoring case;
 * - a value is 1 to {@link MAX_TAG_VALUE_LENGTH} characters (code points)
 *   after trimming, with no control character (C0, DEL, C1, which covers
 *   CR, LF, NUL and tab), no Unicode line or paragraph separator, no bidi
 *   control (U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069)
 *   and no lone surrogate. Every other character is allowed, so values in
 *   any script work.
 *
 * The same rules check a stored tag (REST body, SMTP `X-BunMail-Tag`
 * header) and a filter. Tags can hold customer identifiers, so callers
 * log keys only, never values, and the messages here never include a
 * value (nor a key that breaks the key rule).
 *
 * Pure: no I/O, no logging.
 */

/** Most tags one email can carry, and most `tag` filters one list accepts. */
export const MAX_TAGS = 10;

/** Longest tag key, in characters. */
export const MAX_TAG_KEY_LENGTH = 40;

/** Longest tag value, in characters (code points), after trimming. */
export const MAX_TAG_VALUE_LENGTH = 256;

/**
 * A raw value longer than this (in UTF-16 code units) is refused before
 * it is trimmed or scanned: it cannot be a valid value.
 */
const MAX_RAW_TAG_VALUE_LENGTH = 1024;

/** A valid tag key. */
const TAG_KEY_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

/** Characters a tag value must not contain (see the file comment). */
const FORBIDDEN_TAG_VALUE_CHARS =
  /[\p{Cc}\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

/** Why a tag (or a tag filter) was refused. */
export type TagProblem =
  | "too_many"
  | "invalid_key"
  | "duplicate_key"
  | "empty_value"
  | "value_too_long"
  | "forbidden_character"
  | "malformed";

/** A refusal: the rule, and the key when the key itself is valid. */
export interface TagRefusal {
  ok: false;
  problem: TagProblem;
  /** The tag's key, `null` when the key breaks the key rule (or for `too_many`). */
  key: string | null;
}

/** The outcome of {@link checkTags}: the tags to store, or why they were refused. */
export type TagsCheck = { ok: true; tags: EmailTags } | TagRefusal;

/** One `tag=key:value` filter, checked. */
export interface TagFilter {
  key: string;
  value: string;
}

/** The outcome of {@link parseTagFilters}. */
export type TagFiltersCheck = { ok: true; filters: TagFilter[] } | TagRefusal;

/** Whether `key` is a valid tag key. */
export function isValidTagKey(key: string): boolean {
  return TAG_KEY_PATTERN.test(key);
}

/** Checks one value and returns it trimmed, or the rule it breaks. */
function checkTagValue(
  raw: string,
): { ok: true; value: string } | { ok: false; problem: TagProblem } {
  if (raw.length > MAX_RAW_TAG_VALUE_LENGTH) {
    return { ok: false, problem: "value_too_long" };
  }
  const value = raw.trim();
  if (value === "") return { ok: false, problem: "empty_value" };
  if (FORBIDDEN_TAG_VALUE_CHARS.test(value) || !value.isWellFormed()) {
    return { ok: false, problem: "forbidden_character" };
  }
  /** Code points, not UTF-16 units: an emoji counts once. */
  if (codePointLength(value) > MAX_TAG_VALUE_LENGTH) {
    return { ok: false, problem: "value_too_long" };
  }
  return { ok: true, value };
}

/**
 * Checks a send's tags, given as entries so a submitted message's
 * repeated header is seen as the duplicate it is. Returns them with
 * trimmed values, as a plain object built with `Object.fromEntries`
 * (a `__proto__` key stays an ordinary key).
 */
export function checkTags(entries: readonly (readonly [string, string])[]): TagsCheck {
  if (entries.length > MAX_TAGS) return { ok: false, problem: "too_many", key: null };
  const seen = new Set<string>();
  const kept: [string, string][] = [];
  for (const [key, raw] of entries) {
    if (!isValidTagKey(key)) return { ok: false, problem: "invalid_key", key: null };
    const lower = key.toLowerCase();
    if (seen.has(lower)) return { ok: false, problem: "duplicate_key", key };
    seen.add(lower);
    const checked = checkTagValue(raw);
    if (!checked.ok) return { ok: false, problem: checked.problem, key };
    kept.push([key, checked.value]);
  }
  return { ok: true, tags: Object.fromEntries(kept) };
}

/**
 * Parses `tag` filters (`key:value`, split on the first `:` only, so a
 * value may contain `:`), each through the tag rules. At most
 * {@link MAX_TAGS}: an email cannot carry more, so more cannot match.
 */
export function parseTagFilters(raws: readonly string[]): TagFiltersCheck {
  if (raws.length > MAX_TAGS) return { ok: false, problem: "too_many", key: null };
  const filters: TagFilter[] = [];
  for (const raw of raws) {
    const colon = raw.indexOf(":");
    if (colon < 0) return { ok: false, problem: "malformed", key: null };
    const key = raw.slice(0, colon);
    if (!isValidTagKey(key)) return { ok: false, problem: "invalid_key", key: null };
    const checked = checkTagValue(raw.slice(colon + 1));
    if (!checked.ok) return { ok: false, problem: checked.problem, key };
    filters.push({ key, value: checked.value });
  }
  return { ok: true, filters };
}

/**
 * Caller-facing message for a refused tag. `subject` names where it came
 * from (`tags`, `tag filter`, `X-BunMail-Tag`). Names the key only when
 * it is valid, never the value.
 */
export function describeTagProblem(refusal: TagRefusal, subject: string): string {
  const which = refusal.key === null ? subject : `${subject} "${refusal.key}"`;
  switch (refusal.problem) {
    case "too_many":
      return `${subject}: at most ${MAX_TAGS} tags.`;
    case "malformed":
      return `${subject} must be key:value.`;
    case "invalid_key":
      return `${subject}: keys must be 1 to ${MAX_TAG_KEY_LENGTH} characters of A-Z, a-z, 0-9, _ or -.`;
    case "duplicate_key":
      return `${which} is given more than once (keys are compared ignoring case).`;
    case "empty_value":
      return `${which} must have a value of 1 to ${MAX_TAG_VALUE_LENGTH} characters.`;
    case "value_too_long":
      return `${which} value must be at most ${MAX_TAG_VALUE_LENGTH} characters.`;
    case "forbidden_character":
      return `${which} value must not contain control or bidi-control characters.`;
  }
}
