/**
 * The DNS wire format of TXT lookups (`dns-txt.ts`): name checks, the query,
 * and the strict parse of an untrusted response. Pure and synchronous: no
 * sockets, no clock, nothing logged.
 *
 * - A response counts only when it carries our ID, QR set, opcode 0, and
 *   echoes our question (name compared case-insensitively in ASCII, type
 *   TXT, class IN); anything else is a `mismatch`, which the transport
 *   drops. One exception: a reply with our ID and QR set but no question
 *   (QDCOUNT 0), as some servers send for FORMERR, SERVFAIL, NOTIMP or
 *   REFUSED, is taken as that error. Never for NOERROR or NXDOMAIN, which
 *   need the question echoed.
 * - Every section is parsed with bounds checks. A compression pointer must
 *   point backwards into the message, past the header, at most 32 times per
 *   name; a name is at most 255 bytes on the wire.
 * - TXT records are the answer RRs of type TXT and class IN owned by the
 *   name asked, or by the end of a CNAME chain in the answer that starts
 *   there (the recursive resolver follows it), at most 16 links. Each
 *   RDATA is a run of `<length><bytes>` character-strings that must fill
 *   RDLENGTH exactly, and hold at least one. Anything malformed rejects the
 *   whole response (`EBADRESP`).
 * - Strings are decoded as latin1, one character per byte, as Node does
 *   (its c-ares binding builds them with `OneByteString`), so ASCII
 *   records read the same as with Node and no byte is lost or replaced.
 */

/** A `node:dns` error code a TXT lookup rejects with. */
export type DnsTxtErrorCode =
  | "ENOTFOUND"
  | "ENODATA"
  | "ESERVFAIL"
  | "EREFUSED"
  | "ENOTIMP"
  | "EFORMERR"
  | "ETIMEOUT"
  | "EBADRESP"
  | "ECONNREFUSED";

/** The query a response must answer: its ID and the question name's labels. */
export interface TxtQuestion {
  id: number;
  /** The labels of the name asked, lowercased (ASCII only). */
  labels: readonly string[];
}

/** What one response says. */
export type TxtResponseOutcome =
  /** Not an answer to our query (another ID, question or not a response): ignore it. */
  | { kind: "mismatch" }
  /** TC set: ask again over TCP. */
  | { kind: "truncated" }
  | { kind: "records"; records: string[][] }
  | { kind: "error"; code: DnsTxtErrorCode };

/** Size of the DNS header; a TCP message shorter than this is malformed. */
export const DNS_HEADER_BYTES = 12;
const TYPE_CNAME = 5;
const TYPE_TXT = 16;
const TYPE_OPT = 41;
const CLASS_IN = 1;
/** The UDP payload size advertised in EDNS0 (the DNS flag day 2020 value). */
const EDNS_UDP_PAYLOAD = 1232;
/** Longest name on the wire, length bytes and root label included (RFC 1035 2.3.4). */
const MAX_NAME_WIRE_BYTES = 255;
/** Longest name in text, without a trailing dot. */
const MAX_NAME_TEXT_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;
/** Compression pointers followed per name; backwards-only already rules out loops. */
const MAX_POINTER_JUMPS = 32;
/** CNAME links followed from the name asked; a longer chain is `EBADRESP`. */
export const MAX_CNAME_LINKS = 16;

/** RCODE to `node:dns` code; RCODEs not listed are `EBADRESP`. */
const RCODE_ERRORS: ReadonlyMap<number, DnsTxtErrorCode> = new Map([
  [1, "EFORMERR"],
  [2, "ESERVFAIL"],
  [3, "ENOTFOUND"],
  [4, "ENOTIMP"],
  [5, "EREFUSED"],
]);

/** RCODEs accepted from a reply without a question (QDCOUNT 0): failures only. */
const QUESTIONLESS_RCODES: ReadonlySet<number> = new Set([1, 2, 4, 5]);

/* ─── Names ─── */

/**
 * The labels of `hostname`, lowercased, or `null` when it is not a name a
 * query can carry: empty, an empty label, a label over 63 characters, over
 * 253 characters in all, or a character outside printable ASCII (or a
 * backslash, which resolvers read as an escape). One trailing dot is
 * allowed. Callers pass A-labels: a Unicode name is refused, not encoded.
 */
export function nameLabels(hostname: string): string[] | null {
  const name = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  if (name === "" || name.length > MAX_NAME_TEXT_LENGTH) return null;
  const labels = name.split(".");
  for (const label of labels) {
    if (label.length === 0 || label.length > MAX_LABEL_LENGTH) return null;
    for (let i = 0; i < label.length; i++) {
      const code = label.charCodeAt(i);
      if (code < 0x21 || code > 0x7e || code === 0x5c) return null;
    }
  }
  return labels.map(asciiLower);
}

/** Lowercases A to Z only: DNS names compare case-insensitively in ASCII alone (RFC 4343). */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/** Whether two label lists name the same domain. */
function sameName(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((label, i) => label === right[i]);
}

/** A key for a map of names: labels can hold any byte, so they are not joined with dots. */
function nameKey(labels: readonly string[]): string {
  return JSON.stringify(labels);
}

/* ─── Query ─── */

/**
 * The wire form of a TXT query (RD set, one question `<name> TXT IN`), with
 * an EDNS0 OPT record advertising 1232 bytes unless `edns` is false (the
 * retry after a FORMERR).
 */
export function encodeQuery(question: TxtQuestion, edns = true): Uint8Array {
  const nameBytes = question.labels.reduce((total, label) => total + label.length + 1, 1);
  /** Header, name, QTYPE and QCLASS, then the OPT record (root name, 10 fixed bytes). */
  const bytes = new Uint8Array(DNS_HEADER_BYTES + nameBytes + 4 + (edns ? 11 : 0));
  const view = new DataView(bytes.buffer);
  view.setUint16(0, question.id);
  /** QR 0, opcode 0, RD 1. */
  view.setUint16(2, 0x0100);
  view.setUint16(4, 1);
  view.setUint16(10, edns ? 1 : 0);
  let at = DNS_HEADER_BYTES;
  for (const label of question.labels) {
    bytes[at++] = label.length;
    for (let i = 0; i < label.length; i++) bytes[at++] = label.charCodeAt(i);
  }
  bytes[at++] = 0;
  view.setUint16(at, TYPE_TXT);
  view.setUint16(at + 2, CLASS_IN);
  at += 4;
  if (edns) {
    /** OPT: root owner, type 41, CLASS = UDP payload size, TTL 0 (version 0, no DO), no RDATA. */
    bytes[at++] = 0;
    view.setUint16(at, TYPE_OPT);
    view.setUint16(at + 2, EDNS_UDP_PAYLOAD);
  }
  return bytes;
}

/* ─── Response ─── */

/** A structural error in a response; turned into `EBADRESP` at the top. */
class MalformedResponse extends Error {}

/** A name read from a message, and where the bytes after it start. */
interface ReadName {
  labels: string[];
  next: number;
}

/**
 * Reads a name at `start`, following compression pointers (RFC 1035 4.1.4)
 * only backwards and past the header, at most {@link MAX_POINTER_JUMPS}
 * times, and at most 255 bytes on the wire.
 */
function readName(message: Uint8Array, start: number): ReadName {
  const labels: string[] = [];
  let at = start;
  let next = -1;
  let wireBytes = 0;
  let jumps = 0;
  for (;;) {
    const length = message[at];
    if (length === undefined) throw new MalformedResponse("name runs past the end");
    if ((length & 0xc0) === 0xc0) {
      const low = message[at + 1];
      if (low === undefined) throw new MalformedResponse("pointer runs past the end");
      const target = ((length & 0x3f) << 8) | low;
      if (target >= at || target < DNS_HEADER_BYTES) {
        throw new MalformedResponse("compression pointer not backwards");
      }
      if (++jumps > MAX_POINTER_JUMPS) throw new MalformedResponse("too many pointers");
      if (next < 0) next = at + 2;
      at = target;
      continue;
    }
    if ((length & 0xc0) !== 0) throw new MalformedResponse("unknown label type");
    wireBytes += length + 1;
    if (wireBytes > MAX_NAME_WIRE_BYTES) throw new MalformedResponse("name too long");
    if (length === 0) {
      return { labels, next: next < 0 ? at + 1 : next };
    }
    const end = at + 1 + length;
    if (end > message.length) throw new MalformedResponse("label runs past the end");
    labels.push(asciiLower(latin1(message, at + 1, end)));
    at = end;
  }
}

/** Bytes `start` to `end` as latin1, one character per byte (Node's decoding of TXT data). */
function latin1(message: Uint8Array, start: number, end: number): string {
  return Buffer.from(message.buffer, message.byteOffset + start, end - start).toString(
    "latin1",
  );
}

/** One resource record's fixed fields and where its RDATA lies. */
interface ResourceRecord {
  owner: string[];
  type: number;
  rrClass: number;
  ttl: number;
  rdataStart: number;
  rdataEnd: number;
}

/** Reads the resource record at `start`, bounds-checked. */
function readRecord(message: Uint8Array, view: DataView, start: number): ResourceRecord {
  const { labels, next } = readName(message, start);
  if (next + 10 > message.length)
    throw new MalformedResponse("record header runs past the end");
  const rdataStart = next + 10;
  const rdataEnd = rdataStart + view.getUint16(next + 8);
  if (rdataEnd > message.length) throw new MalformedResponse("RDATA runs past the end");
  return {
    owner: labels,
    type: view.getUint16(next),
    rrClass: view.getUint16(next + 2),
    ttl: view.getUint32(next + 4),
    rdataStart,
    rdataEnd,
  };
}

/** The character-strings of one TXT RDATA; they must fill it exactly, at least one. */
function txtStrings(message: Uint8Array, record: ResourceRecord): string[] {
  const strings: string[] = [];
  let at = record.rdataStart;
  while (at < record.rdataEnd) {
    const length = message[at] ?? 0;
    const end = at + 1 + length;
    if (end > record.rdataEnd)
      throw new MalformedResponse("character-string overruns RDATA");
    strings.push(latin1(message, at + 1, end));
    at = end;
  }
  if (strings.length === 0) throw new MalformedResponse("TXT record without a string");
  return strings;
}

/**
 * What `response` says about `question`. Never throws: a response that is
 * not ours is a `mismatch`, a malformed one past the question an
 * `EBADRESP` error.
 */
export function parseTxtResponse(
  response: Uint8Array,
  question: TxtQuestion,
): TxtResponseOutcome {
  if (response.length < DNS_HEADER_BYTES) return { kind: "mismatch" };
  const view = new DataView(response.buffer, response.byteOffset, response.byteLength);
  const flags = view.getUint16(2);
  const isResponse = (flags & 0x8000) !== 0;
  const opcode = (flags >> 11) & 0x0f;
  if (view.getUint16(0) !== question.id || !isResponse || opcode !== 0) {
    return { kind: "mismatch" };
  }
  const questionCount = view.getUint16(4);
  if (questionCount === 0 && QUESTIONLESS_RCODES.has(flags & 0x0f)) {
    return { kind: "error", code: RCODE_ERRORS.get(flags & 0x0f) ?? "EBADRESP" };
  }
  if (questionCount !== 1) return { kind: "mismatch" };

  /** The question must be ours; if it cannot even be read, this is not our answer. */
  let at: number;
  try {
    const asked = readName(response, DNS_HEADER_BYTES);
    if (asked.next + 4 > response.length) return { kind: "mismatch" };
    const type = view.getUint16(asked.next);
    const qclass = view.getUint16(asked.next + 2);
    if (
      !sameName(asked.labels, question.labels) ||
      type !== TYPE_TXT ||
      qclass !== CLASS_IN
    ) {
      return { kind: "mismatch" };
    }
    at = asked.next + 4;
  } catch {
    return { kind: "mismatch" };
  }

  if ((flags & 0x0200) !== 0) return { kind: "truncated" };

  try {
    return readSections(response, view, at, flags & 0x0f, question);
  } catch (error: unknown) {
    if (error instanceof MalformedResponse) return { kind: "error", code: "EBADRESP" };
    throw error;
  }
}

/** Reads the answer, authority and additional sections after the question at `start`. */
function readSections(
  response: Uint8Array,
  view: DataView,
  start: number,
  headerRcode: number,
  question: TxtQuestion,
): TxtResponseOutcome {
  const answerCount = view.getUint16(6);
  const authorityCount = view.getUint16(8);
  const additionalCount = view.getUint16(10);
  const answers: ResourceRecord[] = [];
  let at = start;
  let optRecords = 0;
  let rcode = headerRcode;
  for (let i = 0; i < answerCount + authorityCount + additionalCount; i++) {
    const record = readRecord(response, view, at);
    at = record.rdataEnd;
    if (i < answerCount) {
      answers.push(record);
    } else if (i >= answerCount + authorityCount && record.type === TYPE_OPT) {
      /** RFC 6891 6.1.1: one OPT at most, owned by the root; its TTL carries the RCODE's upper 8 bits. */
      if (++optRecords > 1 || record.owner.length > 0) {
        throw new MalformedResponse("bad OPT record");
      }
      rcode |= (record.ttl >>> 24) << 4;
    }
  }

  const rcodeError = rcode === 0 ? null : (RCODE_ERRORS.get(rcode) ?? "EBADRESP");
  if (rcodeError !== null) return { kind: "error", code: rcodeError };

  const owners = chainOwners(response, answers, question.labels);
  const records: string[][] = [];
  for (const record of answers) {
    if (record.type !== TYPE_TXT) continue;
    /** Malformed TXT data rejects the response even when the record is not ours. */
    const strings = txtStrings(response, record);
    if (record.rrClass === CLASS_IN && owners.has(nameKey(record.owner))) {
      records.push(strings);
    }
  }
  return records.length > 0
    ? { kind: "records", records }
    : { kind: "error", code: "ENODATA" };
}

/**
 * The name asked and every name the answer's CNAME chain leads to from it:
 * every CNAME RDATA is read once into an owner-to-target map (an owner with
 * two different targets is malformed), then the chain is walked from the
 * name asked, at most {@link MAX_CNAME_LINKS} links. A loop ends the walk.
 */
function chainOwners(
  response: Uint8Array,
  answers: readonly ResourceRecord[],
  asked: readonly string[],
): Set<string> {
  const targets = new Map<string, string[]>();
  for (const record of answers) {
    if (record.type !== TYPE_CNAME || record.rrClass !== CLASS_IN) continue;
    const target = readName(response, record.rdataStart);
    if (target.next !== record.rdataEnd) throw new MalformedResponse("bad CNAME RDATA");
    const owner = nameKey(record.owner);
    const known = targets.get(owner);
    if (known !== undefined && !sameName(known, target.labels)) {
      throw new MalformedResponse("two CNAMEs for one owner");
    }
    targets.set(owner, target.labels);
  }

  let current = nameKey(asked);
  const owners = new Set([current]);
  for (let links = 0; ; links++) {
    const target = targets.get(current);
    if (target === undefined) return owners;
    if (links >= MAX_CNAME_LINKS) throw new MalformedResponse("CNAME chain too long");
    current = nameKey(target);
    if (owners.has(current)) return owners;
    owners.add(current);
  }
}
