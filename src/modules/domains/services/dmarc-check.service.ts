import { logger } from "../../../utils/logger.ts";
import type {
  DmarcAlignment,
  DmarcCheck,
  DmarcPolicy,
  ParsedDmarcRecord,
} from "../types/domain.types.ts";

/**
 * DMARC record discovery and parsing (#250), RFC 7489 6.3 and 6.6.3.
 *
 * A TXT record at `_dmarc.<domain>` counts only when its joined chunks
 * start with `v=DMARC1` (whitespace around `=` allowed, any case). Exactly
 * one must exist: none means no policy, two or more mean receivers apply
 * none. When the domain has none, the organizational domain's record
 * applies, with its `sp=` (subdomain policy) when set.
 *
 * The organizational domain comes from a heuristic, not the Public Suffix
 * List (no dependency): the last two labels, or the last three when the
 * second-to-last is a common second-level label (`co`, `com`, `net`,
 * `org`, `gov`, `ac`, `edu`, `ne`, `or`, `mil`) under a two-letter
 * country TLD (`example.co.uk`, `example.com.au`). It is wrong for other
 * public suffixes, such as `example.pvt.k12.ma.us` or hosting suffixes like
 * `github.io`: there the fallback queries a name above the real
 * organizational domain, which normally has no record, so the check
 * reports `missing` rather than a wrong policy.
 */

/** A DMARC record: `v=DMARC1` first, then `;` or the end. */
export const DMARC_RECORD = /^v\s*=\s*DMARC1\s*(;|$)/i;

/**
 * Longest a DMARC check may take before it counts as an error (same as
 * #236's lookup timeout). The organizational-domain fallback runs after
 * the domain's own lookup and shares this one budget, so a check never
 * takes longer than one timeout.
 */
const DMARC_LOOKUP_TIMEOUT_MS = 5_000;

/** DNS answers meaning "no such record", as opposed to a failed lookup. */
const NO_RECORD_CODES = new Set(["ENOTFOUND", "ENODATA"]);

/** Second-level labels under a two-letter TLD that are public suffixes in practice. */
const COMMON_SECOND_LEVEL = new Set([
  "co",
  "com",
  "net",
  "org",
  "gov",
  "ac",
  "edu",
  "ne",
  "or",
  "mil",
]);

const POLICIES: ReadonlySet<string> = new Set(["none", "quarantine", "reject"]);

/** A `rua` URI: `mailto:` with one `@`, and an optional `!size` limit. */
const RUA_MAILTO = /^mailto:[^\s@,;!]+@[^\s@,;!]+(![0-9]+[kmgt]?)?$/i;

/** Longest DNS-sourced value quoted in a problem message. */
const QUOTE_MAX = 64;

/** The DNS lookup, injectable for tests. */
export interface DmarcLookupDeps {
  resolveTxt: (hostname: string) => Promise<string[][]>;
  /** Budget for the whole check: the domain's lookup and the fallback share it. */
  timeoutMs: number;
}

/** Lowercased, without a trailing dot. */
function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "");
}

/** A DNS-sourced value, shortened for messages. */
function quote(value: string): string {
  return value.length > QUOTE_MAX ? `${value.slice(0, QUOTE_MAX)}...` : value;
}

function isPolicy(value: string): value is DmarcPolicy {
  return POLICIES.has(value);
}

function isAlignment(value: string): value is DmarcAlignment {
  return value === "r" || value === "s";
}

/**
 * The organizational domain of `domain`, by the heuristic described above:
 * `mail.example.com` gives `example.com`, `mail.example.co.uk` gives
 * `example.co.uk`.
 */
export function organizationalDomain(domain: string): string {
  const labels = normalizeName(domain).split(".");
  const tld = labels.at(-1) ?? "";
  const second = labels.at(-2) ?? "";
  const keep = tld.length === 2 && COMMON_SECOND_LEVEL.has(second) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

/**
 * Parses one DMARC record (its chunks already joined) strictly: tag names
 * and policy values are case-insensitive, unknown tags are ignored, and an
 * invalid value is reported in `problems` and replaced by the default
 * (RFC 7489 6.3). A missing or invalid `p=` leaves `policy` null.
 */
export function parseDmarcRecord(record: string): ParsedDmarcRecord {
  const parsed: ParsedDmarcRecord = {
    policy: null,
    subdomainPolicy: null,
    pct: 100,
    adkim: "r",
    aspf: "r",
    rua: [],
    problems: [],
  };
  const seen = new Set<string>();
  /** The first segment is `v=DMARC1` (checked by the caller). */
  for (const segment of record.split(";").slice(1)) {
    const part = segment.trim();
    if (part === "") continue;
    const eq = part.indexOf("=");
    if (eq < 0) {
      parsed.problems.push(`"${quote(part)}" is not a tag=value pair: ignored`);
      continue;
    }
    const tag = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim();
    if (!["p", "sp", "pct", "adkim", "aspf", "rua"].includes(tag)) continue;
    if (seen.has(tag)) {
      parsed.problems.push(`${tag}= appears more than once: the first is used`);
      continue;
    }
    seen.add(tag);
    const lower = value.toLowerCase();
    switch (tag) {
      case "p":
        if (isPolicy(lower)) parsed.policy = lower;
        else parsed.problems.push(`p=${quote(value)} is not none, quarantine or reject`);
        break;
      case "sp":
        if (isPolicy(lower)) parsed.subdomainPolicy = lower;
        else
          parsed.problems.push(
            `sp=${quote(value)} is not none, quarantine or reject: ignored`,
          );
        break;
      case "pct": {
        const pct = /^\d{1,3}$/.test(value) ? Number(value) : Number.NaN;
        if (pct >= 0 && pct <= 100) parsed.pct = pct;
        else
          parsed.problems.push(
            `pct=${quote(value)} is not an integer from 0 to 100: 100 applies`,
          );
        break;
      }
      case "adkim":
        if (isAlignment(lower)) parsed.adkim = lower;
        else parsed.problems.push(`adkim=${quote(value)} is not r or s: r applies`);
        break;
      case "aspf":
        if (isAlignment(lower)) parsed.aspf = lower;
        else parsed.problems.push(`aspf=${quote(value)} is not r or s: r applies`);
        break;
      case "rua":
        for (const raw of value.split(",")) {
          const uri = raw.trim();
          if (uri === "") continue;
          if (RUA_MAILTO.test(uri)) parsed.rua.push(uri);
          else parsed.problems.push(`rua URI ${quote(uri)} is not a mailto: address`);
        }
        break;
    }
  }
  return parsed;
}

/** The DMARC records at one name, or the error code of a failed lookup. */
type LookupResult = { records: string[] } | { errorCode: string };

/** One TXT lookup with a timeout, keeping only DMARC records. Never rejects. */
async function lookupDmarcRecords(
  host: string,
  deps: DmarcLookupDeps,
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
      .filter((record) => DMARC_RECORD.test(record));
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

/** A check without a usable record. */
function noRecord(status: DmarcCheck["status"], reason: string): DmarcCheck {
  return {
    status,
    ok: false,
    reason,
    warnings: [],
    problems: [],
    recordDomain: null,
    inherited: false,
    policy: null,
    subdomainPolicy: null,
    effectivePolicy: null,
    pct: null,
    adkim: null,
    aspf: null,
    rua: [],
  };
}

/** Evaluates the single record found at `_dmarc.<recordDomain>`. */
function evaluate(
  record: string,
  domain: string,
  recordDomain: string,
  inherited: boolean,
): DmarcCheck {
  const parsed = parseDmarcRecord(record);
  const effectivePolicy =
    inherited && parsed.subdomainPolicy !== null ? parsed.subdomainPolicy : parsed.policy;
  const base = {
    problems: parsed.problems,
    recordDomain,
    inherited,
    policy: parsed.policy,
    subdomainPolicy: parsed.subdomainPolicy,
    effectivePolicy,
    pct: parsed.pct,
    adkim: parsed.adkim,
    aspf: parsed.aspf,
    rua: parsed.rua,
  };
  if (parsed.policy === null) {
    return {
      ...base,
      /** No valid `p=`: no policy applies. */
      effectivePolicy: null,
      status: "invalid",
      ok: false,
      reason: `The DMARC record at _dmarc.${recordDomain} has no valid p= tag (none, quarantine or reject)`,
      warnings: [],
    };
  }
  const warnings: string[] = [];
  if (effectivePolicy === "none") {
    warnings.push(
      `${inherited && parsed.subdomainPolicy !== null ? "sp" : "p"}=none only monitors: receivers deliver failing mail as usual. Move to quarantine, then reject, once reports show your mail passes`,
    );
  } else if (parsed.pct < 100) {
    warnings.push(
      `pct=${parsed.pct}: the ${effectivePolicy ?? ""} policy applies to ${parsed.pct}% of failing mail only`,
    );
  }
  if (parsed.rua.length === 0) {
    warnings.push("No rua= address: receivers send no aggregate reports");
  }
  return {
    ...base,
    status: "pass",
    ok: true,
    reason: inherited
      ? `No record at _dmarc.${domain}: the organizational domain's record at _dmarc.${recordDomain} applies (policy ${effectivePolicy ?? ""})`
      : `DMARC policy ${effectivePolicy ?? ""} at _dmarc.${domain}`,
    warnings,
  };
}

/** Logs the outcome briefly (no TXT values) and returns it. */
function logged(domain: string, check: DmarcCheck, recordCount: number): DmarcCheck {
  logger.debug("DMARC check", {
    domain,
    status: check.status,
    recordCount,
    inherited: check.inherited,
  });
  return check;
}

/**
 * Checks the DMARC record of `domain` (#250): exactly one `v=DMARC1` record
 * at `_dmarc.<domain>`, else at the organizational domain, with a valid
 * `p=`. Never rejects: a failed lookup, or one past the shared budget,
 * gives `error`.
 */
export async function checkDmarc(
  domain: string,
  deps: Partial<DmarcLookupDeps> & Pick<DmarcLookupDeps, "resolveTxt">,
): Promise<DmarcCheck> {
  const lookupDeps: DmarcLookupDeps = {
    timeoutMs: DMARC_LOOKUP_TIMEOUT_MS,
    ...deps,
  };
  const name = normalizeName(domain);
  const org = organizationalDomain(name);
  const deadline = Date.now() + lookupDeps.timeoutMs;

  for (const recordDomain of org === name ? [name] : [name, org]) {
    const inherited = recordDomain !== name;
    /** What is left of the budget: the fallback gets only the remainder. */
    const result = await lookupDmarcRecords(`_dmarc.${recordDomain}`, {
      ...lookupDeps,
      timeoutMs: Math.max(0, deadline - Date.now()),
    });
    if ("errorCode" in result) {
      logger.warn("DMARC lookup failed", {
        domain: name,
        host: `_dmarc.${recordDomain}`,
        code: result.errorCode,
      });
      return logged(
        name,
        noRecord(
          "error",
          `DNS lookup of _dmarc.${recordDomain} failed (${result.errorCode}): try again later`,
        ),
        0,
      );
    }
    const count = result.records.length;
    if (count > 1) {
      return logged(
        name,
        {
          ...noRecord(
            "multiple",
            `${count} DMARC records at _dmarc.${recordDomain}: publish exactly one (receivers ignore them all)`,
          ),
          recordDomain,
          inherited,
        },
        count,
      );
    }
    const [record] = result.records;
    if (record !== undefined) {
      return logged(name, evaluate(record, name, recordDomain, inherited), 1);
    }
  }

  return logged(
    name,
    noRecord(
      "missing",
      org === name
        ? `No DMARC record at _dmarc.${name}`
        : `No DMARC record at _dmarc.${name} or _dmarc.${org}`,
    ),
    0,
  );
}
