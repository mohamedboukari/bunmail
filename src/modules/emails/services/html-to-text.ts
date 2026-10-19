/**
 * A bounded HTML-to-text converter for the `text/plain` alternative of
 * HTML-only sends (#250). In-repo on purpose: no dependency, and every
 * bound is local.
 *
 * - One left-to-right pass over at most {@link MAX_HTML_INPUT_LENGTH}
 *   characters of the HTML. Every inner search (`indexOf`, a tag's
 *   attributes) starts where the last one stopped and the cursor only
 *   moves forward, so the work is linear in the input whatever its
 *   nesting. No regular expression is built from the input.
 * - `<script>`, `<style>`, `<head>`, `<title>`, `<template>` and their
 *   content are dropped, as are comments, `<!...>` declarations and
 *   `<?...?>` instructions. An element that is never closed drops the rest
 *   of the input.
 * - `<br>`, `</p>`, `</div>`, `</tr>`, `</h1>` to `</h6>` (and the matching
 *   openings, lists, tables, `<hr>`) end a line; paragraphs and headings
 *   leave a blank line. `<li>` starts a line with `- `.
 * - `<a href="x">text</a>` becomes `text (x)` when `x` is an `http:`,
 *   `https:` or `mailto:` URL (and differs from the text); any other
 *   scheme (`javascript:`, `data:`, relative links) keeps the text only.
 * - Named entities in common use and numeric ones are decoded; unknown
 *   ones are kept as written.
 * - Whitespace collapses as a browser would; at most one blank line in a
 *   row; lines are trimmed. The output stops at
 *   {@link MAX_TEXT_OUTPUT_LENGTH} characters.
 *
 * Pure: no I/O, no logging.
 */

/** HTML read, in characters (UTF-16 code units): the first 1 MB. */
export const MAX_HTML_INPUT_LENGTH = 1024 * 1024;

/** Longest text produced, in characters (UTF-16 code units): 256 KB. */
export const MAX_TEXT_OUTPUT_LENGTH = 256 * 1024;

/** Longest link target written next to its text; longer ones are left out. */
const MAX_HREF_LENGTH = 2048;

/** Longest entity name or number read after `&`, before giving up on it. */
const MAX_ENTITY_LENGTH = 32;

/** Elements dropped with all their content. */
const DROPPED_ELEMENTS: ReadonlySet<string> = new Set([
  "script",
  "style",
  "head",
  "title",
  "template",
]);

/** Elements whose opening or closing tag ends a line. */
const LINE_BREAK_ELEMENTS: ReadonlySet<string> = new Set([
  "br",
  "div",
  "tr",
  "ul",
  "ol",
  "table",
  "hr",
  "blockquote",
  "section",
  "article",
  "header",
  "footer",
]);

/** Elements whose opening or closing tag leaves a blank line. */
const PARAGRAPH_ELEMENTS: ReadonlySet<string> = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);

/** Table cells: separated by a space so their words do not run together. */
const CELL_ELEMENTS: ReadonlySet<string> = new Set(["td", "th"]);

/** Named entities decoded; anything else is kept as written. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  shy: "",
  zwnj: "",
  zwj: "",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
  lsquo: "\u2018",
  rsquo: "\u2019",
  sbquo: "\u201a",
  ldquo: "\u201c",
  rdquo: "\u201d",
  bdquo: "\u201e",
  laquo: "\u00ab",
  raquo: "\u00bb",
  bull: "\u2022",
  middot: "\u00b7",
  euro: "\u20ac",
  pound: "\u00a3",
  yen: "\u00a5",
  cent: "\u00a2",
  deg: "\u00b0",
  times: "\u00d7",
  divide: "\u00f7",
  plusmn: "\u00b1",
  sect: "\u00a7",
  para: "\u00b6",
  iexcl: "\u00a1",
  iquest: "\u00bf",
};

/** Whether `c` (a UTF-16 code unit) is HTML whitespace. */
function isSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d;
}

/** Whether `c` is an ASCII letter. */
function isLetter(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

/** Whether `c` may continue a tag name (letters, digits, `-`). */
function isNameChar(c: number): boolean {
  return isLetter(c) || (c >= 0x30 && c <= 0x39) || c === 0x2d;
}

/**
 * Collects the text: collapses whitespace, caps blank lines, trims lines
 * and stops at the output cap. Chunks are joined once at the end.
 */
class TextSink {
  private readonly chunks: string[] = [];
  private length = 0;
  /** Newlines owed before the next word (0 to 2). */
  private pendingNewlines = 0;
  /** A space owed before the next word on the current line. */
  private pendingSpace = false;
  /** Whether the current line has a word yet. */
  private lineHasText = false;
  /** Set once the cap is reached: everything after is ignored. */
  full = false;

  /** Appends text as HTML renders it: runs of whitespace become one space. */
  text(value: string): void {
    let start = -1;
    for (let i = 0; i < value.length && !this.full; i += 1) {
      if (isSpace(value.charCodeAt(i))) {
        if (start >= 0) this.word(value.slice(start, i));
        start = -1;
        if (this.lineHasText) this.pendingSpace = true;
      } else if (start < 0) {
        start = i;
      }
    }
    if (start >= 0 && !this.full) this.word(value.slice(start));
  }

  /** Ends the line; `blank` also leaves an empty line after it. */
  newline(blank = false): void {
    if (this.length === 0) return;
    const wanted = blank ? 2 : 1;
    if (this.pendingNewlines < wanted) this.pendingNewlines = wanted;
    this.pendingSpace = false;
    this.lineHasText = false;
  }

  /** Text that must stay as written (a link target). */
  literal(value: string): void {
    this.word(value);
  }

  /** A list marker: the item's text follows after one space. */
  marker(value: string): void {
    this.word(value);
    this.pendingSpace = true;
  }

  /** The text written since `mark()`, to compare a link's text with its target. */
  mark(): number {
    return this.chunks.length;
  }

  since(mark: number): string {
    return this.chunks.slice(mark).join("");
  }

  /** Whether anything was written since `mark()`. */
  wroteSince(mark: number): boolean {
    return this.chunks.length > mark;
  }

  /** Separates the next word with a space, as between table cells. */
  space(): void {
    if (this.lineHasText) this.pendingSpace = true;
  }

  private word(value: string): void {
    if (value === "" || this.full) return;
    let prefix = "";
    if (this.pendingNewlines > 0 && this.length > 0) {
      prefix = "\n".repeat(this.pendingNewlines);
    } else if (this.pendingSpace && this.lineHasText) {
      prefix = " ";
    }
    this.pendingNewlines = 0;
    this.pendingSpace = false;
    this.push(prefix + value);
    this.lineHasText = true;
  }

  private push(value: string): void {
    const room = MAX_TEXT_OUTPUT_LENGTH - this.length;
    if (value.length >= room) {
      let cut = room;
      /** Never end on half a surrogate pair. */
      const last = value.charCodeAt(cut - 1);
      if (cut > 0 && last >= 0xd800 && last <= 0xdbff) cut -= 1;
      this.chunks.push(value.slice(0, cut));
      this.length += cut;
      this.full = true;
      return;
    }
    this.chunks.push(value);
    this.length += value.length;
  }

  toString(): string {
    return this.chunks.join("");
  }
}

/** One parsed tag: its lowercase name, and what the converter needs from it. */
interface ParsedTag {
  name: string;
  closing: boolean;
  /** The `href` attribute's raw value, if any. */
  href: string | null;
  /** Index just past the tag's `>`, or -1 when the tag never ends. */
  end: number;
}

/**
 * Parses a tag whose name starts at `nameStart` (just after `<` or `</`). Reads attributes up to the closing `>`, honouring quoted
 * values (a `>` inside quotes does not end the tag). Linear in the tag.
 */
function parseTag(html: string, nameStart: number, closing: boolean): ParsedTag {
  let i = nameStart;
  while (i < html.length && isNameChar(html.charCodeAt(i))) i += 1;
  const name = html.slice(nameStart, i).toLowerCase();
  let href: string | null = null;

  while (i < html.length) {
    const c = html.charCodeAt(i);
    if (c === 0x3e /* > */) return { name, closing, href, end: i + 1 };
    if (isSpace(c) || c === 0x2f /* / */) {
      i += 1;
      continue;
    }
    /** An attribute name runs to whitespace, `=`, `>` or `/`. */
    const attrStart = i;
    while (i < html.length) {
      const a = html.charCodeAt(i);
      if (isSpace(a) || a === 0x3d || a === 0x3e || a === 0x2f) break;
      i += 1;
    }
    const attrName = html.slice(attrStart, i).toLowerCase();
    while (i < html.length && isSpace(html.charCodeAt(i))) i += 1;
    if (html.charCodeAt(i) !== 0x3d /* = */) continue;
    i += 1;
    while (i < html.length && isSpace(html.charCodeAt(i))) i += 1;
    let value: string;
    const quote = html.charCodeAt(i);
    if (quote === 0x22 || quote === 0x27) {
      const close = html.indexOf(quote === 0x22 ? '"' : "'", i + 1);
      if (close < 0) return { name, closing, href, end: -1 };
      value = html.slice(i + 1, close);
      i = close + 1;
    } else {
      const valueStart = i;
      while (i < html.length) {
        const v = html.charCodeAt(i);
        if (isSpace(v) || v === 0x3e) break;
        i += 1;
      }
      value = html.slice(valueStart, i);
    }
    if (attrName === "href" && href === null) href = value;
  }
  return { name, closing, href, end: -1 };
}

/**
 * Index just past the `</name ...>` that closes a dropped element, or -1
 * when there is none. Case-insensitive, without lowercasing the input
 * (lowercasing can change its length and so its indexes).
 */
function findClosingTag(html: string, from: number, name: string): number {
  let at = from;
  for (;;) {
    const open = html.indexOf("</", at);
    if (open < 0) return -1;
    const nameStart = open + 2;
    const candidate = html.slice(nameStart, nameStart + name.length);
    const after = html.charCodeAt(nameStart + name.length);
    if (candidate.toLowerCase() === name && (Number.isNaN(after) || !isNameChar(after))) {
      const close = html.indexOf(">", nameStart + name.length);
      return close < 0 ? -1 : close + 1;
    }
    at = nameStart;
  }
}

/** A code point as text, or U+FFFD when it is not a valid scalar value. */
function codePointText(value: number): string {
  if (
    !Number.isInteger(value) ||
    value <= 0 ||
    value > 0x10ffff ||
    (value >= 0xd800 && value <= 0xdfff)
  ) {
    return "\ufffd";
  }
  /** Control characters (other than whitespace) never reach the text. */
  if ((value < 0x20 && !isSpace(value)) || (value >= 0x7f && value <= 0x9f)) return "";
  return String.fromCodePoint(value);
}

/**
 * Decodes the entity at `html[at] === "&"`. Returns the text and the
 * index after it, or `null` when it is not a known entity (the `&` is
 * then kept as written).
 */
function decodeEntity(html: string, at: number): { text: string; next: number } | null {
  /** A bounded scan for the `;`: an `&` with none nearby costs a few steps, never a search to the end. */
  const limit = Math.min(html.length, at + 2 + MAX_ENTITY_LENGTH);
  let semi = -1;
  for (let j = at + 1; j < limit; j += 1) {
    if (html.charCodeAt(j) === 0x3b /* ; */) {
      semi = j;
      break;
    }
  }
  if (semi < 0) return null;
  const body = html.slice(at + 1, semi);
  if (body.startsWith("#")) {
    const hex = body[1] === "x" || body[1] === "X";
    const digits = body.slice(hex ? 2 : 1);
    if (digits === "" || !(hex ? /^[0-9a-f]+$/i : /^[0-9]+$/).test(digits)) return null;
    return {
      text: codePointText(Number.parseInt(digits, hex ? 16 : 10)),
      next: semi + 1,
    };
  }
  const named = Object.hasOwn(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : undefined;
  return named === undefined ? null : { text: named, next: semi + 1 };
}

/** Decodes every entity in a short value (an attribute), linearly. */
function decodeEntities(value: string): string {
  let out = "";
  let i = 0;
  while (i < value.length) {
    const amp = value.indexOf("&", i);
    if (amp < 0) {
      out += value.slice(i);
      break;
    }
    out += value.slice(i, amp);
    const decoded = decodeEntity(value, amp);
    if (decoded) {
      out += decoded.text;
      i = decoded.next;
    } else {
      out += "&";
      i = amp + 1;
    }
  }
  return out;
}

/**
 * The link target written after a link's text: an `http:`, `https:` or
 * `mailto:` URL with entities decoded, without whitespace or control
 * characters; `null` for any other scheme or an over-long target.
 */
function linkTarget(rawHref: string): string | null {
  if (rawHref.length > MAX_HREF_LENGTH * 2) return null;
  // oxlint-disable-next-line no-control-regex -- stripping control characters is the point
  const href = decodeEntities(rawHref).replace(/[\s\x00-\x1f\x7f-\x9f]+/g, "");
  if (href.length === 0 || href.length > MAX_HREF_LENGTH) return null;
  return /^(?:https?:|mailto:)/i.test(href) ? href : null;
}

/** The first {@link MAX_HTML_INPUT_LENGTH} characters, never ending on half a surrogate pair. */
function boundedInput(html: string): string {
  if (html.length <= MAX_HTML_INPUT_LENGTH) return html;
  let end = MAX_HTML_INPUT_LENGTH;
  const last = html.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return html.slice(0, end);
}

/** An open link: where its text starts in the sink, and its target. */
interface OpenLink {
  mark: number;
  target: string | null;
}

/**
 * Converts HTML to readable plain text (see the file comment). Returns an
 * empty string when the HTML holds no text.
 */
export function htmlToText(input: string): string {
  const html = boundedInput(input);
  const sink = new TextSink();
  let link: OpenLink | null = null;
  /** Start of the text run not yet written. */
  let runStart = 0;
  let i = 0;

  const flush = (end: number): void => {
    if (end > runStart) sink.text(html.slice(runStart, end));
  };

  while (i < html.length && !sink.full) {
    const c = html.charCodeAt(i);

    if (c === 0x26 /* & */) {
      flush(i);
      const decoded = decodeEntity(html, i);
      if (decoded) {
        /** A decoded space (`&nbsp;`) still collapses like any other. */
        sink.text(decoded.text);
        i = decoded.next;
      } else {
        sink.text("&");
        i += 1;
      }
      runStart = i;
      continue;
    }

    if (c !== 0x3c /* < */) {
      i += 1;
      continue;
    }

    const next = html.charCodeAt(i + 1);
    /** Comments, declarations and processing instructions are dropped. */
    if (next === 0x21 /* ! */ || next === 0x3f /* ? */) {
      flush(i);
      const isComment = html.startsWith("<!--", i);
      const close = isComment ? html.indexOf("-->", i + 4) : html.indexOf(">", i + 2);
      if (close < 0) {
        runStart = html.length;
        break;
      }
      i = close + (isComment ? 3 : 1);
      runStart = i;
      continue;
    }

    const closing = next === 0x2f; /* / */
    const nameStart = closing ? i + 2 : i + 1;
    /** A `<` that does not start a tag is text (`a < b`). */
    if (!isLetter(html.charCodeAt(nameStart))) {
      i += 1;
      continue;
    }

    flush(i);
    const tag = parseTag(html, nameStart, closing);
    if (tag.end < 0) {
      /** A tag that never ends: the rest is markup, not text. */
      runStart = html.length;
      break;
    }
    i = tag.end;
    runStart = i;

    if (!tag.closing && DROPPED_ELEMENTS.has(tag.name)) {
      const after = findClosingTag(html, i, tag.name);
      if (after < 0) {
        runStart = html.length;
        break;
      }
      i = after;
      runStart = i;
      continue;
    }

    if (tag.name === "a") {
      if (!tag.closing) {
        link = {
          mark: sink.mark(),
          target: tag.href === null ? null : linkTarget(tag.href),
        };
      } else if (link !== null) {
        const { mark, target } = link;
        link = null;
        if (target !== null) {
          const text = sink.since(mark).trim();
          const bare = target.replace(/^mailto:/i, "");
          if (!sink.wroteSince(mark)) sink.literal(target);
          else if (text !== target && text !== bare) {
            sink.space();
            sink.literal(`(${target})`);
          }
        }
      }
      continue;
    }

    if (tag.name === "li") {
      sink.newline();
      if (!tag.closing) sink.marker("-");
      continue;
    }
    if (PARAGRAPH_ELEMENTS.has(tag.name)) {
      sink.newline(true);
      continue;
    }
    if (LINE_BREAK_ELEMENTS.has(tag.name)) {
      sink.newline();
      continue;
    }
    if (CELL_ELEMENTS.has(tag.name)) sink.space();
  }
  if (!sink.full) flush(html.length);

  return sink
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}
