import type {
  BimiFinding,
  BimiRecordCheck,
  ParsedBimiRecord,
} from "../types/bimi.types.ts";
import type { DmarcCheck } from "../types/domain.types.ts";
import { organizationalDomain } from "./dmarc-check.service.ts";

/**
 * The BIMI record and its DMARC prerequisite (#415), after the BIMI draft
 * (draft-brand-indicators-for-message-identification).
 *
 * The record is a TXT record at `default._bimi.<domain>` whose joined
 * strings start with `v=BIMI1`, then `tag=value` pairs separated by `;`:
 * `l=` the https URL of the SVG logo, `a=` the https URL of the PEM
 * certificate (a VMC or CMC). Unknown tags are ignored. A record whose
 * `l=` and `a=` are both empty declines a logo. When the domain has no
 * record, its organizational domain's applies (the DMARC heuristic of
 * `dmarc-check.service.ts`). Exactly one record must exist.
 *
 * BIMI also needs DMARC to enforce: `p=quarantine` or `p=reject` with
 * `pct=100`, and an `sp=` that is not `none` when set.
 *
 * Pure apart from the injected lookup: no logging here, the caller logs
 * the outcome.
 */

/** The selector BunMail checks: senders do not pick one in a header. */
export const BIMI_SELECTOR = "default";

/** A BIMI record: `v=BIMI1` first, then `;` or the end. */
const BIMI_RECORD = /^v\s*=\s*BIMI1\s*(;|$)/i;

/** DNS answers meaning "no such record", as opposed to a failed lookup. */
const NO_RECORD_CODES = new Set(["ENOTFOUND", "ENODATA"]);

/** Longest DNS-sourced value quoted in a finding. */
const QUOTE_MAX = 80;

/** Longest URL accepted in `l=` or `a=`. */
const URL_MAX = 2048;

/** A DNS-sourced value, shortened for findings. */
export function quote(value: string): string {
  return value.length > QUOTE_MAX ? `${value.slice(0, QUOTE_MAX)}...` : value;
}

/** Lowercased, without a trailing dot. */
function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "");
}

/** The name of a domain's BIMI record. */
export function bimiRecordHost(domain: string): string {
  return `${BIMI_SELECTOR}._bimi.${normalizeName(domain)}`;
}

/**
 * Why a `l=` or `a=` value is not a usable URL, or null when it is: an
 * absolute `https:` URL with a host, no user name or password, at most
 * {@link URL_MAX} characters, and for `l=` no port other than 443.
 */
function urlProblem(tag: "l" | "a", value: string): string | null {
  if (value.length > URL_MAX) return `${tag}= is longer than ${URL_MAX} characters`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `${tag}=${quote(value)} is not an absolute URL`;
  }
  if (url.protocol !== "https:") return `${tag}=${quote(value)} is not an https URL`;
  if (url.hostname === "") return `${tag}=${quote(value)} has no host`;
  if (url.username !== "" || url.password !== "") {
    return `${tag}= carries a user name or password`;
  }
  /**
   * The logo is fetched: a port other than 443 (which `URL` drops) would
   * let a record probe arbitrary ports of a public host.
   */
  if (tag === "l" && url.port !== "") {
    return `l= names port ${url.port}: the logo must be served on the https port (443)`;
  }
  return null;
}

/**
 * Parses one BIMI record (its strings already joined, starting with
 * `v=BIMI1`): tag names are case-insensitive, unknown tags ignored, a
 * repeated tag or a part without `=` is a problem, and so is an `l=` or
 * `a=` that is not one https URL.
 */
export function parseBimiRecord(record: string): ParsedBimiRecord {
  const parsed: ParsedBimiRecord = { logoUrl: null, authorityUrl: null, problems: [] };
  const seen = new Set<string>();
  /** The first segment is `v=BIMI1` (checked by the caller). */
  for (const segment of record.split(";").slice(1)) {
    const part = segment.trim();
    if (part === "") continue;
    const eq = part.indexOf("=");
    if (eq < 0) {
      parsed.problems.push(`"${quote(part)}" is not a tag=value pair`);
      continue;
    }
    const tag = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim();
    if (tag !== "l" && tag !== "a") continue;
    if (seen.has(tag)) {
      parsed.problems.push(`${tag}= appears more than once`);
      continue;
    }
    seen.add(tag);
    if (value !== "") {
      /** Early drafts allowed a list in `l=`; the current one takes a single URL. */
      const problem = value.includes(",")
        ? `${tag}= must hold one URL, not a list`
        : urlProblem(tag, value);
      if (problem !== null) parsed.problems.push(problem);
    }
    if (tag === "l") parsed.logoUrl = value;
    else parsed.authorityUrl = value;
  }
  /** An empty `l=` declines; no `l=` at all names nothing, unless `a=` does. */
  if (parsed.logoUrl === null && !parsed.authorityUrl) {
    parsed.problems.push("No l= tag: the record names no logo");
  }
  return parsed;
}

/** The record lookup, injectable for tests. */
export interface BimiLookupDeps {
  resolveTxt: (hostname: string) => Promise<string[][]>;
  /** Budget for the whole lookup: the domain's and the fallback share it. */
  timeoutMs: number;
}

/** The BIMI records at one name, or the error code of a failed lookup. */
type LookupResult = { records: string[] } | { errorCode: string };

/** One TXT lookup with a timeout, keeping only BIMI records. Never rejects. */
async function lookupBimiRecords(
  host: string,
  deps: BimiLookupDeps,
): Promise<LookupResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      deps.resolveTxt(host),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Object.assign(new Error("TXT lookup timed out"), { code: "ETIMEOUT" }),
            ),
          deps.timeoutMs,
        );
      }),
    ]);
    const records = answer
      .map((chunks) => chunks.join(""))
      .filter((record) => BIMI_RECORD.test(record));
    return { records };
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null
        ? Reflect.get(error, "code")
        : undefined;
    const errorCode = typeof code === "string" ? code : "EUNKNOWN";
    if (NO_RECORD_CODES.has(errorCode)) return { records: [] };
    return { errorCode };
  } finally {
    clearTimeout(timer);
  }
}

/** The record lookup's outcome: the check and its findings. */
export interface BimiRecordLookup {
  record: BimiRecordCheck;
  findings: BimiFinding[];
}

/** A finding about the record. */
function recordFinding(severity: BimiFinding["severity"], text: string): BimiFinding {
  return { area: "record", severity, text };
}

/** Evaluates the single record found at `host`. */
function evaluateRecord(
  record: string,
  host: string,
  inherited: boolean,
): BimiRecordLookup {
  const parsed = parseBimiRecord(record);
  const base = { host, inherited, logoUrl: null, authorityUrl: null };
  const where = inherited ? `${host} (the organizational domain's record)` : host;
  if (parsed.problems.length > 0) {
    return {
      record: { ...base, status: "invalid" },
      findings: [
        recordFinding("fail", `The BIMI record at ${where} is malformed`),
        ...parsed.problems.map((problem) => recordFinding("fail", problem)),
      ],
    };
  }
  if (parsed.logoUrl === "" && !parsed.authorityUrl) {
    return {
      record: { ...base, status: "declined" },
      findings: [
        recordFinding(
          "info",
          `The BIMI record at ${where} has an empty l=: the domain declines to show a logo`,
        ),
      ],
    };
  }
  const logoUrl = parsed.logoUrl || null;
  const authorityUrl = parsed.authorityUrl || null;
  const findings = [recordFinding("pass", `One BIMI record at ${where}`)];
  findings.push(
    logoUrl === null
      ? recordFinding("info", "No l= URL: receivers take the logo from the certificate")
      : recordFinding("pass", `l= names the logo at ${quote(logoUrl)}`),
  );
  return {
    record: { ...base, status: "valid", logoUrl, authorityUrl },
    findings,
  };
}

/**
 * Looks up the BIMI record of `domain` (#415): `default._bimi.<domain>`,
 * else the organizational domain's. Never rejects: a failed lookup, or
 * one past the shared budget, gives `error`.
 */
export async function lookupBimiRecord(
  domain: string,
  deps: BimiLookupDeps,
): Promise<BimiRecordLookup> {
  const name = normalizeName(domain);
  const org = organizationalDomain(name);
  const deadline = Date.now() + deps.timeoutMs;

  for (const recordDomain of org === name ? [name] : [name, org]) {
    const host = bimiRecordHost(recordDomain);
    const inherited = recordDomain !== name;
    const result = await lookupBimiRecords(host, {
      ...deps,
      timeoutMs: Math.max(0, deadline - Date.now()),
    });
    const base = { host, inherited, logoUrl: null, authorityUrl: null };
    if ("errorCode" in result) {
      return {
        record: { ...base, status: "error" },
        findings: [
          recordFinding(
            "warn",
            `DNS lookup of ${host} failed (${result.errorCode}): try again later`,
          ),
        ],
      };
    }
    if (result.records.length > 1) {
      return {
        record: { ...base, status: "multiple" },
        findings: [
          recordFinding(
            "fail",
            `${result.records.length} BIMI records at ${host}: publish exactly one (receivers ignore them all)`,
          ),
        ],
      };
    }
    const [record] = result.records;
    if (record !== undefined) return evaluateRecord(record, host, inherited);
  }

  const host = bimiRecordHost(name);
  return {
    record: {
      host,
      inherited: false,
      logoUrl: null,
      authorityUrl: null,
      status: "missing",
    },
    findings: [
      recordFinding(
        "fail",
        org === name
          ? `No BIMI record at ${host}`
          : `No BIMI record at ${host} or ${bimiRecordHost(org)}`,
      ),
    ],
  };
}

/** Whether a part of the check passed, failed, or could not be decided. */
export type BimiPartOutcome = "pass" | "fail" | "unknown";

/** A part's outcome and findings. */
export interface BimiPart {
  outcome: BimiPartOutcome;
  findings: BimiFinding[];
}

/** A finding about the DMARC prerequisite. */
function dmarcFinding(severity: BimiFinding["severity"], text: string): BimiFinding {
  return { area: "dmarc", severity, text };
}

/** True for a policy that enforces: quarantine or reject. */
function enforces(policy: string | null): boolean {
  return policy === "quarantine" || policy === "reject";
}

/**
 * The DMARC prerequisite of BIMI (#415) from a DMARC check
 * (`checkDmarc`): one valid record, `p=quarantine` or `p=reject`,
 * `pct=100`, and `sp=` not `none` when set. A failed DMARC lookup is
 * `unknown`.
 */
export function dmarcPrerequisite(dmarc: DmarcCheck): BimiPart {
  if (dmarc.status === "error") {
    return { outcome: "unknown", findings: [dmarcFinding("warn", dmarc.reason)] };
  }
  if (!dmarc.ok) {
    return {
      outcome: "fail",
      findings: [
        dmarcFinding("fail", `${dmarc.reason}: BIMI needs a DMARC policy that enforces`),
      ],
    };
  }
  const findings: BimiFinding[] = [];
  const where = dmarc.inherited
    ? `the organizational domain's record (_dmarc.${dmarc.recordDomain ?? ""})`
    : `_dmarc.${dmarc.recordDomain ?? ""}`;
  if (enforces(dmarc.policy)) {
    findings.push(dmarcFinding("pass", `p=${dmarc.policy ?? ""} at ${where}`));
  } else {
    findings.push(
      dmarcFinding(
        "fail",
        `p=${dmarc.policy ?? ""} at ${where}: BIMI needs p=quarantine or p=reject`,
      ),
    );
  }
  if (dmarc.subdomainPolicy !== null) {
    findings.push(
      enforces(dmarc.subdomainPolicy)
        ? dmarcFinding("pass", `sp=${dmarc.subdomainPolicy}`)
        : dmarcFinding(
            "fail",
            `sp=${dmarc.subdomainPolicy}: BIMI needs sp=quarantine or sp=reject when sp is set`,
          ),
    );
  }
  if (dmarc.pct === 100) {
    findings.push(dmarcFinding("pass", "pct=100: the policy applies to all mail"));
  } else {
    findings.push(
      dmarcFinding(
        "fail",
        `pct=${dmarc.pct ?? ""}: BIMI needs the policy applied to all mail (pct=100)`,
      ),
    );
  }
  const failed = findings.some((finding) => finding.severity === "fail");
  return { outcome: failed ? "fail" : "pass", findings };
}
