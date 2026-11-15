import { isIP } from "net";
import { readAppEnv } from "./app.ts";
import { optionalBoundedInt, optionalEnv } from "./env.ts";
import { readMailHostname } from "./mail.ts";

/**
 * Inbound MTA-STS (RFC 8461, #472): the policy BunMail serves at
 * `https://mta-sts.<domain>/.well-known/mta-sts.txt` for the verified
 * domains an admin opts in. These settings are the same for every domain;
 * the mode (`none`, `testing`, `enforce`) is per domain, in the database.
 */

/** `max_age` of a `testing` policy when `MTA_STS_MAX_AGE` is unset: one day. */
export const DEFAULT_MTA_STS_TESTING_MAX_AGE = 86_400;

/** `max_age` of an `enforce` policy when `MTA_STS_MAX_AGE` is unset: one week. */
export const DEFAULT_MTA_STS_ENFORCE_MAX_AGE = 604_800;

/**
 * Bounds of `MTA_STS_MAX_AGE`, in seconds. The upper one is RFC 8461's
 * (section 3.2: 31557600, about a year). The RFC sets no lower one; a day
 * is the floor here, since a policy that expires within hours protects
 * little and costs every sender a fetch each time.
 */
export const MIN_MTA_STS_MAX_AGE = 86_400;
export const MAX_MTA_STS_MAX_AGE = 31_557_600;

/** A DNS label: letters, digits and inner hyphens, at most 63 characters. */
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";

/** A host name of two labels or more, optionally `*.` in front (RFC 8461 3.2). */
const MX_PATTERN_RE = new RegExp(`^(?:\\*\\.)?${LABEL}(?:\\.${LABEL})+$`);

/**
 * Reads `MTA_STS_MX` (#472): the `mx` lines of the served policy, the host
 * names senders may deliver this server's domains' mail to, as a comma
 * list. Each is a host name, or `*.` and a host name (one leftmost label,
 * RFC 8461 4.1); lowercased, a final dot dropped, duplicates removed.
 * Unset or blank: `fallback` (`MAIL_HOSTNAME`). An IP address, an empty
 * item or anything else that is not a host name refuses to boot.
 * Exported for tests.
 */
export function readMtaStsMx(
  fallback: string,
  raw: string = optionalEnv("MTA_STS_MX", ""),
): string[] {
  const value = raw.trim();
  if (value === "") return [fallback.trim().toLowerCase().replace(/\.$/, "")];
  const hosts: string[] = [];
  for (const item of value.split(",")) {
    const host = item.trim().toLowerCase().replace(/\.$/, "");
    if (host.length > 253 || !MX_PATTERN_RE.test(host) || isIP(host) !== 0) {
      throw new Error(
        `[config] MTA_STS_MX must be a comma list of MX host names, got "${raw}".\n` +
          "  → e.g. MTA_STS_MX=mail.yourcompany.com or mx1.yourcompany.com,mx2.yourcompany.com\n" +
          "    (a leading *. matches one label). Unset, it is MAIL_HOSTNAME.",
      );
    }
    if (!hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

/**
 * Reads `MTA_STS_MAX_AGE` (#472): the served policy's `max_age` in
 * seconds, for both modes. Unset or blank: `null`, meaning one day for
 * `testing` and one week for `enforce`. A whole number outside
 * {@link MIN_MTA_STS_MAX_AGE} to {@link MAX_MTA_STS_MAX_AGE} refuses to
 * boot. Exported for tests.
 */
export function readMtaStsMaxAge(
  raw: string | undefined = process.env["MTA_STS_MAX_AGE"],
): number | null {
  if ((raw?.trim() ?? "") === "") return null;
  return optionalBoundedInt(
    "MTA_STS_MAX_AGE",
    0,
    MIN_MTA_STS_MAX_AGE,
    MAX_MTA_STS_MAX_AGE,
    raw,
  );
}

/** The `config.mtaSts` section. */
export interface MtaStsConfig {
  /** `MTA_STS_MX`: the policy's `mx` patterns, at least one. */
  mx: string[];
  /** `MTA_STS_MAX_AGE`: the policy's `max_age`; `null` for the per-mode default. */
  maxAgeSeconds: number | null;
}

/** The served MTA-STS policy's settings (#472). */
export function buildMtaStsConfig(): MtaStsConfig {
  return {
    mx: readMtaStsMx(readMailHostname(readAppEnv())),
    maxAgeSeconds: readMtaStsMaxAge(),
  };
}
