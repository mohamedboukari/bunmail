import { domainToASCII } from "url";
import type { Failure, HeaderField, ParsedSignature } from "../types/dkim.types.ts";

/**
 * Reading a message and its DKIM-Signature header fields (#373): the
 * RFC 6376 grammar (tag-lists, domains and selectors, FWS), the split
 * into header fields and body, and the signature's tags.
 */

/** RFC 6376 section 3.5 sub-domain. */
const DOMAIN_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";

/** domain-name = sub-domain 1*("." sub-domain) */
const DOMAIN_NAME = new RegExp(`^${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL})+$`);

/** selector = sub-domain *("." sub-domain) */
const SELECTOR = new RegExp(`^${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL})*$`);

/** tag-name = ALPHA *ALNUMPUNC (RFC 6376 section 3.2) */
const TAG_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** A character that may not appear in a tag value: controls, `;` and DEL. FWS is allowed. */
const BAD_TAG_VALUE_CHAR = /[^\x21-\x3a\x3c-\x7e\x80-\xff \t\r\n]/;

/** base64 with its padding, whitespace already removed. */
export const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** sig-t-tag and sig-x-tag are 1*12DIGIT. */
const TIMESTAMP = /^[0-9]{1,12}$/;

/** sig-l-tag is 1*76DIGIT. */
const BODY_LENGTH = /^[0-9]{1,76}$/;

/** The tags every DKIM-Signature has (RFC 6376 section 3.5). */
const REQUIRED_TAGS = ["v", "a", "b", "bh", "d", "h", "s"];

/** True for SP, HTAB, CR and LF, the characters of FWS. */
function isFws(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\r" || char === "\n";
}

/** Removes FWS at both ends, with index arithmetic so it stays linear. */
export function trimFws(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isFws(value[start])) start += 1;
  while (end > start && isFws(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

/** Lowercases A to Z only: `toLowerCase` would also fold latin1 bytes. */
export function lowerAscii(value: string): string {
  return value.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

/** Removes every FWS character (b=, bh=, p= and h= allow it anywhere). */
export function stripFws(value: string): string {
  return value.replace(/[ \t\r\n]+/g, "");
}

/**
 * A domain or selector as a lowercase A-label (RFC 8616 section 4: a
 * U-label is converted first), or null when it is not valid. The input is
 * latin1, so non-ASCII is decoded from UTF-8 before the conversion.
 */
function toALabel(value: string, pattern: RegExp): string | null {
  const ascii = /[\x80-\xff]/.test(value)
    ? domainToASCII(Buffer.from(value, "latin1").toString("utf8"))
    : value;
  const lower = lowerAscii(ascii);
  return pattern.test(lower) ? lower : null;
}

/**
 * The `d=` tag of a signature (as `parseTagList` returned it) in the form
 * the verifier looked its key up under: a lowercase A-label, or null when
 * it is not a valid domain name. Lets a caller compare the signing domain
 * of a passing result with exactly the name whose key verified it.
 */
export function signingDomainOf(value: string): string | null {
  return toALabel(value, DOMAIN_NAME);
}

/**
 * Parses a tag-list (RFC 6376 section 3.2): `name=value` pairs separated by
 * `;`, FWS around names and values, an optional final `;`. Tag names are
 * case-sensitive. Returns null on a syntax error, a repeated tag included.
 */
export function parseTagList(value: string): Map<string, string> | null {
  const tags = new Map<string, string>();
  const specs = value.split(";");
  for (const [index, spec] of specs.entries()) {
    if (trimFws(spec) === "") {
      if (index === specs.length - 1) continue;
      return null;
    }
    const eq = spec.indexOf("=");
    if (eq < 0) return null;
    const name = trimFws(spec.slice(0, eq));
    const tagValue = trimFws(spec.slice(eq + 1));
    if (!TAG_NAME.test(name) || tags.has(name) || BAD_TAG_VALUE_CHAR.test(tagValue)) {
      return null;
    }
    tags.set(name, tagValue);
  }
  return tags;
}

/** Splits a colon-separated list (h=, and key h=, s=, t=) into lowercased, trimmed entries. */
export function splitList(value: string): string[] {
  return value.split(":").map((entry) => lowerAscii(trimFws(entry)));
}

/** Decodes dkim-quoted-printable (RFC 6376 section 2.11), used by `i=`. */
function decodeQuotedPrintable(value: string): string {
  return stripFws(value).replace(/=([0-9A-Fa-f]{2})/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/** The value of a header field: everything after its first colon. */
export function fieldValue(raw: string): string {
  const colon = raw.indexOf(":");
  return colon < 0 ? "" : raw.slice(colon + 1);
}

/**
 * Splits a message into its header fields and its body. Bare LF line ends
 * become CRLF first. A line that starts with SP or HTAB continues the field
 * above it; the header section ends at the first empty line.
 */
export function splitMessage(message: Uint8Array): {
  fields: HeaderField[];
  body: string;
} {
  const text = Buffer.from(message.buffer, message.byteOffset, message.byteLength)
    .toString("latin1")
    .replace(/\r?\n/g, "\r\n");

  let headerText: string;
  let body: string;
  if (text.startsWith("\r\n")) {
    headerText = "";
    body = text.slice(2);
  } else {
    const end = text.indexOf("\r\n\r\n");
    headerText = end < 0 ? text : text.slice(0, end);
    body = end < 0 ? "" : text.slice(end + 4);
  }

  const fields: HeaderField[] = [];
  for (const line of headerText === "" ? [] : headerText.split("\r\n")) {
    const previous = fields.at(-1);
    if ((line.startsWith(" ") || line.startsWith("\t")) && previous !== undefined) {
      previous.raw += `\r\n${line}`;
      continue;
    }
    fields.push({ name: "", raw: line });
  }
  for (const field of fields) {
    const colon = field.raw.indexOf(":");
    field.name = colon < 0 ? "" : lowerAscii(trimFws(field.raw.slice(0, colon)));
  }
  return { fields, body };
}

/**
 * Reads the tags of one DKIM-Signature (RFC 6376 section 6.1.1). Returns
 * the signature, or the `neutral` (syntax) or `policy` (rsa-sha1) failure.
 */
export function parseSignature(raw: string): ParsedSignature | Failure {
  const syntaxError = (reason: string): Failure => ({ result: "neutral", reason });
  const tags = parseTagList(fieldValue(raw));
  if (tags === null) return syntaxError("signature syntax error");
  if (REQUIRED_TAGS.some((tag) => !tags.has(tag))) {
    return syntaxError("signature missing required tag");
  }
  if (tags.get("v") !== "1") return syntaxError("incompatible version");

  const algorithm = lowerAscii(tags.get("a") ?? "");
  if (
    algorithm !== "rsa-sha256" &&
    algorithm !== "ed25519-sha256" &&
    algorithm !== "rsa-sha1"
  ) {
    return syntaxError("unsupported algorithm");
  }

  const signature = stripFws(tags.get("b") ?? "");
  const bodyHash = stripFws(tags.get("bh") ?? "");
  if (
    !BASE64.test(signature) ||
    signature.length % 4 !== 0 ||
    !BASE64.test(bodyHash) ||
    bodyHash.length % 4 !== 0
  ) {
    return syntaxError("signature syntax error");
  }

  const [headerCanon = "", bodyCanon = "simple", ...extra] = lowerAscii(
    tags.get("c") ?? "simple/simple",
  ).split("/");
  if (
    extra.length > 0 ||
    (headerCanon !== "simple" && headerCanon !== "relaxed") ||
    (bodyCanon !== "simple" && bodyCanon !== "relaxed")
  ) {
    return syntaxError("unsupported canonicalization");
  }

  const domain = toALabel(tags.get("d") ?? "", DOMAIN_NAME);
  const selector = toALabel(tags.get("s") ?? "", SELECTOR);
  if (domain === null || selector === null) return syntaxError("signature syntax error");

  const signedHeaders = splitList(tags.get("h") ?? "");
  if (signedHeaders.some((name) => name === ""))
    return syntaxError("signature syntax error");
  if (!signedHeaders.includes("from")) return syntaxError("From field not signed");

  const query = tags.get("q");
  if (query !== undefined && !splitList(query).includes("dns/txt")) {
    return syntaxError("unsupported query method");
  }

  let identityDomain: string | null = null;
  const identity = tags.get("i");
  if (identity !== undefined) {
    const decoded = decodeQuotedPrintable(identity);
    const at = decoded.lastIndexOf("@");
    identityDomain = at < 0 ? null : toALabel(decoded.slice(at + 1), DOMAIN_NAME);
    if (identityDomain === null) return syntaxError("signature syntax error");
    if (identityDomain !== domain && !identityDomain.endsWith(`.${domain}`)) {
      return syntaxError("i= domain is not d= or a subdomain of it");
    }
  }

  const numbers: Partial<Record<"l" | "t" | "x", number>> = {};
  for (const [tag, pattern] of [
    ["l", BODY_LENGTH],
    ["t", TIMESTAMP],
    ["x", TIMESTAMP],
  ] as const) {
    const value = tags.get(tag);
    if (value === undefined) continue;
    if (!pattern.test(value)) return syntaxError("signature syntax error");
    numbers[tag] = Number(value);
  }
  if (numbers.t !== undefined && numbers.x !== undefined && numbers.x <= numbers.t) {
    return syntaxError("invalid expiration");
  }

  if (algorithm === "rsa-sha1") {
    return { result: "policy", reason: "rsa-sha1 is not accepted (RFC 8301)" };
  }

  return {
    algorithm,
    signature: Buffer.from(signature, "base64"),
    bodyHash,
    headerCanon,
    bodyCanon,
    domain,
    selector,
    signedHeaders,
    identityDomain,
    bodyLength: numbers.l ?? null,
    expiration: numbers.x ?? null,
  };
}
