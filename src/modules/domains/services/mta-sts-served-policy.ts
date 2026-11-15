import { createHash } from "crypto";
import {
  config,
  DEFAULT_MTA_STS_ENFORCE_MAX_AGE,
  DEFAULT_MTA_STS_TESTING_MAX_AGE,
} from "../../../config.ts";
import type { ServedMtaStsMode } from "../types/domain.types.ts";

/**
 * The MTA-STS policy BunMail serves for an opted-in domain (#472, RFC
 * 8461), all pure: the policy text, its `id`, the `_mta-sts` TXT value,
 * and the domain a request's `Host` asks for. The settings are passed in
 * (read from `config` by default), so the same text comes out everywhere:
 * the served file, the TXT record shown on the domain page, and Verify.
 */

/** The server settings the policy depends on: `config.mtaSts`. */
export interface MtaStsPolicySettings {
  /** `MTA_STS_MX`: the `mx` patterns, at least one. */
  mx: readonly string[];
  /** `MTA_STS_MAX_AGE`; `null` for the per-mode default. */
  maxAgeSeconds: number | null;
}

/** A policy as served: its text, `id` and `max_age`. */
export interface ServedMtaStsPolicy {
  mode: ServedMtaStsMode;
  mx: readonly string[];
  /** Seconds, also the response's `Cache-Control: max-age`. */
  maxAge: number;
  /** The policy file, CRLF line endings, as served. */
  text: string;
  /** The policy `id` of the TXT record: 32 hex digits of the text's SHA-256. */
  id: string;
}

/** The settings from `config.mtaSts`. */
function configSettings(): MtaStsPolicySettings {
  return config.mtaSts;
}

/**
 * The policy served under `mode` (RFC 8461 3.2): `version: STSv1`, the
 * mode, one `mx` line per configured pattern, and `max_age` (the
 * configured one, else one day for `testing` and one week for `enforce`),
 * each line ending in CRLF.
 *
 * The `id` (RFC 8461 3.1: 1 to 32 letters and digits) is the first 32 hex
 * digits of the text's SHA-256, so it changes whenever the policy does
 * (the mode, `MTA_STS_MX` or `MTA_STS_MAX_AGE`) and stays the same while
 * it does not, on every replica, with nothing stored. Going back to an
 * earlier policy gives back its earlier id, which RFC 8461 allows: a
 * sender only compares the id with the one it cached.
 */
export function servedMtaStsPolicy(
  mode: ServedMtaStsMode,
  settings: MtaStsPolicySettings = configSettings(),
): ServedMtaStsPolicy {
  const maxAge =
    settings.maxAgeSeconds ??
    (mode === "enforce"
      ? DEFAULT_MTA_STS_ENFORCE_MAX_AGE
      : DEFAULT_MTA_STS_TESTING_MAX_AGE);
  const lines = [
    "version: STSv1",
    `mode: ${mode}`,
    ...settings.mx.map((pattern) => `mx: ${pattern}`),
    `max_age: ${maxAge}`,
  ];
  const text = lines.map((line) => `${line}\r\n`).join("");
  const id = createHash("sha256").update(text).digest("hex").slice(0, 32);
  return { mode, mx: settings.mx, maxAge, text, id };
}

/** The `_mta-sts.<domain>` TXT value announcing `policy` (RFC 8461 3.1). */
export function mtaStsTxtValue(policy: Pick<ServedMtaStsPolicy, "id">): string {
  return `v=STSv1; id=${policy.id}`;
}

/** Where senders fetch a domain's policy (RFC 8461 3.3). */
export function mtaStsPolicyUrl(domainName: string): string {
  return `https://mta-sts.${domainName}/.well-known/mta-sts.txt`;
}

/** A DNS label: letters, digits and inner hyphens, at most 63 characters. */
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The host label senders put in front of the domain (RFC 8461 3.3). */
const POLICY_HOST_PREFIX = "mta-sts.";

/**
 * The domain a policy request is for, from its `Host` header: the name
 * after `mta-sts.`, lowercased, without a port or a final dot. `null` when
 * the header is missing, is an IP literal, does not start with `mta-sts.`,
 * or what follows is not a host name of two labels or more; such a
 * request never reaches the database.
 */
export function mtaStsDomainFromHost(host: string | null): string | null {
  if (host === null) return null;
  const name = host
    .trim()
    .toLowerCase()
    .replace(/:\d{1,5}$/, "")
    .replace(/\.$/, "");
  if (!name.startsWith(POLICY_HOST_PREFIX)) return null;
  const domain = name.slice(POLICY_HOST_PREFIX.length);
  if (domain.length === 0 || domain.length > 253) return null;
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL_RE.test(label))) return null;
  return domain;
}
