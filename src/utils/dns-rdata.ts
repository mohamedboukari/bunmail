import {
  MalformedResponse,
  TYPE_A,
  TYPE_AAAA,
  TYPE_CNAME,
  TYPE_MX,
  TYPE_TLSA,
  parseAnswer,
  readName,
  type DnsQuestion,
  type ParsedAnswer,
  type ResourceRecord,
} from "./dns-wire.ts";

/**
 * The RDATA of the record types DANE looks up (#345): A, AAAA, MX, CNAME
 * and TLSA, decoded strictly on top of `dns-wire.ts` ({@link parseAnswer}).
 * Pure and synchronous.
 *
 * - A is exactly 4 bytes, AAAA exactly 16 (RFC 1035 3.4.1, RFC 3596 2.2),
 *   written as text (IPv6 in the RFC 5952 form).
 * - MX is a 16-bit preference and a name that fills the RDATA exactly
 *   (RFC 1035 3.3.9); CNAME a name that fills it exactly (3.3.1). Names
 *   may be compressed, with the same pointer rules as the rest of the
 *   message, and are kept as their lowercased labels.
 * - TLSA is the usage, selector and matching type bytes, then the
 *   certificate association data (RFC 6698 2.1), at least the three bytes.
 *   Whether a record is usable is DANE's call (`dane-verify.ts`), not the
 *   parser's: an unusable record is still a record (RFC 7672 2.2).
 *
 * A malformed record of the type asked rejects the whole response
 * (`EBADRESP`), as with TXT.
 */

/** One TLSA record (RFC 6698 2.1). */
export interface TlsaRecord {
  /** Certificate usage: 2 is DANE-TA, 3 is DANE-EE (RFC 7218). */
  usage: number;
  /** 0: the full certificate, 1: its SubjectPublicKeyInfo. */
  selector: number;
  /** 0: exact match, 1: SHA-256, 2: SHA-512. */
  matchingType: number;
  /** The certificate association data. */
  data: Uint8Array;
}

/** One decoded record of a DNSSEC-aware lookup. */
export type DnsRecord =
  | { type: "A"; address: string }
  | { type: "AAAA"; address: string }
  | { type: "MX"; preference: number; exchange: string[] }
  | { type: "CNAME"; target: string[] }
  | ({ type: "TLSA" } & TlsaRecord);

/** What a response to a {@link DnsQuestion} says, its records decoded. */
export type DnsResponseOutcome = ParsedAnswer<DnsRecord>;

/** The RDATA bytes of `record`. */
function rdata(message: Uint8Array, record: ResourceRecord): Uint8Array {
  return message.subarray(record.rdataStart, record.rdataEnd);
}

/** An IPv4 address in dotted-quad form. */
function ipv4(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => String(byte)).join(".");
}

/**
 * An IPv6 address in the RFC 5952 form: lowercase hex without leading
 * zeros, the longest run of two or more zero groups (the first of equal
 * runs) as `::`.
 */
export function ipv6(bytes: Uint8Array): string {
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2)
    groups.push(((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0));
  let bestStart = -1;
  let bestLength = 1;
  for (let i = 0; i < groups.length;) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let end = i;
    while (end < groups.length && groups[end] === 0) end++;
    if (end - i > bestLength) {
      bestStart = i;
      bestLength = end - i;
    }
    i = end;
  }
  const hex = groups.map((group) => group.toString(16));
  if (bestStart < 0) return hex.join(":");
  const head = hex.slice(0, bestStart).join(":");
  const tail = hex.slice(bestStart + bestLength).join(":");
  return `${head}::${tail}`;
}

/** A name in the RDATA that must fill it exactly from `start`. */
function rdataName(message: Uint8Array, start: number, end: number): string[] {
  const name = readName(message, start);
  if (name.next !== end) throw new MalformedResponse("name does not fill the RDATA");
  return name.labels;
}

/** Decodes one record of the type asked; throws {@link MalformedResponse} on bad RDATA. */
function decodeRecord(message: Uint8Array, record: ResourceRecord): DnsRecord {
  const bytes = rdata(message, record);
  switch (record.type) {
    case TYPE_A:
      if (bytes.length !== 4) throw new MalformedResponse("A RDATA is not 4 bytes");
      return { type: "A", address: ipv4(bytes) };
    case TYPE_AAAA:
      if (bytes.length !== 16) throw new MalformedResponse("AAAA RDATA is not 16 bytes");
      return { type: "AAAA", address: ipv6(bytes) };
    case TYPE_MX: {
      if (bytes.length < 3) throw new MalformedResponse("MX RDATA too short");
      const preference = ((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0);
      return {
        type: "MX",
        preference,
        exchange: rdataName(message, record.rdataStart + 2, record.rdataEnd),
      };
    }
    case TYPE_CNAME:
      return {
        type: "CNAME",
        target: rdataName(message, record.rdataStart, record.rdataEnd),
      };
    case TYPE_TLSA:
      if (bytes.length < 3) throw new MalformedResponse("TLSA RDATA too short");
      return {
        type: "TLSA",
        usage: bytes[0] ?? 0,
        selector: bytes[1] ?? 0,
        matchingType: bytes[2] ?? 0,
        data: Uint8Array.from(bytes.subarray(3)),
      };
    default:
      throw new MalformedResponse("unsupported record type");
  }
}

/**
 * What `response` says about `question` (A, AAAA, MX, CNAME or TLSA), its
 * records decoded. Never throws; see `parseAnswer` for the outcomes.
 */
export function parseDnsResponse(
  response: Uint8Array,
  question: DnsQuestion,
): DnsResponseOutcome {
  return parseAnswer(response, question, decodeRecord);
}

/**
 * A name from its labels, dotted, or `null` when a label holds a byte a
 * host name cannot (outside printable ASCII, a dot or a backslash): such a
 * name cannot be compared, queried or connected to safely. The root (no
 * labels) is the empty string, as a null MX's exchange.
 */
export function dottedName(labels: readonly string[]): string | null {
  for (const label of labels) {
    for (let i = 0; i < label.length; i++) {
      const code = label.charCodeAt(i);
      if (code < 0x21 || code > 0x7e || code === 0x2e || code === 0x5c) return null;
    }
  }
  return labels.join(".");
}

/** A TLSA record in presentation form (RFC 6698 2.2): `3 1 1 <hex>`, for logs and TLS reports. */
export function tlsaPresentation(record: TlsaRecord): string {
  const hex = Buffer.from(record.data).toString("hex").toUpperCase();
  return `${record.usage} ${record.selector} ${record.matchingType} ${hex}`;
}
