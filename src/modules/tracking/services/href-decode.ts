/**
 * Reads an `href` attribute value as a URL the way a browser would (#187),
 * or refuses when that is not certain. A link is only tracked when the
 * URL BunMail signs is exactly the one the recipient's client would have
 * opened, so any ambiguity leaves the link untracked:
 *
 * - `&name;` is decoded only for `amp`, `lt`, `gt`, `quot` and `apos`;
 *   any other named reference (the browser knows about 2,000) is
 *   ambiguous.
 * - An `&` that a browser keeps as written is kept: one not followed by a
 *   letter or `#`, or followed by letters that no legacy (no-semicolon)
 *   entity name starts, or by a legacy name that is followed by a letter,
 *   a digit or `=` (the attribute-value rule). A legacy name followed by
 *   anything else would be decoded by the browser: ambiguous.
 * - `&#...;` and `&#x...;` are decoded only with their `;` and only to a
 *   code point browsers keep as is: never NUL, a C0 control, DEL, a
 *   surrogate, a value past U+10FFFF, or U+0080 to U+009F (remapped to
 *   windows-1252). Anything else is ambiguous.
 * - Then, as the URL parser does: ASCII tab and newlines are removed
 *   everywhere, and C0 controls and spaces at either end are stripped.
 *   Other characters (NBSP, U+FEFF) are kept.
 *
 * Linear: every `&` costs a bounded number of steps. Pure.
 */

/** Named references decoded (with their `;`). */
const STRICT_NAMED: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * The legacy named references a browser decodes without a `;` (HTML
 * standard, case-sensitive). Only used to tell a literal `&` from one a
 * browser would decode.
 */
const LEGACY_NAMES: readonly string[] = [
  "AElig",
  "AMP",
  "Aacute",
  "Acirc",
  "Agrave",
  "Aring",
  "Atilde",
  "Auml",
  "COPY",
  "Ccedil",
  "ETH",
  "Eacute",
  "Ecirc",
  "Egrave",
  "Euml",
  "GT",
  "Iacute",
  "Icirc",
  "Igrave",
  "Iuml",
  "LT",
  "Ntilde",
  "Oacute",
  "Ocirc",
  "Ograve",
  "Oslash",
  "Otilde",
  "Ouml",
  "QUOT",
  "REG",
  "THORN",
  "Uacute",
  "Ucirc",
  "Ugrave",
  "Uuml",
  "Yacute",
  "aacute",
  "acirc",
  "acute",
  "aelig",
  "agrave",
  "amp",
  "aring",
  "atilde",
  "auml",
  "brvbar",
  "ccedil",
  "cedil",
  "cent",
  "copy",
  "curren",
  "deg",
  "divide",
  "eacute",
  "ecirc",
  "egrave",
  "eth",
  "euml",
  "frac12",
  "frac14",
  "frac34",
  "gt",
  "iacute",
  "icirc",
  "iexcl",
  "igrave",
  "iquest",
  "iuml",
  "laquo",
  "lt",
  "macr",
  "micro",
  "middot",
  "nbsp",
  "not",
  "ntilde",
  "oacute",
  "ocirc",
  "ograve",
  "ordf",
  "ordm",
  "oslash",
  "otilde",
  "ouml",
  "para",
  "plusmn",
  "pound",
  "quot",
  "raquo",
  "reg",
  "sect",
  "shy",
  "sup1",
  "sup2",
  "sup3",
  "szlig",
  "thorn",
  "times",
  "uacute",
  "ucirc",
  "ugrave",
  "uml",
  "uuml",
  "yacute",
  "yen",
  "yuml",
];

/** Longest run of name characters read after `&` (entity names are shorter). */
const MAX_NAME_RUN = 40;

function isAlnum(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

function isLetter(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

/** Whether a decoded code point is one a browser keeps as written. */
function plainCodePoint(cp: number): boolean {
  if (cp < 0x20 || cp === 0x7f) return false;
  if (cp >= 0x80 && cp <= 0x9f) return false;
  if (cp >= 0xd800 && cp <= 0xdfff) return false;
  return cp <= 0x10ffff;
}

/** The longest legacy name `run` starts with, or `null`. */
function legacyPrefix(run: string): string | null {
  let best: string | null = null;
  for (const name of LEGACY_NAMES) {
    if (run.startsWith(name) && (best === null || name.length > best.length)) best = name;
  }
  return best;
}

/**
 * The entity at `value[amp] === "&"`: its text and the index after it, or
 * `null` when it is ambiguous (see the file comment).
 */
function readReference(
  value: string,
  amp: number,
): { text: string; next: number } | null {
  const first = value.charCodeAt(amp + 1);
  if (first === 0x23 /* # */) {
    const numeric = /^#(?:[xX]([0-9a-fA-F]{1,6})|([0-9]{1,7}));/.exec(
      value.slice(amp + 1, amp + 12),
    );
    if (!numeric) return null;
    const cp =
      numeric[1] !== undefined
        ? Number.parseInt(numeric[1], 16)
        : Number.parseInt(numeric[2] ?? "", 10);
    if (!plainCodePoint(cp)) return null;
    return { text: String.fromCodePoint(cp), next: amp + 1 + numeric[0].length };
  }
  if (!isLetter(first)) return { text: "&", next: amp + 1 };

  let j = amp + 1;
  while (j < value.length && j - amp <= MAX_NAME_RUN && isAlnum(value.charCodeAt(j)))
    j += 1;
  const run = value.slice(amp + 1, j);
  if (value.charCodeAt(j) === 0x3b /* ; */) {
    const decoded = Object.hasOwn(STRICT_NAMED, run) ? STRICT_NAMED[run] : undefined;
    return decoded === undefined ? null : { text: decoded, next: j + 1 };
  }
  const legacy = legacyPrefix(run);
  if (legacy === null) return { text: "&", next: amp + 1 };
  const after = value.charCodeAt(amp + 1 + legacy.length);
  /** In an attribute, a legacy name followed by an alphanumeric or `=` stays as written. */
  if (isAlnum(after) || after === 0x3d /* = */) return { text: "&", next: amp + 1 };
  return null;
}

/** Strips C0 controls and spaces at either end, as the URL parser does. */
function stripC0AndSpace(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end -= 1;
  return value.slice(start, end);
}

/**
 * The URL a browser opens for a raw `href` value (see the file comment),
 * or `null` when the entity decoding is ambiguous.
 */
export function decodeHref(raw: string): string | null {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const amp = raw.indexOf("&", i);
    if (amp < 0) {
      out += raw.slice(i);
      break;
    }
    out += raw.slice(i, amp);
    const reference = readReference(raw, amp);
    if (reference === null) return null;
    out += reference.text;
    i = reference.next;
  }
  return stripC0AndSpace(out.replace(/[\t\n\r]/g, ""));
}
