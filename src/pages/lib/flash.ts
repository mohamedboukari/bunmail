import { t } from "elysia";
import {
  FLASH_MESSAGES,
  NUMERIC_FLASH_MESSAGES,
  type FlashCode,
  type FlashType,
  type NumericFlashCode,
} from "./flash-codes.ts";

/**
 * Flash banners by code (#421). A redirect names a banner with
 * `flashUrl(path, flash)`, the page turns the query back into the banner
 * with `toFlash`. The URL never carries text: see `flash-codes.ts` for the
 * codes and why.
 */

/**
 * A banner to show after a redirect: a fixed-text code, or a numeric code
 * with its number. An unknown code is a type error at the call site.
 */
export type Flash = FlashCode | { readonly code: NumericFlashCode; readonly n: number };

/** The banner as the pages render it (`FlashMessage`). */
export interface FlashBanner {
  /** What the banner says. */
  message: string;
  /** Its colour. */
  type: FlashType;
}

/**
 * The query fields a page with a banner accepts, spread into its query
 * schema. Plain strings with no length limit, so an old free-text
 * bookmark is not a 422: it simply matches no code and shows nothing.
 */
export const FLASH_QUERY = {
  flash: t.Optional(t.String()),
  flashN: t.Optional(t.String()),
};

/**
 * The largest `flashN`, shared by `flashUrl` (which clamps to it) and
 * `toFlash` (which accepts no more), so every number one writes the other
 * reads.
 */
const FLASH_N_MAX = 999_999_999;

/** Digits only, no more than {@link FLASH_N_MAX} has: no sign, no decimals, no text. */
const FLASH_N_PATTERN = new RegExp(`^\\d{1,${String(FLASH_N_MAX).length}}$`);

/** True when `value` names a fixed-text banner (own keys only, never `__proto__`). */
function isFlashCode(value: string): value is FlashCode {
  return Object.hasOwn(FLASH_MESSAGES, value);
}

/** True when `value` names a numeric banner (own keys only). */
function isNumericFlashCode(value: string): value is NumericFlashCode {
  return Object.hasOwn(NUMERIC_FLASH_MESSAGES, value);
}

/**
 * A number as it goes in the URL: a non-negative integer up to
 * {@link FLASH_N_MAX} (a larger one is clamped to it), anything else 0.
 */
function urlNumber(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) return 0;
  return Math.min(n, FLASH_N_MAX);
}

/**
 * `path` with the banner's query appended (`?flash=<code>`, plus
 * `&flashN=<n>` for a numeric banner). Codes are fixed lower snake case
 * strings, so nothing needs encoding. `path` may already have a query.
 */
export function flashUrl(path: string, flash: Flash): string {
  const separator = path.includes("?") ? "&" : "?";
  if (typeof flash === "string") return `${path}${separator}flash=${flash}`;
  return `${path}${separator}flash=${flash.code}&flashN=${urlNumber(flash.n)}`;
}

/** The message of a fixed-text banner, for a page that shows it without a redirect. */
export function flashMessage(code: FlashCode): string {
  return FLASH_MESSAGES[code].text;
}

/**
 * The banner for a page's `flash` and `flashN` query fields, or
 * `undefined`. Both are attacker-controllable: only a known code renders,
 * with the message and colour written for it; a numeric code also needs
 * a `flashN` of digits only. Anything else (an unknown code, free text
 * from an old bookmark, a number with text in it) renders nothing.
 */
export function toFlash(
  rawCode: string | undefined,
  rawN: string | undefined,
): FlashBanner | undefined {
  if (rawCode === undefined) return undefined;
  if (isFlashCode(rawCode)) {
    const entry = FLASH_MESSAGES[rawCode];
    return { message: entry.text, type: entry.type };
  }
  if (isNumericFlashCode(rawCode)) {
    if (rawN === undefined || !FLASH_N_PATTERN.test(rawN)) return undefined;
    const n = Number(rawN);
    if (n > FLASH_N_MAX) return undefined;
    const entry = NUMERIC_FLASH_MESSAGES[rawCode];
    return { message: entry.text(n), type: entry.type };
  }
  return undefined;
}
