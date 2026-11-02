import type {
  SpfCheckInput,
  SpfDnsResolver,
  SpfResult,
} from "../src/modules/domains/types/spf.types.ts";

/**
 * SPF test data (#373): loads test files in the format of the OpenSPF
 * RFC 7208 suite (`test/fixtures/spf/rfc7208-tests.yml`) and serves their
 * `zonedata` as fake DNS, for the evaluator's unit tests and for the
 * script that recorded mailauth's results.
 *
 * Zone semantics follow the suite's reference driver (pyspf `testspf.py`):
 *
 * - Names are case-insensitive; a name not in the zone, or with no record
 *   of the queried type, rejects with `ENOTFOUND` (what Bun reports for
 *   both NXDOMAIN and no data).
 * - `TIMEOUT` rejects with `ETIMEOUT` when no record of the queried type
 *   came before it in the name's list, else ends the answer.
 * - `SPF` records are copied to TXT only when the name has no `TXT`
 *   entry at all (`TXT: NONE` means "no TXT record"); RFC 7208 queries TXT
 *   only.
 * - A `CNAME` is followed for every other type; a loop rejects with
 *   `ESERVFAIL`.
 */

/** One record of a test zone, or the `TIMEOUT` marker. */
type ZoneEntry =
  | "TIMEOUT"
  | { type: "TXT"; value: string[] }
  | { type: "A" | "AAAA" | "PTR" | "CNAME"; value: string }
  | { type: "MX"; value: { priority: number; exchange: string } };

/** A test zone: records per lowercased name. */
export type Zone = Map<string, ZoneEntry[]>;

/** One test case. */
export interface SpfTestCase {
  /** The test's name, unique in its file. */
  id: string;
  /** RFC 7208 section(s) the test is about. */
  spec: string;
  helo: string;
  /** The client IP. */
  host: string;
  /** MAIL FROM; empty means the HELO identity is checked. */
  mailfrom: string;
  /** Acceptable results (the suite lists several where the RFC allows them). */
  expected: SpfResult[];
  zone: Zone;
}

const RESULTS: ReadonlySet<string> = new Set([
  "pass",
  "fail",
  "softfail",
  "neutral",
  "none",
  "temperror",
  "permerror",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isResult(value: unknown): value is SpfResult {
  return typeof value === "string" && RESULTS.has(value);
}

/** A scalar field as a string (YAML may read `0` or `1.5` as numbers), `""` otherwise. */
function text(value: unknown): string {
  if (typeof value === "string") return value;
  return typeof value === "number" || typeof value === "boolean" ? String(value) : "";
}

/** The records of one name, per `getrdata` of the reference driver. */
function zoneEntries(name: string, rows: unknown): ZoneEntry[] {
  if (!Array.isArray(rows)) throw new Error(`zonedata of ${name} is not a list`);
  const entries: ZoneEntry[] = [];
  const fromSpf: ZoneEntry[] = [];
  let hasTxt = false;
  for (const row of rows) {
    if (row === "TIMEOUT") {
      entries.push("TIMEOUT");
      continue;
    }
    if (!isObject(row)) throw new Error(`bad zonedata row for ${name}`);
    for (const [type, value] of Object.entries(row)) {
      const strings = Array.isArray(value) ? value.map(text) : [text(value)];
      if (type === "TXT") hasTxt = true;
      if (type === "SPF") {
        if (value !== "NONE") fromSpf.push({ type: "TXT", value: strings });
        continue;
      }
      if (value === "NONE") continue;
      if (type === "TXT") entries.push({ type, value: strings });
      else if (type === "MX") {
        entries.push({
          type,
          value: { priority: Number(strings[0]), exchange: strings[1] ?? "" },
        });
      } else if (type === "A" || type === "AAAA" || type === "PTR" || type === "CNAME") {
        entries.push({ type, value: text(value) });
      } else {
        throw new Error(`unknown record type ${type} for ${name}`);
      }
    }
  }
  return hasTxt ? entries : [...entries, ...fromSpf];
}

/** The zone of one test file section. */
function parseZone(zonedata: unknown): Zone {
  const zone: Zone = new Map();
  if (!isObject(zonedata)) return zone;
  for (const [name, rows] of Object.entries(zonedata)) {
    zone.set(name.toLowerCase(), zoneEntries(name, rows));
  }
  return zone;
}

/**
 * Loads a test file: YAML documents separated by `---`, each with `tests`
 * and `zonedata`.
 */
export async function loadSpfTests(path: string): Promise<SpfTestCase[]> {
  /**
   * Bun 1.3.14's YAML parser rejects an empty folded scalar (`>-` with no
   * text) followed by a less indented key, which the suite has once
   * (`ip6-bad1`): read it as an empty string.
   */
  const source = (await Bun.file(path).text()).replace(
    /^(\s+description:) >-\n(?=\s+spec:)/gm,
    '$1 ""\n',
  );
  const cases: SpfTestCase[] = [];
  const ids = new Set<string>();
  for (const part of source.split(/^---\s*$/m)) {
    const doc = Bun.YAML.parse(part);
    if (!isObject(doc) || !isObject(doc.tests)) continue;
    const zone = parseZone(doc.zonedata);
    for (const [id, test] of Object.entries(doc.tests)) {
      if (!isObject(test)) throw new Error(`bad test ${id}`);
      if (ids.has(id)) throw new Error(`duplicate test name ${id} in ${path}`);
      ids.add(id);
      const expected = Array.isArray(test.result) ? test.result : [test.result];
      cases.push({
        id,
        spec: text(test.spec),
        helo: text(test.helo),
        host: text(test.host),
        mailfrom: text(test.mailfrom),
        expected: expected.filter(isResult),
        zone,
      });
    }
  }
  return cases;
}

/**
 * The `check_host()` arguments of a test: the MAIL FROM domain, or the
 * HELO name (with `postmaster@<helo>`) when MAIL FROM is empty.
 */
export function checkHostInput(test: SpfTestCase): SpfCheckInput {
  if (!test.mailfrom) {
    return {
      ip: test.host,
      domain: test.helo,
      sender: `postmaster@${test.helo}`,
      helo: test.helo,
    };
  }
  const at = test.mailfrom.lastIndexOf("@");
  return {
    ip: test.host,
    domain: at >= 0 ? test.mailfrom.slice(at + 1) : test.mailfrom,
    sender: test.mailfrom,
    helo: test.helo,
  };
}

/** A DNS error the way `dns/promises` reports one. */
function dnsError(code: string, name: string): Error {
  return Object.assign(new Error(`${code} ${name}`), { code });
}

type RecordType = "TXT" | "A" | "AAAA" | "MX" | "PTR";

/** The entries of `type` at `name`, following CNAMEs. */
function lookup(zone: Zone, name: string, type: RecordType, depth = 0): ZoneEntry[] {
  const key = name
    .split(".")
    .filter((label) => label !== "")
    .join(".")
    .toLowerCase();
  const entries = zone.get(key);
  if (!entries) throw dnsError("ENOTFOUND", name);
  const cname = entries.find((entry) => entry !== "TIMEOUT" && entry.type === "CNAME");
  if (cname !== undefined && cname !== "TIMEOUT" && cname.type === "CNAME") {
    if (depth >= 8) throw dnsError("ESERVFAIL", name);
    return lookup(zone, cname.value, type, depth + 1);
  }
  const found: ZoneEntry[] = [];
  for (const entry of entries) {
    if (entry === "TIMEOUT") {
      if (found.length === 0) throw dnsError("ETIMEOUT", name);
      break;
    }
    if (entry.type === type) found.push(entry);
  }
  if (found.length === 0) throw dnsError("ENOTFOUND", name);
  return found;
}

/** The string values of `type` at `name`. */
function stringValues(zone: Zone, name: string, type: "A" | "AAAA" | "PTR"): string[] {
  return lookup(zone, name, type).flatMap((entry) =>
    entry !== "TIMEOUT" && entry.type === type ? [entry.value] : [],
  );
}

/** A resolver answering from `zone`, asynchronously like the real one. */
export function zoneResolver(zone: Zone): SpfDnsResolver {
  return {
    resolveTxt: async (name) =>
      lookup(zone, name, "TXT").flatMap((entry) =>
        entry !== "TIMEOUT" && entry.type === "TXT" ? [entry.value] : [],
      ),
    resolve4: async (name) => stringValues(zone, name, "A"),
    resolve6: async (name) => stringValues(zone, name, "AAAA"),
    resolveMx: async (name) =>
      lookup(zone, name, "MX").flatMap((entry) =>
        entry !== "TIMEOUT" && entry.type === "MX" ? [entry.value] : [],
      ),
    resolvePtr: async (name) => stringValues(zone, name, "PTR"),
  };
}
