import { resolve4 } from "dns/promises";
import { isIP } from "net";
import { logger } from "../../../utils/logger.ts";
import { isBlockedIp } from "../../../utils/ssrf-guard.ts";

/**
 * DNSBL lookups for the inbound SMTP receiver.
 *
 * Kept apart from `smtp-receiver.service.ts` so the skip decision is a
 * pure function that unit-tests without a database, DNS, or `mock.module`.
 */

/**
 * Builds the DNSBL query name for a connecting client, or returns `null`
 * when the address should not be looked up.
 *
 * Skipped:
 * - anything not publicly routable (private, loopback, link-local, CGNAT,
 *   reserved). These are never listed, and the check reuses the numeric
 *   range logic of the webhook SSRF guard rather than string prefixes
 *   (#166: a `startsWith("172.")` check used to skip all of 172.0.0.0/8,
 *   not just RFC 1918's 172.16.0.0/12);
 * - public IPv6, which most DNSBL zones don't index;
 * - anything that isn't a valid IP.
 *
 * @param ip   - The client IP as reported by smtp-server
 * @param zone - The DNSBL zone to query (e.g. "zen.spamhaus.org")
 * @returns The reversed-octet query name (e.g. "4.3.2.1.zen.spamhaus.org"), or null to skip
 */
export function dnsblQueryName(ip: string, zone: string): string | null {
  /** smtp-server already strips the IPv4-mapped prefix; normalise defensively anyway. */
  const addr = ip.replace(/^::ffff:/i, "");

  /** Private / loopback / link-local / CGNAT / reserved, or not an IP at all */
  if (isBlockedIp(addr)) return null;

  /** Public IPv6: not indexed by most DNSBLs */
  if (isIP(addr) !== 4) return null;

  return `${addr.split(".").toReversed().join(".")}.${zone}`;
}

/**
 * Checks if an IP address is listed on a DNSBL (DNS-based blacklist).
 *
 * Queries the DNSBL zone by reversing the IP octets and appending the zone,
 * e.g. 1.2.3.4 → 4.3.2.1.zen.spamhaus.org. If the query returns an A record,
 * the IP is listed. NOTFOUND / NODATA means the IP is clean. Any other
 * failure (timeout, SERVFAIL, refused) means the check did not run: the
 * connection is still allowed (fail open), with a warning so the gap
 * shows in the logs.
 *
 * @param ip     - The connecting client's IP address
 * @param zone   - The DNSBL zone to query (e.g. "zen.spamhaus.org")
 * @param lookup - The A-record lookup (`resolve4`); injectable for tests
 * @returns true if the IP is blacklisted
 */
export async function isBlacklistedIp(
  ip: string,
  zone: string,
  lookup: (hostname: string) => Promise<string[]> = resolve4,
): Promise<boolean> {
  const query = dnsblQueryName(ip, zone);
  if (query === null) return false;

  try {
    const results = await lookup(query);
    return results.length > 0;
  } catch (error: unknown) {
    const code: unknown =
      typeof error === "object" && error !== null
        ? Reflect.get(error, "code")
        : undefined;
    /** No such record: the IP is not listed. */
    if (code === "ENOTFOUND" || code === "ENODATA") return false;
    logger.warn("DNSBL lookup failed: connection allowed unchecked", {
      ip,
      zone,
      code: typeof code === "string" ? code : "unknown",
    });
    return false;
  }
}
