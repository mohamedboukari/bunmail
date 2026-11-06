import type {
  Canonicalization,
  HeaderField,
  ParsedSignature,
} from "../types/dkim.types.ts";
import { lowerAscii, trimFws } from "./dkim-verifier-parse.service.ts";

/**
 * What a DKIM signature covers (#373): header and body canonicalization
 * (RFC 6376 section 3.4) and the header data the signature is checked
 * over (section 3.7).
 */

/**
 * Relaxed header canonicalization (RFC 6376 section 3.4.2): name in lower
 * case, value unfolded, runs of SP and HTAB as one SP, no whitespace at the
 * end of the value or around the colon. Only SP and HTAB are whitespace.
 */
function relaxedHeader(raw: string): string {
  const colon = raw.indexOf(":");
  if (colon < 0) return lowerAscii(trimFws(raw.replace(/\r\n/g, "")));
  const name = lowerAscii(trimFws(raw.slice(0, colon).replace(/\r\n/g, "")));
  let value = raw
    .slice(colon + 1)
    .replace(/\r\n/g, "")
    .replace(/[ \t]+/g, " ");
  if (value.startsWith(" ")) value = value.slice(1);
  if (value.endsWith(" ")) value = value.slice(0, -1);
  return `${name}:${value}`;
}

/**
 * The signature header field with its `b=` value emptied, surrounding
 * whitespace included (RFC 6376 section 3.7). The tag-list parser already
 * refused a repeated tag, so there is exactly one `b` tag.
 */
function emptySignatureValue(field: string): string {
  const colon = field.indexOf(":");
  const segments = field.slice(colon + 1).split(";");
  const index = segments.findIndex((segment) => {
    const eq = segment.indexOf("=");
    return eq >= 0 && trimFws(segment.slice(0, eq)) === "b";
  });
  const segment = segments[index];
  if (segment !== undefined) segments[index] = segment.slice(0, segment.indexOf("=") + 1);
  return `${field.slice(0, colon + 1)}${segments.join(";")}`;
}

/** Drops the CRLFs at the end of a body, with index arithmetic so it stays linear. */
function trimTrailingLineBreaks(body: string): string {
  let end = body.length;
  while (end >= 2 && body[end - 2] === "\r" && body[end - 1] === "\n") end -= 2;
  return body.slice(0, end);
}

/**
 * Body canonicalization (RFC 6376 sections 3.4.3 and 3.4.4). Simple: the
 * empty lines at the end are dropped and the body ends with one CRLF (an
 * empty body is a single CRLF). Relaxed: runs of SP and HTAB become one SP,
 * whitespace at the end of each line goes, the empty lines at the end are
 * dropped, and a non-empty body ends with one CRLF (an empty body stays
 * empty).
 */
export function canonicalBody(body: string, canon: Canonicalization): string {
  if (canon === "simple") return `${trimTrailingLineBreaks(body)}\r\n`;
  let relaxed = body.replace(/[ \t]+/g, " ").replace(/ \r\n/g, "\r\n");
  if (relaxed.endsWith(" ")) relaxed = relaxed.slice(0, -1);
  relaxed = trimTrailingLineBreaks(relaxed);
  return relaxed === "" ? "" : `${relaxed}\r\n`;
}

/**
 * The header fields `h=` selects, bottom up: each name takes the lowest
 * instance not taken yet, and a name with none left selects nothing (an
 * over-signed field, RFC 6376 section 5.4.2).
 */
function selectHeaders(fields: HeaderField[], names: string[]): HeaderField[] {
  const byName = new Map<string, HeaderField[]>();
  for (const field of fields) {
    const list = byName.get(field.name);
    if (list === undefined) byName.set(field.name, [field]);
    else list.push(field);
  }
  const selected: HeaderField[] = [];
  for (const name of names) {
    const field = byName.get(name)?.pop();
    if (field !== undefined) selected.push(field);
  }
  return selected;
}

/** The bytes the header signature covers (RFC 6376 section 3.7). */
export function signedHeaderData(
  fields: HeaderField[],
  signatureField: HeaderField,
  signature: ParsedSignature,
): Buffer {
  const canon =
    signature.headerCanon === "relaxed" ? relaxedHeader : (raw: string): string => raw;
  const lines = selectHeaders(fields, signature.signedHeaders).map(
    (field) => `${canon(field.raw)}\r\n`,
  );
  lines.push(emptySignatureValue(canon(signatureField.raw)));
  return Buffer.from(lines.join(""), "latin1");
}
