/**
 * Pure DMARC aggregate (rua) report parser. Takes a binary attachment
 * (zip or gzip; both formats appear in the wild — Microsoft uses zip,
 * Google / Yahoo use gzip) and returns a structured `ParsedDmarcReport`
 * or `null` when the bytes don't match the expected shape.
 *
 * The parser is pure: no I/O, no DB. Tests feed in fixture buffers and
 * assert on the parsed shape.
 *
 * Two stages:
 *   1. **Decompression** — sniff the first bytes; gzip starts with
 *      `1f 8b`, zip with `50 4b 03 04` (`PK\x03\x04`). gzip yields the
 *      XML directly; zip is unpacked and we take the first XML entry
 *      (RFC 7489 reports always contain a single XML file).
 *   2. **XML → ParsedDmarcReport** — `fast-xml-parser` produces a JS
 *      object tree; we walk the canonical RFC 7489 path
 *      (`feedback > report_metadata`, `policy_published`, `record[]`).
 *
 * RFC 7489 schema reference:
 *   https://datatracker.ietf.org/doc/html/rfc7489#appendix-C
 */

import { Gunzip, Unzip, UnzipInflate, strFromU8 } from "fflate";
import { XMLParser } from "fast-xml-parser";
import type {
  ParsedDmarcReport,
  ParsedDmarcRecord,
} from "../types/dmarc-report.types.ts";

const GZIP_MAGIC = [0x1f, 0x8b];
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

/**
 * Hard cap on decompressed output (#129). The inbound path caps the raw
 * message at 10 MB, but a gzip/zip attachment can expand ~1000:1, so a
 * tiny attachment could inflate to multiple GB and OOM / freeze the
 * (unauthenticated) inbound receiver. A real RFC 7489 aggregate report is
 * far smaller than this; 25 MB is a generous ceiling that still bounds the
 * blast radius. Decompression aborts the moment output crosses it.
 */
const MAX_DECOMPRESSED_BYTES = 25 * 1024 * 1024;

/**
 * Feed size per streaming `push()` (#129). We drive fflate's streaming
 * decompressors with small input slices so the output-size check runs
 * between slices and we abort *early* on a bomb — pushing the whole buffer
 * at once would let the decompressor inflate everything in one synchronous
 * call before we could react.
 */
const INFLATE_SLICE_BYTES = 64 * 1024;

/** Raised when decompression output exceeds {@link MAX_DECOMPRESSED_BYTES}. */
class DecompressionCapError extends Error {
  constructor() {
    super("dmarc: decompression exceeded output cap");
    this.name = "DecompressionCapError";
  }
}

/**
 * Collects streamed output chunks while enforcing the size cap. Throwing
 * from `add` unwinds the synchronous `push()` loop and aborts inflation.
 */
class CappedSink {
  private chunks: Uint8Array[] = [];
  private total = 0;

  add(chunk: Uint8Array): void {
    this.total += chunk.length;
    if (this.total > MAX_DECOMPRESSED_BYTES) throw new DecompressionCapError();
    this.chunks.push(chunk);
  }

  concat(): Uint8Array {
    const out = new Uint8Array(this.total);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }
}

/** Drives a streaming decompressor with sliced input so the cap can abort early. */
function pushSliced(
  bytes: Uint8Array,
  push: (slice: Uint8Array, final: boolean) => void,
): void {
  for (let i = 0; i < bytes.length; i += INFLATE_SLICE_BYTES) {
    const end = Math.min(i + INFLATE_SLICE_BYTES, bytes.length);
    push(bytes.subarray(i, end), end >= bytes.length);
  }
}

/**
 * gunzip with a hard output cap (#129). Streams the inflate and throws
 * {@link DecompressionCapError} once output crosses the ceiling.
 */
function gunzipCapped(bytes: Uint8Array): Uint8Array {
  const sink = new CappedSink();
  const gunzip = new Gunzip((chunk) => sink.add(chunk));
  pushSliced(bytes, (slice, final) => gunzip.push(slice, final));
  return sink.concat();
}

/**
 * Unzip the first `.xml` entry with a hard output cap (#129). Streams each
 * archive member; only the XML entry's bytes are retained. Throws
 * {@link DecompressionCapError} if the retained output crosses the ceiling.
 */
function unzipFirstXmlCapped(bytes: Uint8Array): Uint8Array | null {
  const sink = new CappedSink();
  let matched = false;

  const unzip = new Unzip((file) => {
    /** Take the first XML-shaped member; ignore the rest. */
    if (matched || !file.name.toLowerCase().endsWith(".xml")) return;
    matched = true;
    file.ondata = (err, chunk) => {
      if (err) throw err;
      sink.add(chunk);
    };
    file.start();
  });
  unzip.register(UnzipInflate);

  pushSliced(bytes, (slice, final) => unzip.push(slice, final));
  return matched ? sink.concat() : null;
}

/**
 * Detects compression format by file-magic-number. We don't trust the
 * Content-Type / filename — receivers' headers are inconsistent, but
 * the first 4 bytes are reliable.
 */
function detectFormat(bytes: Uint8Array): "gzip" | "zip" | "raw" {
  if (bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1]) return "gzip";
  if (
    bytes[0] === ZIP_MAGIC[0] &&
    bytes[1] === ZIP_MAGIC[1] &&
    bytes[2] === ZIP_MAGIC[2] &&
    bytes[3] === ZIP_MAGIC[3]
  ) {
    return "zip";
  }
  return "raw";
}

/**
 * Decompress (or pass through) the attachment buffer to a UTF-8 XML
 * string. Returns `null` if the format is unrecognised — the handler
 * uses that signal to skip the message and let normal inbound storage
 * take over.
 */
function decompressToXml(bytes: Uint8Array): string | null {
  const format = detectFormat(bytes);
  try {
    if (format === "gzip") {
      /** Capped streaming inflate — aborts on a decompression bomb (#129). */
      return strFromU8(gunzipCapped(bytes));
    }
    if (format === "zip") {
      /**
       * Microsoft's reports contain a single `.xml` entry. We take the
       * first XML-shaped file by name suffix. Capped streaming unzip aborts
       * on a bomb (#129).
       */
      const data = unzipFirstXmlCapped(bytes);
      if (!data) return null;
      return strFromU8(data);
    }
    if (format === "raw") {
      /** Raw (uncompressed) input can't be a bomb; it's already ≤ the
       *  inbound 10 MB message cap. */
      const text = strFromU8(bytes);
      /** Sanity-check this looks like an XML report before paying parse cost. */
      if (text.includes("<feedback") && text.includes("<report_metadata")) return text;
      return null;
    }
  } catch {
    /** Bad zip / gzip bytes, or a bomb that hit the cap → drop. The
     *  handler's null-check skips the message and normal inbound storage
     *  takes over. */
    return null;
  }
  return null;
}

/**
 * Coerces a value that may be `T`, `T[]`, or `undefined` into an array.
 * fast-xml-parser collapses single-element repeated children to scalars
 * by default (the `isArray` option exists but adds boilerplate per
 * field). This helper handles both shapes uniformly.
 */
function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Reads a leaf value as a string, tolerating fast-xml-parser's
 * promoting numerics and booleans to typed values.
 */
function asString(v: unknown): string {
  if (v === undefined || v === null) return "";
  return String(v);
}

/** Throws when the supplied feedback object is missing required fields. */
function readReportMetadata(feedback: Record<string, unknown>): {
  orgName: string;
  orgEmail: string;
  reportId: string;
  dateBegin: Date;
  dateEnd: Date;
} {
  const meta = feedback["report_metadata"] as Record<string, unknown> | undefined;
  if (!meta) throw new Error("DMARC report: missing <report_metadata>");
  const dateRange = meta["date_range"] as Record<string, unknown> | undefined;
  if (!dateRange) throw new Error("DMARC report: missing <date_range>");
  /**
   * `<begin>` / `<end>` are unix timestamps (seconds). Convert to ms
   * for the JS Date.
   */
  const begin = Number(dateRange["begin"]);
  const end = Number(dateRange["end"]);
  if (!Number.isFinite(begin) || !Number.isFinite(end)) {
    throw new Error("DMARC report: invalid date_range timestamps");
  }
  return {
    orgName: asString(meta["org_name"]),
    orgEmail: asString(meta["email"]),
    reportId: asString(meta["report_id"]),
    dateBegin: new Date(begin * 1000),
    dateEnd: new Date(end * 1000),
  };
}

function readPolicyPublished(feedback: Record<string, unknown>): {
  domain: string;
  policyP: string;
  policyPct: number;
} {
  const policy = feedback["policy_published"] as Record<string, unknown> | undefined;
  if (!policy) throw new Error("DMARC report: missing <policy_published>");
  return {
    domain: asString(policy["domain"]),
    policyP: asString(policy["p"]) || "none",
    /** `pct` defaults to 100 per RFC 7489 §6.3 if absent. */
    policyPct: policy["pct"] !== undefined ? Number(policy["pct"]) : 100,
  };
}

/**
 * Per-record reader. RFC 7489 records have a fixed shape:
 *   <record>
 *     <row>
 *       <source_ip>...</source_ip>
 *       <count>...</count>
 *       <policy_evaluated>
 *         <disposition>...</disposition>
 *         <dkim>pass|fail</dkim>
 *         <spf>pass|fail</spf>
 *       </policy_evaluated>
 *     </row>
 *     <identifiers>
 *       <header_from>...</header_from>
 *     </identifiers>
 *     <auth_results>
 *       <dkim>...</dkim>   (optional; possibly multiple)
 *       <spf>...</spf>     (optional; possibly multiple)
 *     </auth_results>
 *   </record>
 */
function readRecord(record: Record<string, unknown>): ParsedDmarcRecord | null {
  const row = record["row"] as Record<string, unknown> | undefined;
  if (!row) return null;
  const policyEval = row["policy_evaluated"] as Record<string, unknown> | undefined;
  const identifiers = record["identifiers"] as Record<string, unknown> | undefined;
  const authResults = record["auth_results"] as Record<string, unknown> | undefined;

  const sourceIp = asString(row["source_ip"]);
  if (!sourceIp) return null;

  const dkimAuth = toArray(authResults?.["dkim"])[0] as
    Record<string, unknown> | undefined;
  const spfAuth = toArray(authResults?.["spf"])[0] as Record<string, unknown> | undefined;

  return {
    sourceIp,
    count: Number(row["count"] ?? 0),
    disposition: asString(policyEval?.["disposition"]) || "none",
    /** `pass` is the only success value per the schema. */
    dkimAligned: asString(policyEval?.["dkim"]).toLowerCase() === "pass",
    spfAligned: asString(policyEval?.["spf"]).toLowerCase() === "pass",
    headerFrom: asString(identifiers?.["header_from"]),
    dkimAuthDomain: dkimAuth ? asString(dkimAuth["domain"]) || null : null,
    dkimSelector: dkimAuth ? asString(dkimAuth["selector"]) || null : null,
    dkimResult: dkimAuth ? asString(dkimAuth["result"]).toLowerCase() || null : null,
    spfAuthDomain: spfAuth ? asString(spfAuth["domain"]) || null : null,
    spfResult: spfAuth ? asString(spfAuth["result"]).toLowerCase() || null : null,
  };
}

/**
 * Public entry point. Returns `null` when the input isn't a parseable
 * DMARC aggregate report — caller falls back to normal inbound storage.
 */
export function parseAggregateReport(bytes: Uint8Array): ParsedDmarcReport | null {
  const xml = decompressToXml(bytes);
  if (!xml) return null;

  /**
   * Reject any DOCTYPE outright (#129). RFC 7489 aggregate reports never
   * carry one; its only use here would be an internal-entity "billion
   * laughs" definition, whose nested expansion pegs CPU during the
   * synchronous `parse()`. Cheap substring check before we hand the string
   * to the parser.
   */
  if (/<!DOCTYPE/i.test(xml)) return null;

  let parsed: Record<string, unknown>;
  try {
    const xmlParser = new XMLParser({
      ignoreAttributes: true,
      parseTagValue: true,
      /**
       * Disable entity processing (#129). fast-xml-parser doesn't fetch
       * external entities (no classic XXE), but internal entity expansion
       * is a CPU-exhaustion vector; DMARC reports use no custom entities.
       */
      processEntities: false,
    });
    parsed = xmlParser.parse(xml);
  } catch {
    return null;
  }

  const feedback = parsed["feedback"] as Record<string, unknown> | undefined;
  if (!feedback) return null;

  try {
    const metadata = readReportMetadata(feedback);
    const policy = readPolicyPublished(feedback);
    const recordEls = toArray(feedback["record"]);
    const records: ParsedDmarcRecord[] = recordEls
      .map((r) => readRecord(r as Record<string, unknown>))
      .filter((r): r is ParsedDmarcRecord => r !== null);

    return {
      orgName: metadata.orgName,
      orgEmail: metadata.orgEmail,
      reportId: metadata.reportId,
      domain: policy.domain,
      dateBegin: metadata.dateBegin,
      dateEnd: metadata.dateEnd,
      policyP: policy.policyP,
      policyPct: policy.policyPct,
      rawXml: xml,
      records,
    };
  } catch {
    return null;
  }
}

/**
 * Heuristic check that an inbound message *looks* like a DMARC report
 * before we pay the cost of decompression + XML parsing. Used by the
 * handler as a cheap pre-filter on every inbound message.
 *
 * Mirrors the gating that `bounce-parser.looksLikeBounce` does for
 * non-RFC bounces.
 */
export function looksLikeDmarcReport(raw: string): boolean {
  /** Subject pattern — every major receiver mentions "Report Domain" or "DMARC". */
  const subjectMatch = raw.match(/^Subject:\s*([^\r\n]+)/im);
  if (subjectMatch) {
    const subject = subjectMatch[1]!;
    if (/dmarc|report\s+domain/i.test(subject)) return true;
  }

  /** Sender pattern — known DMARC reporters. */
  const fromMatch = raw.match(/^From:\s*([^\r\n]+)/im);
  if (fromMatch) {
    const from = fromMatch[1]!;
    if (
      /noreply-dmarc-support@google\.com/i.test(from) ||
      /dmarcreport@yahoo\.com/i.test(from) ||
      /enterprise\.protection\.outlook\.com/i.test(from) ||
      /dmarc-no-reply@/i.test(from) ||
      /dmarc[-_]?support@/i.test(from)
    ) {
      return true;
    }
  }

  /** Content-Type pattern — XML directly attached. */
  if (/Content-Type:\s*application\/(?:x-)?(?:zip|gzip|x-gzip)/i.test(raw)) {
    /** Combined with a hint in the subject or body that this is DMARC.
     *  Don't classify as DMARC purely on a zip attachment — could be
     *  unrelated mail with a zip. */
    if (/dmarc|aggregate report/i.test(raw)) return true;
  }

  return false;
}
