/**
 * DKIM signature verification (RFC 6376) for inbound mail (#373), on
 * `node:crypto` and our TXT lookup (`utils/dns-txt.ts`, which keeps a
 * multi-string key record whole where Bun's `resolveTxt` splits it): rsa-sha256 with keys of 1024 bits or
 * more and ed25519-sha256 (RFC 8463). rsa-sha1 is not accepted (RFC 8301).
 * Used for the DKIM verdict on feedback-loop reports, which is logged only.
 *
 * Strict on the signature: a tag-list that breaks RFC 6376 section 3.2, a
 * missing required tag, `h=` without From or `i=` outside `d=` is not
 * verified at all. One result per DKIM-Signature header field, in header
 * order; a message without one gets an empty list. ARC header fields are
 * not DKIM signatures and are not looked at.
 *
 * Results follow RFC 8601 section 2.7.1:
 * - `pass` / `fail`: the signature verified, or did not (body hash or
 *   header signature);
 * - `neutral`: the signature has syntax errors or cannot be processed
 *   (unknown algorithm or canonicalization), or it expired (`x=`);
 * - `policy`: rsa-sha1, or an RSA key shorter than 1024 bits;
 * - `permerror`: no key record (NXDOMAIN or no data), a revoked key (empty
 *   `p=`), a key record with syntax errors, or a key that does not fit the
 *   signature (`k=`, `h=`, `s=`, `t=s`);
 * - `temperror`: any other DNS failure.
 *
 * Messages are read as latin1, one character per byte, so every offset is
 * a byte offset and the bytes hashed are the bytes received. Bare LF line
 * ends are read as CRLF. Every regex here is linear in its input.
 */

import { createHash, createPublicKey, verify, type KeyObject } from "crypto";
import { domainToASCII } from "url";
import { resolveTxtRecords } from "../../../utils/dns-txt.ts";
import { logger } from "../../../utils/logger.ts";

/** The verdict on one signature (RFC 8601 section 2.7.1, without `none`). */
export type DkimResult =
  "pass" | "fail" | "neutral" | "temperror" | "permerror" | "policy";

/** What the verifier found for one DKIM-Signature header field. */
export interface DkimSignatureResult {
  result: DkimResult;
  /** `d=` as written in the signature, or null when it has none. */
  signingDomain: string | null;
  /** `s=` as written in the signature, or null when it has none. */
  selector: string | null;
  /** Why the result is not `pass`, for logs; null on `pass`. */
  reason: string | null;
  /** The key record has `t=y`: the domain is testing DKIM (RFC 6376 section 3.6.1). */
  testing: boolean;
}

/** Injectable for tests: the TXT lookup and the clock. */
export interface DkimVerifyDeps {
  /** A TXT lookup shaped like `dns/promises.resolveTxt`: one entry per record, each a list of strings. */
  resolveTxt?: (name: string) => Promise<string[][]>;
  now?: () => number;
}

/** The signing algorithms a DKIM-Signature can name and this verifier knows. */
type Algorithm = "rsa-sha256" | "ed25519-sha256" | "rsa-sha1";

/** A canonicalization algorithm (RFC 6376 section 3.4). */
type Canonicalization = "simple" | "relaxed";

/** One header field: its lowercased name and the raw field, folds included, without the final CRLF. */
interface HeaderField {
  name: string;
  raw: string;
}

/** A DKIM-Signature that passed the syntax checks. */
interface ParsedSignature {
  algorithm: Algorithm;
  signature: Buffer;
  bodyHash: string;
  headerCanon: Canonicalization;
  bodyCanon: Canonicalization;
  /** `d=` as an A-label in lower case, for the key lookup. */
  domain: string;
  /** `s=` as an A-label in lower case, for the key lookup. */
  selector: string;
  /** `h=`, lowercased, in order. */
  signedHeaders: string[];
  /** The domain of `i=` as an A-label in lower case, or null without `i=`. */
  identityDomain: string | null;
  bodyLength: number | null;
  expiration: number | null;
}

/** A public key record that passed the syntax checks. */
interface DkimKey {
  type: "rsa" | "ed25519";
  key: KeyObject;
  /** The hash algorithms the key allows (`h=`), or null for all. */
  hashes: string[] | null;
  /** `t=` flags, lowercased. */
  flags: string[];
}

/** A failed step: the result and why. */
interface Failure {
  result: DkimResult;
  reason: string;
}

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
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** sig-t-tag and sig-x-tag are 1*12DIGIT. */
const TIMESTAMP = /^[0-9]{1,12}$/;

/** sig-l-tag is 1*76DIGIT. */
const BODY_LENGTH = /^[0-9]{1,76}$/;

/** RSA keys shorter than this are refused (RFC 8301 section 3.2). */
const MIN_RSA_BITS = 1024;

/** The tags every DKIM-Signature has (RFC 6376 section 3.5). */
const REQUIRED_TAGS = ["v", "a", "b", "bh", "d", "h", "s"];

/** SubjectPublicKeyInfo prefix of a raw 32-byte ed25519 key (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** The DNS error codes that mean the name or its TXT data does not exist. */
const NO_RECORD_CODES = new Set(["ENOTFOUND", "ENODATA"]);

/** True for SP, HTAB, CR and LF, the characters of FWS. */
function isFws(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\r" || char === "\n";
}

/** Removes FWS at both ends, with index arithmetic so it stays linear. */
function trimFws(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isFws(value[start])) start += 1;
  while (end > start && isFws(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

/** Lowercases A to Z only: `toLowerCase` would also fold latin1 bytes. */
function lowerAscii(value: string): string {
  return value.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

/** Removes every FWS character (b=, bh=, p= and h= allow it anywhere). */
function stripFws(value: string): string {
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
 * Parses a tag-list (RFC 6376 section 3.2): `name=value` pairs separated by
 * `;`, FWS around names and values, an optional final `;`. Tag names are
 * case-sensitive. Returns null on a syntax error, a repeated tag included.
 */
function parseTagList(value: string): Map<string, string> | null {
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
function splitList(value: string): string[] {
  return value.split(":").map((entry) => lowerAscii(trimFws(entry)));
}

/** Decodes dkim-quoted-printable (RFC 6376 section 2.11), used by `i=`. */
function decodeQuotedPrintable(value: string): string {
  return stripFws(value).replace(/=([0-9A-Fa-f]{2})/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/** The value of a header field: everything after its first colon. */
function fieldValue(raw: string): string {
  const colon = raw.indexOf(":");
  return colon < 0 ? "" : raw.slice(colon + 1);
}

/**
 * Splits a message into its header fields and its body. Bare LF line ends
 * become CRLF first. A line that starts with SP or HTAB continues the field
 * above it; the header section ends at the first empty line.
 */
function splitMessage(message: Uint8Array): { fields: HeaderField[]; body: string } {
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
function canonicalBody(body: string, canon: Canonicalization): string {
  if (canon === "simple") return `${trimTrailingLineBreaks(body)}\r\n`;
  let relaxed = body.replace(/[ \t]+/g, " ").replace(/ \r\n/g, "\r\n");
  if (relaxed.endsWith(" ")) relaxed = relaxed.slice(0, -1);
  relaxed = trimTrailingLineBreaks(relaxed);
  return relaxed === "" ? "" : `${relaxed}\r\n`;
}

/**
 * Reads the tags of one DKIM-Signature (RFC 6376 section 6.1.1). Returns
 * the signature, or the `neutral` (syntax) or `policy` (rsa-sha1) failure.
 */
function parseSignature(raw: string): ParsedSignature | Failure {
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

/** The public key in a `p=` value, or null when it is not a key of that type. */
function importKey(type: "rsa" | "ed25519", data: Buffer): KeyObject | null {
  const candidates =
    type === "ed25519"
      ? data.length === 32
        ? [Buffer.concat([ED25519_SPKI_PREFIX, data])]
        : []
      : [data];
  for (const der of candidates) {
    for (const format of type === "rsa"
      ? (["spki", "pkcs1"] as const)
      : (["spki"] as const)) {
      try {
        const key = createPublicKey({ key: der, format: "der", type: format });
        if (key.asymmetricKeyType === type) return key;
      } catch {
        /** Not this encoding; try the next one. */
      }
    }
  }
  return null;
}

/**
 * Looks up and reads the key record at `<s>._domainkey.<d>` (RFC 6376
 * sections 3.6.1 and 6.1.2). The strings of a record are joined; with
 * several records the first is used.
 */
async function lookupKey(
  name: string,
  resolve: (name: string) => Promise<string[][]>,
): Promise<DkimKey | Failure> {
  let records: string[][];
  try {
    records = await resolve(name);
  } catch (error: unknown) {
    const code: unknown =
      typeof error === "object" && error !== null
        ? Reflect.get(error, "code")
        : undefined;
    if (typeof code === "string" && NO_RECORD_CODES.has(code)) {
      return { result: "permerror", reason: "no key record" };
    }
    return {
      result: "temperror",
      reason: `DNS failure: ${typeof code === "string" ? code : "unknown"}`,
    };
  }
  const [first] = records;
  if (first === undefined) return { result: "permerror", reason: "no key record" };

  const keyError = (reason: string): Failure => ({ result: "permerror", reason });
  const tags = parseTagList(first.join(""));
  if (tags === null) return keyError("key record syntax error");
  const version = tags.get("v");
  if (
    version !== undefined &&
    (version !== "DKIM1" || tags.keys().next().value !== "v")
  ) {
    return keyError("unknown key version");
  }
  const encoded = tags.get("p");
  if (encoded === undefined) return keyError("key record syntax error");
  const publicKey = stripFws(encoded);
  if (publicKey === "") return keyError("key revoked");
  if (!BASE64.test(publicKey) || publicKey.length % 4 !== 0) {
    return keyError("key record syntax error");
  }

  const keyType = lowerAscii(tags.get("k") ?? "rsa");
  if (keyType !== "rsa" && keyType !== "ed25519") return keyError("unknown key type");
  const services = tags.get("s");
  if (services !== undefined) {
    const list = splitList(services);
    if (!list.includes("email") && !list.includes("*"))
      return keyError("key not for email");
  }

  const key = importKey(keyType, Buffer.from(publicKey, "base64"));
  if (key === null) return keyError("invalid public key");
  if (
    keyType === "rsa" &&
    (key.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_RSA_BITS
  ) {
    return { result: "policy", reason: `RSA key shorter than ${MIN_RSA_BITS} bits` };
  }

  const hashes = tags.get("h");
  return {
    type: keyType,
    key,
    hashes: hashes === undefined ? null : splitList(hashes),
    flags: splitList(tags.get("t") ?? ""),
  };
}

/** Narrows a parse or lookup outcome to its failure. */
function isFailure(value: ParsedSignature | DkimKey | Failure): value is Failure {
  return "result" in value;
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
function signedHeaderData(
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

/** Checks the header signature with the key: rsa-sha256 signs the data, ed25519-sha256 its SHA-256. */
function signatureVerifies(
  data: Buffer,
  signature: ParsedSignature,
  key: KeyObject,
): boolean {
  try {
    return signature.algorithm === "ed25519-sha256"
      ? verify(null, createHash("sha256").update(data).digest(), key, signature.signature)
      : verify("sha256", data, key, signature.signature);
  } catch {
    return false;
  }
}

/**
 * Verifies every DKIM-Signature of a message. Resolves one result per
 * signature, in header order, and never rejects: a DNS failure is a
 * `temperror` result. Callers bound the number of signatures and the size
 * of the header section, and the time the lookups may take.
 *
 * @param message - The raw message as received
 * @param deps    - The TXT lookup (`resolveTxt`) and clock; injectable for tests
 * @returns One result per DKIM-Signature header field (empty when there is none)
 */
export async function verifyDkimSignatures(
  message: Uint8Array,
  deps: DkimVerifyDeps = {},
): Promise<DkimSignatureResult[]> {
  const resolve = deps.resolveTxt ?? resolveTxtRecords;
  const now = deps.now ?? Date.now;
  const { fields, body } = splitMessage(message);

  /** Per message: canonical bodies by canonicalization, body hashes by canonicalization and l=, key lookups by name. */
  const canonicalBodies = new Map<Canonicalization, string>();
  const bodyHashes = new Map<string, string>();
  const keys = new Map<string, Promise<DkimKey | Failure>>();

  const verifyOne = async (
    field: HeaderField,
  ): Promise<Omit<DkimSignatureResult, "signingDomain" | "selector">> => {
    const signature = parseSignature(field.raw);
    if (isFailure(signature)) return { ...signature, testing: false };

    if (signature.expiration !== null && signature.expiration * 1000 < now()) {
      return { result: "neutral", reason: "signature expired", testing: false };
    }

    const hashKey = `${signature.bodyCanon}:${signature.bodyLength ?? ""}`;
    let bodyHash = bodyHashes.get(hashKey);
    if (bodyHash === undefined) {
      let canonical = canonicalBodies.get(signature.bodyCanon);
      if (canonical === undefined) {
        canonical = canonicalBody(body, signature.bodyCanon);
        canonicalBodies.set(signature.bodyCanon, canonical);
      }
      const covered =
        signature.bodyLength === null
          ? canonical
          : canonical.slice(0, signature.bodyLength);
      bodyHash = createHash("sha256").update(covered, "latin1").digest("base64");
      bodyHashes.set(hashKey, bodyHash);
    }
    if (bodyHash !== signature.bodyHash) {
      return { result: "fail", reason: "body hash did not verify", testing: false };
    }

    const name = `${signature.selector}._domainkey.${signature.domain}`;
    let lookup = keys.get(name);
    if (lookup === undefined) {
      lookup = lookupKey(name, resolve);
      keys.set(name, lookup);
    }
    const key = await lookup;
    if (isFailure(key)) return { ...key, testing: false };
    const testing = key.flags.includes("y");

    const keyMismatch = (
      reason: string,
    ): Omit<DkimSignatureResult, "signingDomain" | "selector"> => ({
      result: "permerror",
      reason,
      testing,
    });
    if (!signature.algorithm.startsWith(`${key.type}-`)) {
      return keyMismatch("key type does not match the signature algorithm");
    }
    if (key.hashes !== null && !key.hashes.includes("sha256")) {
      return keyMismatch("key does not allow sha256");
    }
    if (
      key.flags.includes("s") &&
      signature.identityDomain !== null &&
      signature.identityDomain !== signature.domain
    ) {
      return keyMismatch("key t=s forbids an i= subdomain");
    }

    const data = signedHeaderData(fields, field, signature);
    return signatureVerifies(data, signature, key.key)
      ? { result: "pass", reason: null, testing }
      : { result: "fail", reason: "signature did not verify", testing };
  };

  const results: DkimSignatureResult[] = [];
  for (const field of fields) {
    if (field.name !== "dkim-signature") continue;
    const tags = parseTagList(fieldValue(field.raw));
    const outcome = await verifyOne(field);
    const result: DkimSignatureResult = {
      ...outcome,
      signingDomain: tags?.get("d") ?? null,
      selector: tags?.get("s") ?? null,
    };
    if (result.result !== "pass") {
      logger.debug("DKIM signature did not pass", {
        result: result.result,
        reason: result.reason,
        signingDomain: result.signingDomain,
        selector: result.selector,
      });
    }
    results.push(result);
  }
  return results;
}
