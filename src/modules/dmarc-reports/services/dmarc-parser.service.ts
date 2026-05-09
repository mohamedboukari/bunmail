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

import { gunzipSync, unzipSync, strFromU8 } from "fflate";
import { XMLParser } from "fast-xml-parser";
import type {
  ParsedDmarcReport,
  ParsedDmarcRecord,
} from "../types/dmarc-report.types.ts";

const GZIP_MAGIC = [0x1f, 0x8b];
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

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
      return strFromU8(gunzipSync(bytes));
    }
    if (format === "zip") {
      /**
       * Microsoft's reports contain a single `.xml` entry. We take the
       * first XML-shaped file by name suffix; in the unlikely case
       * there are multiple, we use the first match.
       */
      const entries = unzipSync(bytes);
      const xmlName = Object.keys(entries).find((n) => n.toLowerCase().endsWith(".xml"));
      if (!xmlName) return null;
      const data = entries[xmlName];
      if (!data) return null;
      return strFromU8(data);
    }
    if (format === "raw") {
      const text = strFromU8(bytes);
      /** Sanity-check this looks like an XML report before paying parse cost. */
      if (text.includes("<feedback") && text.includes("<report_metadata")) return text;
      return null;
    }
  } catch {
    /** Bad zip / gzip bytes → drop. The handler's null-check skips. */
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
    | Record<string, unknown>
    | undefined;
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

  let parsed: Record<string, unknown>;
  try {
    const xmlParser = new XMLParser({
      ignoreAttributes: true,
      parseTagValue: true,
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
