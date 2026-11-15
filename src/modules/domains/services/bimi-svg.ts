import { XMLParser, XMLValidator } from "fast-xml-parser";
import { quote } from "./bimi-record.ts";

/**
 * The SVG Tiny Portable/Secure checks of a BIMI logo (#415), after the
 * BIMI SVG profile (draft-svg-tiny-ps-abrotman): the root is `<svg>` with
 * `version="1.2"` and `baseProfile="tiny-ps"`, has a `<title>`, no `x=` or
 * `y=`, and a square `viewBox`; nothing in the document runs code, links
 * out, embeds an image or animates.
 *
 * The SVG comes from a URL anyone with the domain's DNS chooses, so it is
 * parsed defensively, as DMARC reports are (#129): a `<!DOCTYPE` is
 * refused before parsing (its only use here would be entity expansion),
 * entities are not processed, the parser refuses nesting deeper than 100
 * elements, and the tree is walked without recursion.
 * The document is only inspected, never rendered or stored.
 */

/** Elements the profile forbids, with what each one is. */
const FORBIDDEN_ELEMENTS: ReadonlyMap<string, string> = new Map([
  ["script", "a <script> element"],
  ["foreignobject", "a <foreignObject> element"],
  ["image", "an embedded image (<image>)"],
  ["a", "a link (<a>)"],
  ["animate", "animation (<animate>)"],
  ["animatemotion", "animation (<animateMotion>)"],
  ["animatetransform", "animation (<animateTransform>)"],
  ["animatecolor", "animation (<animateColor>)"],
  ["set", "animation (<set>)"],
  ["audio", "media (<audio>)"],
  ["video", "media (<video>)"],
  ["iframe", "an <iframe> element"],
]);

/**
 * Most document-wide problems listed; the rest are counted in one line, so
 * a hostile logo cannot fill the kept result (and the page) with thousands.
 */
const MAX_DOCUMENT_PROBLEMS = 20;

/** How far a `viewBox` may be from square: 1% of its height. */
const SQUARE_TOLERANCE = 0.01;

/** Plain object guard for the parser's output. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The local part of a qualified name, lowercased: `xlink:href` gives `href`. */
function localName(name: string): string {
  return (name.split(":").at(-1) ?? name).toLowerCase();
}

/** One element of the `preserveOrder` tree. */
interface SvgElement {
  name: string;
  attributes: Record<string, string>;
  children: unknown[];
}

/**
 * The element a `preserveOrder` node holds, or null for text, comments and
 * processing instructions (keys starting with `#` or `?`).
 */
function asElement(node: unknown): SvgElement | null {
  if (!isRecord(node)) return null;
  const name = Object.keys(node).find((key) => key !== ":@");
  if (name === undefined || name.startsWith("#") || name.startsWith("?")) return null;
  const children = node[name];
  const rawAttributes = node[":@"];
  const attributes: Record<string, string> = {};
  if (isRecord(rawAttributes)) {
    for (const [key, value] of Object.entries(rawAttributes)) {
      attributes[key] = typeof value === "string" ? value : String(value);
    }
  }
  return { name, attributes, children: Array.isArray(children) ? children : [] };
}

/** The text directly inside an element. */
function textOf(element: SvgElement): string {
  return element.children
    .map((child) =>
      isRecord(child) && typeof child["#text"] === "string" ? child["#text"] : "",
    )
    .join("")
    .trim();
}

/** True when a CSS value or `<style>` text reaches outside the document. */
function cssReachesOut(text: string): boolean {
  if (/@import/i.test(text)) return true;
  for (const match of text.matchAll(/url\(\s*['"]?\s*([^'")\s]*)/gi)) {
    if (!(match[1] ?? "").startsWith("#")) return true;
  }
  return false;
}

/** The `viewBox` problem of the root, or null when it is square. */
function viewBoxProblem(viewBox: string | undefined): string | null {
  if (viewBox === undefined) return "The root <svg> has no viewBox: add a square one";
  const numbers = viewBox
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const [, , width, height] = numbers;
  if (
    numbers.length !== 4 ||
    numbers.some((n) => !Number.isFinite(n)) ||
    width === undefined ||
    height === undefined ||
    width <= 0 ||
    height <= 0
  ) {
    return `viewBox="${quote(viewBox)}" is not four numbers with a positive width and height`;
  }
  if (Math.abs(width - height) > SQUARE_TOLERANCE * height) {
    return `viewBox="${quote(viewBox)}" is not square (the logo must have a 1:1 aspect ratio)`;
  }
  return null;
}

/** The root element's own rules. */
function rootProblems(root: SvgElement): string[] {
  const problems: string[] = [];
  const attribute = (name: string): string | undefined =>
    Object.entries(root.attributes).find(([key]) => key === name)?.[1];
  const version = attribute("version");
  if (version !== "1.2") {
    problems.push(
      version === undefined
        ? 'The root <svg> has no version: it must be version="1.2"'
        : `version="${quote(version)}": it must be version="1.2"`,
    );
  }
  const profile = attribute("baseProfile");
  if (profile !== "tiny-ps") {
    problems.push(
      profile === undefined
        ? 'The root <svg> has no baseProfile: it must be baseProfile="tiny-ps"'
        : `baseProfile="${quote(profile)}": it must be baseProfile="tiny-ps"`,
    );
  }
  if (attribute("x") !== undefined || attribute("y") !== undefined) {
    problems.push("The root <svg> has an x= or y= attribute: remove it");
  }
  const viewBox = viewBoxProblem(attribute("viewBox"));
  if (viewBox !== null) problems.push(viewBox);
  const title = root.children
    .map(asElement)
    .find((child) => child !== null && localName(child.name) === "title");
  if (!title) {
    problems.push("No <title> in the root <svg>: add one with the brand name");
  } else if (textOf(title) === "") {
    problems.push("The <title> is empty: put the brand name in it");
  }
  return problems;
}

/** The rules every element of the document follows. */
function documentProblems(root: SvgElement): string[] {
  const problems = new Set<string>();
  const stack: SvgElement[] = [root];
  for (let element = stack.pop(); element !== undefined; element = stack.pop()) {
    const name = localName(element.name);
    const forbidden = FORBIDDEN_ELEMENTS.get(name);
    if (forbidden !== undefined) problems.add(`The logo contains ${forbidden}`);
    if (name === "style" && cssReachesOut(textOf(element))) {
      problems.add("A <style> element loads something from outside the document");
    }
    for (const [key, value] of Object.entries(element.attributes)) {
      const attribute = localName(key);
      if (attribute.startsWith("on")) {
        problems.add(`The logo has an event handler attribute (${quote(key)}=)`);
      } else if (attribute === "href" && !value.trim().startsWith("#")) {
        problems.add(
          `The logo references an external resource (${quote(key)}="${quote(value)}")`,
        );
      } else if (cssReachesOut(value)) {
        problems.add(
          `The ${quote(key)}= attribute loads something from outside the document`,
        );
      }
    }
    for (const child of element.children) {
      const next = asElement(child);
      if (next !== null) stack.push(next);
    }
  }
  const listed = [...problems];
  if (listed.length <= MAX_DOCUMENT_PROBLEMS) return listed;
  return [
    ...listed.slice(0, MAX_DOCUMENT_PROBLEMS),
    `... and ${listed.length - MAX_DOCUMENT_PROBLEMS} more problems`,
  ];
}

/**
 * Every SVG Tiny PS rule `svg` breaks (#415), empty when it passes. Never
 * throws: a document that cannot be parsed is one problem.
 */
export function svgTinyPsProblems(svg: string): string[] {
  /** No DTD of any kind: refused before the parser sees it. */
  if (/<!DOCTYPE/i.test(svg)) {
    return [
      "The logo has a <!DOCTYPE>: SVG Tiny PS allows none (the file was not parsed)",
    ];
  }
  if (XMLValidator.validate(svg) !== true) {
    return ["The logo is not well-formed XML"];
  }
  let tree: unknown;
  try {
    tree = new XMLParser({
      preserveOrder: true,
      ignoreAttributes: false,
      attributeNamePrefix: "",
      /** No entity expansion (#129): the logo needs none. */
      processEntities: false,
      parseTagValue: false,
      parseAttributeValue: false,
      trimValues: true,
    }).parse(svg);
  } catch {
    /** The parser also refuses more than 100 nested elements (its `maxNestedTags`). */
    return ["The logo could not be parsed: it is malformed or nested too deeply"];
  }
  const roots = (Array.isArray(tree) ? tree : [])
    .map(asElement)
    .filter((element): element is SvgElement => element !== null);
  const [root] = roots;
  if (roots.length !== 1 || root === undefined || localName(root.name) !== "svg") {
    return ["The root element is not <svg>"];
  }
  return [...rootProblems(root), ...documentProblems(root)];
}
