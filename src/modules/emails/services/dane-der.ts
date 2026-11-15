/**
 * The DER the DANE matcher needs from a certificate (#345): its own
 * SubjectPublicKeyInfo bytes, which a selector SPKI(1) TLSA record is
 * compared with (RFC 6698 section 2.1.1). They are read from the
 * certificate as sent, never re-encoded from the parsed key: a re-encoding
 * changes a compressed EC point into an uncompressed one, and some key
 * types (RSA-PSS) do not parse at all, so neither would ever match.
 *
 * A small, bounds-checked walk over X.509 (RFC 5280 section 4.1):
 *
 *   Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signature }
 *   TBSCertificate ::= SEQUENCE { [0] version OPTIONAL, serialNumber INTEGER,
 *     signature SEQUENCE, issuer SEQUENCE, validity SEQUENCE,
 *     subject SEQUENCE, subjectPublicKeyInfo SEQUENCE, ... }
 *
 * Definite lengths only (DER), at most 4 length bytes, every element
 * inside its parent. Anything else is `null`: no SPKI, so no match.
 *
 * The same walk reads on to the extensions for the one constraint a
 * DANE-TA(2) path needs that the runtime does not expose: the
 * basicConstraints path length ({@link pathLengthConstraint}, #455).
 */

/** DER tags met on the way. */
const TAG_SEQUENCE = 0x30;
const TAG_INTEGER = 0x02;
const TAG_VERSION = 0xa0;
const TAG_BIT_STRING = 0x03;
const TAG_BOOLEAN = 0x01;
const TAG_OCTET_STRING = 0x04;
const TAG_OID = 0x06;
/** `[3] EXPLICIT Extensions` of a TBSCertificate. */
const TAG_EXTENSIONS = 0xa3;
/** The DER content of the basicConstraints OID, 2.5.29.19. */
const BASIC_CONSTRAINTS_OID = [0x55, 0x1d, 0x13];

/** One DER element: its tag, where it starts, where its content starts and ends. */
interface Element {
  tag: number;
  start: number;
  contentStart: number;
  end: number;
}

/** Reads the element at `at`, which must end by `limit`; `null` when malformed. */
function readElement(der: Uint8Array, at: number, limit: number): Element | null {
  const tag = der[at];
  const first = der[at + 1];
  if (tag === undefined || first === undefined || at + 2 > limit) return null;
  /** Multi-byte tags never appear where this walk reads. */
  if ((tag & 0x1f) === 0x1f) return null;
  let length = first;
  let contentStart = at + 2;
  if (first & 0x80) {
    const count = first & 0x7f;
    /** 0x80 is BER's indefinite length, never DER; over 4 bytes is not a certificate. */
    if (count === 0 || count > 4) return null;
    length = 0;
    for (let i = 0; i < count; i++) {
      const byte = der[contentStart + i];
      if (byte === undefined) return null;
      length = length * 256 + byte;
    }
    contentStart += count;
  }
  const end = contentStart + length;
  if (end > limit) return null;
  return { tag, start: at, contentStart, end };
}

/** The TBSCertificate of a certificate and its SubjectPublicKeyInfo element, or `null`. */
function walkToSpki(certificate: Uint8Array): { tbs: Element; spki: Element } | null {
  const cert = readElement(certificate, 0, certificate.length);
  if (cert === null || cert.tag !== TAG_SEQUENCE) return null;
  const tbs = readElement(certificate, cert.contentStart, cert.end);
  if (tbs === null || tbs.tag !== TAG_SEQUENCE) return null;
  let at = tbs.contentStart;
  let element = readElement(certificate, at, tbs.end);
  if (element !== null && element.tag === TAG_VERSION) {
    at = element.end;
    element = readElement(certificate, at, tbs.end);
  }
  if (element === null || element.tag !== TAG_INTEGER) return null;
  /** signature, issuer, validity, subject: four SEQUENCEs before the SPKI. */
  for (let i = 0; i < 4; i++) {
    at = element.end;
    element = readElement(certificate, at, tbs.end);
    if (element === null || element.tag !== TAG_SEQUENCE) return null;
  }
  const spki = readElement(certificate, element.end, tbs.end);
  if (spki === null || !isSpki(certificate, spki)) return null;
  return { tbs, spki };
}

/**
 * The DER SubjectPublicKeyInfo of a certificate, exactly as it is encoded
 * in it, or `null` when the DER cannot be walked (see the module comment).
 */
export function subjectPublicKeyInfo(certificate: Uint8Array): Uint8Array | null {
  const walked = walkToSpki(certificate);
  return walked === null ? null : certificate.slice(walked.spki.start, walked.spki.end);
}

/**
 * The pathLenConstraint of a certificate's basicConstraints extension
 * (RFC 5280 section 4.2.1.9): the most non-self-issued intermediate
 * certificates that may follow it in a path. `null` when it sets none (no
 * extension, or no pathLenConstraint in it); `"malformed"` when the DER
 * cannot be walked, which the caller treats as a broken chain.
 *
 *   TBSCertificate ::= SEQUENCE { ..., subjectPublicKeyInfo,
 *     [1] issuerUniqueID OPTIONAL, [2] subjectUniqueID OPTIONAL,
 *     [3] EXPLICIT Extensions OPTIONAL }
 *   Extension ::= SEQUENCE { extnID OID, critical BOOLEAN DEFAULT FALSE,
 *     extnValue OCTET STRING }
 *   BasicConstraints ::= SEQUENCE { cA BOOLEAN DEFAULT FALSE,
 *     pathLenConstraint INTEGER (0..MAX) OPTIONAL }
 */
export function pathLengthConstraint(
  certificate: Uint8Array,
): number | null | "malformed" {
  const walked = walkToSpki(certificate);
  if (walked === null) return "malformed";
  let at = walked.spki.end;
  while (at < walked.tbs.end) {
    const element = readElement(certificate, at, walked.tbs.end);
    if (element === null) return "malformed";
    if (element.tag === TAG_EXTENSIONS) return basicConstraintsIn(certificate, element);
    at = element.end;
  }
  return null;
}

/** The pathLenConstraint in the `[3]` extensions element `wrapper`; see {@link pathLengthConstraint}. */
function basicConstraintsIn(
  der: Uint8Array,
  wrapper: Element,
): number | null | "malformed" {
  const list = readElement(der, wrapper.contentStart, wrapper.end);
  if (list === null || list.tag !== TAG_SEQUENCE) return "malformed";
  let at = list.contentStart;
  while (at < list.end) {
    const extension = readElement(der, at, list.end);
    if (extension === null || extension.tag !== TAG_SEQUENCE) return "malformed";
    at = extension.end;
    const id = readElement(der, extension.contentStart, extension.end);
    if (id === null || id.tag !== TAG_OID) return "malformed";
    if (!sameBytes(der.subarray(id.contentStart, id.end), BASIC_CONSTRAINTS_OID))
      continue;
    let value = readElement(der, id.end, extension.end);
    if (value !== null && value.tag === TAG_BOOLEAN) {
      value = readElement(der, value.end, extension.end);
    }
    if (value === null || value.tag !== TAG_OCTET_STRING) return "malformed";
    return pathLengthIn(der, value);
  }
  return null;
}

/** The pathLenConstraint of the BasicConstraints inside the extnValue `octets`. */
function pathLengthIn(der: Uint8Array, octets: Element): number | null | "malformed" {
  const constraints = readElement(der, octets.contentStart, octets.end);
  if (constraints === null || constraints.tag !== TAG_SEQUENCE) return "malformed";
  if (constraints.end !== octets.end) return "malformed";
  if (constraints.contentStart === constraints.end) return null;
  let field = readElement(der, constraints.contentStart, constraints.end);
  if (field !== null && field.tag === TAG_BOOLEAN) {
    if (field.end === constraints.end) return null;
    field = readElement(der, field.end, constraints.end);
  }
  if (field === null || field.tag !== TAG_INTEGER) return "malformed";
  return nonNegativeInteger(der.subarray(field.contentStart, field.end));
}

/** A DER INTEGER's value, which must not be negative; past any real path length it is capped. */
function nonNegativeInteger(bytes: Uint8Array): number | "malformed" {
  const first = bytes[0];
  if (first === undefined || (first & 0x80) !== 0) return "malformed";
  let value = 0;
  for (const byte of bytes) {
    value = value * 256 + byte;
    if (value > 0xffffff) return Number.MAX_SAFE_INTEGER;
  }
  return value;
}

/** Whether `bytes` are exactly `expected`. */
function sameBytes(bytes: Uint8Array, expected: readonly number[]): boolean {
  return (
    bytes.length === expected.length && expected.every((byte, i) => bytes[i] === byte)
  );
}

/**
 * Whether `element` of `der` is shaped like a SubjectPublicKeyInfo: a
 * SEQUENCE holding an AlgorithmIdentifier SEQUENCE and a BIT STRING, and
 * nothing else.
 */
function isSpki(der: Uint8Array, element: Element): boolean {
  if (element.tag !== TAG_SEQUENCE) return false;
  const algorithm = readElement(der, element.contentStart, element.end);
  if (algorithm === null || algorithm.tag !== TAG_SEQUENCE) return false;
  const key = readElement(der, algorithm.end, element.end);
  return key !== null && key.tag === TAG_BIT_STRING && key.end === element.end;
}

/**
 * Whether `data` is exactly one DER SubjectPublicKeyInfo: what a "x 1 0"
 * TLSA record must carry to be usable (RFC 6698 section 2.1.1).
 */
export function isSubjectPublicKeyInfo(data: Uint8Array): boolean {
  const element = readElement(data, 0, data.length);
  return element !== null && element.end === data.length && isSpki(data, element);
}
