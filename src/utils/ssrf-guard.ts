import { lookup } from "dns/promises";
import { isIP } from "net";

/**
 * SSRF guard for outbound webhook delivery (#128).
 *
 * Webhook URLs are tenant-supplied and fetched server-side, and the
 * response is read back through the API — so an unvalidated URL is a
 * classic exfiltrating SSRF (cloud metadata at 169.254.169.254, internal
 * services on 127/10/172.16/192.168, etc.). This module validates a URL's
 * scheme and resolves its host, rejecting any that maps to a
 * private/loopback/link-local/ULA/metadata address.
 *
 * Config-free by design (the caller passes `allowHttp`) so it unit-tests
 * with no environment and no `mock.module`.
 */

/** Thrown when a URL is refused by the guard. Callers map it to 4xx / a failed delivery. */
export class BlockedUrlError extends Error {
  override readonly name = "BlockedUrlError";
  constructor(message: string) {
    super(message);
  }
}

/* ─── IP range checks ─── */

/** Parses a dotted-quad IPv4 string to a uint32, or null if malformed. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const o = Number(p);
    if (o > 255) return null;
    n = (n << 8) | o;
  }
  return n >>> 0;
}

/** True if an IPv4 address is in a private / loopback / link-local / reserved range. */
function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparseable → refuse
  const inRange = (base: string, bits: number): boolean => {
    const b = ipv4ToInt(base)!;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) === (b & mask);
  };
  return (
    inRange("0.0.0.0", 8) || // "this host"
    inRange("10.0.0.0", 8) || // private
    inRange("100.64.0.0", 10) || // CGNAT
    inRange("127.0.0.0", 8) || // loopback
    inRange("169.254.0.0", 16) || // link-local (incl. 169.254.169.254 cloud metadata)
    inRange("172.16.0.0", 12) || // private
    inRange("192.0.0.0", 24) || // IETF protocol assignments
    inRange("192.168.0.0", 16) || // private
    inRange("198.18.0.0", 15) || // benchmarking
    inRange("224.0.0.0", 4) || // multicast
    inRange("240.0.0.0", 4) // reserved / broadcast
  );
}

/** True if an IPv6 address is loopback / unspecified / ULA / link-local (or a blocked v4-mapped addr). */
function isBlockedIpv6(ip: string): boolean {
  const addr = ip.toLowerCase().split("%")[0]!; // strip zone id
  if (addr === "::1" || addr === "::") return true;
  // IPv4-mapped (::ffff:1.2.3.4) or v4-in-v6 — extract the embedded v4.
  const v4 = addr.match(/(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (v4) return isBlockedIpv4(v4[1]!);
  const first = parseInt(addr.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

/** True if the resolved IP is one webhook delivery must never connect to. */
export function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isBlockedIpv4(ip);
  if (v === 6) return isBlockedIpv6(ip);
  return true; // not a valid IP → refuse
}

/* ─── URL validation ─── */

/**
 * Validates a webhook URL and throws {@link BlockedUrlError} if it must not
 * be fetched. Checks the scheme, then **resolves the host via DNS** and
 * rejects if *any* resolved address is private/loopback/link-local/etc. —
 * so a public hostname that resolves (or later re-resolves, TOCTOU) to an
 * internal IP is caught too.
 *
 * @param rawUrl   The URL to validate.
 * @param allowHttp Permit `http:` in addition to `https:` (operator opt-in).
 */
export async function assertPublicWebhookUrl(
  rawUrl: string,
  allowHttp = false,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError("Webhook URL is not a valid absolute URL.");
  }

  const scheme = url.protocol.toLowerCase();
  if (scheme !== "https:" && !(allowHttp && scheme === "http:")) {
    throw new BlockedUrlError(
      allowHttp
        ? "Webhook URL must use http or https."
        : "Webhook URL must use https (set WEBHOOK_ALLOW_INSECURE_HTTP=true to allow http).",
    );
  }

  const host = url.hostname;
  if (!host) throw new BlockedUrlError("Webhook URL has no host.");

  /** If the host is a literal IP, check it directly (no DNS). */
  if (isIP(host)) {
    if (isBlockedIp(host)) {
      throw new BlockedUrlError(
        `Webhook URL host ${host} is a private/reserved address.`,
      );
    }
    return;
  }

  /** Resolve every A/AAAA record and reject if ANY is blocked. */
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new BlockedUrlError(`Webhook URL host "${host}" could not be resolved.`);
  }
  if (addresses.length === 0) {
    throw new BlockedUrlError(`Webhook URL host "${host}" resolved to no addresses.`);
  }
  for (const { address } of addresses) {
    if (isBlockedIp(address)) {
      throw new BlockedUrlError(
        `Webhook URL host "${host}" resolves to a private/reserved address (${address}).`,
      );
    }
  }
}
