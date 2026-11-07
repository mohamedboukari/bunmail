/**
 * MTA-STS records (#250, RFC 8461): the TXT record, the policy file and
 * MX matching, all pure. Part of `mta-sts.ts`, which re-exports them.
 */

/** Longest `max_age` honoured, in seconds (RFC 8461 3.2: 31557600, about a year). */
export const MTA_STS_MAX_AGE_CAP_SECONDS = 31_557_600;

/** Largest policy file read, in bytes (RFC 8461 3.3 suggests 64 KB). */
export const MTA_STS_POLICY_MAX_BYTES = 64 * 1024;

/** A policy's mode (RFC 8461 5). */
export type MtaStsMode = "enforce" | "testing" | "none";

/** A parsed MTA-STS policy. */
export interface MtaStsPolicy {
  mode: MtaStsMode;
  /** MX patterns, lowercased, without a trailing dot: `mx.example.com` or `*.example.com`. */
  mx: string[];
  /** Lifetime of the policy in seconds, capped at {@link MTA_STS_MAX_AGE_CAP_SECONDS}. */
  maxAge: number;
}

/* ─── TXT record ─── */

/** A policy `id`: 1 to 32 letters and digits (RFC 8461 3.1). */
const STS_ID_RE = /^[A-Za-z0-9]{1,32}$/;

/** An extension field name (RFC 8461 3.1, `sts-ext-name`). */
const STS_EXT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;

/** An extension field value: printable ASCII except `;` and `=`. */
const STS_EXT_VALUE_RE = /^[\x21-\x3a\x3c\x3e-\x7e]+$/;

/**
 * The policy `id` announced by the TXT records of `_mta-sts.<domain>`, or
 * `null` when none is (RFC 8461 3.1): records not starting with `v=STSv1`
 * are ignored, and anything but exactly one remaining, valid record means
 * no policy is announced. Each record is given as its strings, which are
 * joined.
 */
export function parseMtaStsTxt(records: string[][]): string | null {
  const candidates = records
    .map((chunks) => chunks.join(""))
    .filter((text) => text.startsWith("v=STSv1"));
  if (candidates.length !== 1) return null;
  const fields = (candidates[0] ?? "").split(";").map((field) => field.trim());
  if (fields[0] !== "v=STSv1") return null;
  let id: string | null = null;
  for (const [index, field] of fields.slice(1).entries()) {
    /** A trailing `;` leaves one empty field; any other empty field is malformed. */
    if (field === "") {
      if (index === fields.length - 2) continue;
      return null;
    }
    const eq = field.indexOf("=");
    if (eq <= 0) return null;
    const name = field.slice(0, eq);
    const value = field.slice(eq + 1);
    if (name === "id") {
      if (id !== null || !STS_ID_RE.test(value)) return null;
      id = value;
    } else if (!STS_EXT_NAME_RE.test(name) || !STS_EXT_VALUE_RE.test(value)) {
      return null;
    }
  }
  return id;
}

/* ─── Policy file ─── */

/** A DNS label: letters, digits and inner hyphens, at most 63 characters. */
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";

/** A host name, or one with a single leading `*.` wildcard label (RFC 8461 3.2). */
const MX_PATTERN_RE = new RegExp(`^(?:\\*\\.)?${LABEL}(?:\\.${LABEL})*$`);

/** One `key: value` line of a policy file (RFC 8461 3.2). */
const POLICY_LINE_RE = /^([A-Za-z0-9_.-]{1,32}):[ \t]*(.*?)[ \t]*$/;

/** An `mx` pattern, lowercased and without a trailing dot, or `null` when invalid. */
function mxPattern(value: string): string | null {
  const pattern = value.toLowerCase().replace(/\.$/, "");
  if (pattern.length === 0 || pattern.length > 253) return null;
  return MX_PATTERN_RE.test(pattern) ? pattern : null;
}

/**
 * Parses a policy file (RFC 8461 3.2), strictly: `version: STSv1`, `mode`
 * one of `enforce`, `testing` and `none`, `max_age` of 1 to 10 digits
 * (capped at {@link MTA_STS_MAX_AGE_CAP_SECONDS}), and at least one `mx`
 * pattern unless the mode is `none`. A required field that is missing,
 * repeated or invalid, or any invalid `mx` pattern, makes the whole policy
 * invalid: `null`. Lines end in CRLF or LF. Unknown keys and lines that are
 * not `key: value` are ignored (RFC 8461 3.2: unknown fields SHOULD be
 * ignored), so stray text never turns an enforce policy into no policy.
 * A body larger than {@link MTA_STS_POLICY_MAX_BYTES} is invalid.
 */
export function parseMtaStsPolicy(body: string): MtaStsPolicy | null {
  if (Buffer.byteLength(body, "utf8") > MTA_STS_POLICY_MAX_BYTES) return null;
  const single: Record<"version" | "mode" | "max_age", string | undefined> = {
    version: undefined,
    mode: undefined,
    max_age: undefined,
  };
  const mx: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = POLICY_LINE_RE.exec(line);
    if (!match) continue;
    const key = match[1] ?? "";
    const value = match[2] ?? "";
    if (key === "mx") {
      const pattern = mxPattern(value);
      if (pattern === null) return null;
      mx.push(pattern);
    } else if (key === "version" || key === "mode" || key === "max_age") {
      if (single[key] !== undefined) return null;
      single[key] = value;
    }
  }
  if (single.version !== "STSv1") return null;
  const mode = single.mode;
  if (mode !== "enforce" && mode !== "testing" && mode !== "none") return null;
  if (single.max_age === undefined || !/^\d{1,10}$/.test(single.max_age)) return null;
  if (mode !== "none" && mx.length === 0) return null;
  return {
    mode,
    mx: [...new Set(mx)],
    maxAge: Math.min(Number(single.max_age), MTA_STS_MAX_AGE_CAP_SECONDS),
  };
}

/* ─── MX matching ─── */

/**
 * Whether `mxHost` matches a policy pattern (RFC 8461 4.1), ignoring case
 * and a trailing dot: an exact name, or `*.example.com`, which matches
 * exactly one leftmost label (`mx1.example.com`, not `a.b.example.com` and
 * not `example.com`).
 */
export function mxMatchesPattern(mxHost: string, pattern: string): boolean {
  const host = mxHost.trim().toLowerCase().replace(/\.$/, "");
  const want = pattern.toLowerCase().replace(/\.$/, "");
  if (!want.startsWith("*.")) return host === want;
  const suffix = want.slice(1);
  if (!host.endsWith(suffix)) return false;
  const label = host.slice(0, host.length - suffix.length);
  return label.length > 0 && !label.includes(".");
}

/** The hosts, in their order, that match at least one of the policy's patterns. */
export function matchingMxHosts(hosts: string[], policy: MtaStsPolicy): string[] {
  return hosts.filter((host) =>
    policy.mx.some((pattern) => mxMatchesPattern(host, pattern)),
  );
}
