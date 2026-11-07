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
 */

/** DER tags met on the way. */
const TAG_SEQUENCE = 0x30;
const TAG_INTEGER = 0x02;
const TAG_VERSION = 0xa0;
const TAG_BIT_STRING = 0x03;

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

/**
 * The DER SubjectPublicKeyInfo of a certificate, exactly as it is encoded
 * in it, or `null` when the DER cannot be walked (see the module comment).
 */
export function subjectPublicKeyInfo(certificate: Uint8Array): Uint8Array | null {
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
  return certificate.slice(spki.start, spki.end);
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
