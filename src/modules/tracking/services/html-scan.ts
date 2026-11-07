/**
 * A bounded, single-pass scan of the real markup of an HTML body (#187),
 * shared by the link rewriter and the pixel insertion: it reports every
 * tag a browser would see as a tag, and skips what it would not.
 *
 * - Comments, `<!...>` declarations and `<?...?>` are skipped.
 * - The content of raw-text elements (`script`, `style`, `title`,
 *   `textarea`, `xmp`, `noscript`, `noembed`, `noframes`, `iframe`) is
 *   skipped up to its closing tag; `<plaintext>` makes the rest of the
 *   input text.
 * - A tag, comment or raw-text element that never ends stops the scan.
 *
 * Every search starts where the last one stopped and the cursor only
 * moves forward, so the scan is linear in the input. Attribute values are
 * honoured (a `>` or `<a` inside quotes is not markup). No regular
 * expression is built from the input. Pure.
 */

/** One attribute of a tag, by offsets into the HTML. */
export interface TagAttribute {
  /** Lowercased name. */
  name: string;
  /** Where the whitespace before the attribute starts (for removing it whole). */
  leadStart: number;
  /** Index just past the attribute (past its closing quote, if quoted). */
  end: number;
  /** The value's offsets, without quotes; null when the attribute has no value. */
  value: { start: number; end: number; quoted: boolean } | null;
}

/** A tag of the real markup. */
export interface ScannedTag {
  /** Lowercased name. */
  name: string;
  /** `</name ...>`. */
  closing: boolean;
  /** Index of its `<`. */
  start: number;
  /** Index just past its `>`. */
  end: number;
  attributes: TagAttribute[];
}

/** Elements whose content is never markup, with the search for their closing tag. */
const RAW_TEXT_CLOSERS: ReadonlyMap<string, RegExp> = new Map([
  ["script", /<\/script(?=[\s/>])/gi],
  ["style", /<\/style(?=[\s/>])/gi],
  ["title", /<\/title(?=[\s/>])/gi],
  ["textarea", /<\/textarea(?=[\s/>])/gi],
  ["xmp", /<\/xmp(?=[\s/>])/gi],
  ["noscript", /<\/noscript(?=[\s/>])/gi],
  ["noembed", /<\/noembed(?=[\s/>])/gi],
  ["noframes", /<\/noframes(?=[\s/>])/gi],
  ["iframe", /<\/iframe(?=[\s/>])/gi],
]);

function isSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d;
}

function isLetter(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

function isNameChar(c: number): boolean {
  return isLetter(c) || (c >= 0x30 && c <= 0x39) || c === 0x2d;
}

/**
 * Parses the tag whose name starts at `nameStart`, attributes and all, up
 * to its `>`, honouring quoted values. `end` is -1 when it never ends.
 */
function parseTag(
  html: string,
  nameStart: number,
): { name: string; attributes: TagAttribute[]; end: number } {
  let i = nameStart;
  while (i < html.length && isNameChar(html.charCodeAt(i))) i += 1;
  const name = html.slice(nameStart, i).toLowerCase();
  const attributes: TagAttribute[] = [];

  while (i < html.length) {
    const leadStart = i;
    while (i < html.length) {
      const c = html.charCodeAt(i);
      if (!isSpace(c) && c !== 0x2f /* / */) break;
      i += 1;
    }
    if (i >= html.length) break;
    if (html.charCodeAt(i) === 0x3e /* > */) return { name, attributes, end: i + 1 };

    const attrStart = i;
    while (i < html.length) {
      const a = html.charCodeAt(i);
      if (isSpace(a) || a === 0x3d || a === 0x3e || a === 0x2f) break;
      i += 1;
    }
    /** A lone `=` (no name) is consumed as one character, so the loop always advances. */
    if (i === attrStart) i += 1;
    const attrName = html.slice(attrStart, i).toLowerCase();
    let afterName = i;
    while (afterName < html.length && isSpace(html.charCodeAt(afterName))) afterName += 1;
    if (html.charCodeAt(afterName) !== 0x3d /* = */) {
      attributes.push({ name: attrName, leadStart, end: i, value: null });
      continue;
    }
    i = afterName + 1;
    while (i < html.length && isSpace(html.charCodeAt(i))) i += 1;
    const quote = html.charCodeAt(i);
    if (quote === 0x22 || quote === 0x27) {
      const close = html.indexOf(quote === 0x22 ? '"' : "'", i + 1);
      if (close < 0) return { name, attributes, end: -1 };
      attributes.push({
        name: attrName,
        leadStart,
        end: close + 1,
        value: { start: i + 1, end: close, quoted: true },
      });
      i = close + 1;
    } else {
      const valueStart = i;
      while (i < html.length) {
        const v = html.charCodeAt(i);
        if (isSpace(v) || v === 0x3e) break;
        i += 1;
      }
      attributes.push({
        name: attrName,
        leadStart,
        end: i,
        value: { start: valueStart, end: i, quoted: false },
      });
    }
  }
  return { name, attributes, end: -1 };
}

/** Index past the `>` of the tag closing a raw-text element, or -1 when there is none. */
function skipRawText(html: string, from: number, closer: RegExp): number {
  closer.lastIndex = from;
  const match = closer.exec(html);
  if (!match) return -1;
  const close = html.indexOf(">", match.index + match[0].length);
  return close < 0 ? -1 : close + 1;
}

/** Calls `visit` for every tag of the real markup, in order (see the file comment). */
export function scanMarkup(html: string, visit: (tag: ScannedTag) => void): void {
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) return;
    const next = html.charCodeAt(lt + 1);

    if (next === 0x21 /* ! */ || next === 0x3f /* ? */) {
      const isComment = html.startsWith("<!--", lt);
      const close = isComment ? html.indexOf("-->", lt + 4) : html.indexOf(">", lt + 2);
      if (close < 0) return;
      i = close + (isComment ? 3 : 1);
      continue;
    }

    const closing = next === 0x2f; /* / */
    const nameStart = closing ? lt + 2 : lt + 1;
    if (!isLetter(html.charCodeAt(nameStart))) {
      i = lt + 1;
      continue;
    }

    const parsed = parseTag(html, nameStart);
    if (parsed.end < 0) return;
    visit({ ...parsed, closing, start: lt });
    i = parsed.end;
    if (closing) continue;
    if (parsed.name === "plaintext") return;

    const closer = RAW_TEXT_CLOSERS.get(parsed.name);
    if (closer !== undefined) {
      const after = skipRawText(html, i, closer);
      if (after < 0) return;
      i = after;
    }
  }
}

/** Index of the `<` of the last real `</body>` tag, or -1 when there is none. */
export function lastBodyClose(html: string): number {
  let last = -1;
  scanMarkup(html, (tag) => {
    if (tag.closing && tag.name === "body") last = tag.start;
  });
  return last;
}
