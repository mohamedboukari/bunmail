import { lookup } from "dns/promises";
import { isIP } from "net";

/**
 * SSRF guard for outbound webhook delivery (#128).
 *
 * Webhook URLs are tenant-supplied and fetched server-side, and the
 * response is read back through the API, so an unvalidated URL is a
 * classic exfiltrating SSRF (cloud metadata at 169.254.169.254, internal
 * services on 127/10/172.16/192.168, etc.). This module validates a URL's
 * scheme and resolves its host, rejecting any that maps to a
 * private/loopback/link-local/ULA/metadata address.
 *
 * The host is resolved ONCE per attempt ({@link resolvePublicWebhookTarget})
 * and the request is then sent to that checked address
 * ({@link buildPinnedRequest}), never to the name: a second, independent
 * resolution by `fetch` could return a different answer than the one that
 * was checked.
 *
 * Config-free by design (the caller passes `allowHttp`) so it unit-tests
 * with no environment and no `mock.module`.
 */

/** Thrown when a URL is refused by the guard. Callers map it to 4xx / a failed delivery. */
export class BlockedUrlError extends Error {
  override readonly name = "BlockedUrlError";
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

/** Formats a uint32 as a dotted-quad IPv4 string. */
function intToIpv4(n: number): string {
  return [n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
}

/**
 * Parses an IPv6 string (zone id stripped, `::` compression and a trailing
 * dotted quad allowed) into its eight 16-bit groups, or null if malformed.
 */
function parseIpv6(ip: string): number[] | null {
  let addr = ip.toLowerCase().split("%")[0] ?? "";
  /** A trailing dotted quad (`::ffff:1.2.3.4`) becomes two hex groups. */
  const dotted = addr.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const n = ipv4ToInt(dotted[2] ?? "");
    if (n === null) return null;
    addr = `${dotted[1] ?? ""}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (part: string): number[] =>
    part === ""
      ? []
      : part.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  const head = parseGroups(halves[0] ?? "");
  const tail = halves.length === 2 ? parseGroups(halves[1] ?? "") : [];
  if ([...head, ...tail].some((g) => Number.isNaN(g))) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...Array.from({ length: fill }, () => 0), ...tail];
}

/**
 * The IPv4 address embedded in an IPv6 address that reaches it, or null.
 * Covers every textual form (dotted `::ffff:127.0.0.1` and hex groups
 * `::ffff:7f00:1` parse to the same groups):
 * - IPv4-mapped `::ffff:0:0/96`
 * - IPv4-compatible `::/96` (deprecated, includes `::` and `::1`)
 * - NAT64 well-known prefix `64:ff9b::/96` (RFC 6052)
 * - 6to4 `2002::/16` (RFC 3056): `2002:AABB:CCDD::` carries `AA.BB.CC.DD`
 */
function embeddedIpv4(groups: number[]): string | null {
  const g = (i: number): number => groups[i] ?? 0;
  const v4 = (): string => intToIpv4(((g(6) << 16) | g(7)) >>> 0);
  const zeroUpTo = (end: number, start = 0): boolean => {
    for (let i = start; i < end; i++) if (g(i) !== 0) return false;
    return true;
  };
  if (zeroUpTo(5) && g(5) === 0xffff) return v4(); // ::ffff:a.b.c.d
  if (zeroUpTo(6)) return v4(); // ::a.b.c.d
  if (g(0) === 0x64 && g(1) === 0xff9b && zeroUpTo(6, 2)) return v4(); // 64:ff9b::a.b.c.d
  if (g(0) === 0x2002) return intToIpv4(((g(1) << 16) | g(2)) >>> 0); // 2002:aabb:ccdd::
  return null;
}

/**
 * True if an IPv6 address is loopback / unspecified / ULA / link-local /
 * site-local / multicast / local-use NAT64, or embeds a blocked IPv4.
 *
 * Teredo (`2001::/32`) is not unpacked: reaching one needs a Teredo
 * interface on this host, which server deployments do not have, and the
 * IPv4 it carries is the public address of the client's NAT.
 */
function isBlockedIpv6(ip: string): boolean {
  const groups = parseIpv6(ip);
  if (groups === null) return true; // unparseable → refuse
  const first = groups[0] ?? 0;
  if (groups.every((x) => x === 0)) return true; // :: unspecified
  if (first === 0 && groups.slice(1, 7).every((x) => x === 0) && groups[7] === 1) {
    return true; // ::1 loopback
  }
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  /**
   * 64:ff9b:1::/48 local-use NAT64 (RFC 8215): blocked outright rather
   * than judged by an embedded IPv4. Where the IPv4 sits depends on the
   * prefix length the local operator chose, so it cannot be read reliably,
   * and it only ever leads into a local translator.
   */
  if (first === 0x64 && groups[1] === 0xff9b && groups[2] === 1) return true;
  /** IPv4 reachable through this address: judged by the IPv4 rules. */
  const v4 = embeddedIpv4(groups);
  if (v4 !== null) return isBlockedIpv4(v4);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

/**
 * True if the IP is not publicly routable (private / loopback / link-local /
 * CGNAT / reserved), or not a valid IP at all.
 *
 * Shared by webhook delivery (never connect to these) and the inbound
 * DNSBL check (never look these up; see `dnsbl.service.ts`). Changing a
 * range here affects both.
 */
export function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isBlockedIpv4(ip);
  if (v === 6) return isBlockedIpv6(ip);
  return true; // not a valid IP → refuse
}

/* ─── URL validation ─── */

/** A DNS lookup returning every address for a host (injectable for tests). */
export type ResolveAll = (host: string) => Promise<{ address: string }[]>;

const lookupAll: ResolveAll = (host) => lookup(host, { all: true });

/** A webhook URL that passed the guard, with the one address to connect to. */
export interface PublicWebhookTarget {
  /** The parsed URL, unchanged (scheme, host, port, path, query). */
  url: URL;
  /** The URL's host name without IPv6 brackets: the TLS name and Host header. */
  hostname: string;
  /** True when the URL's host is an IP literal (no DNS was used). */
  isIpLiteral: boolean;
  /** The validated address the request must be sent to. */
  address: string;
  /** IP family of {@link address}. */
  family: 4 | 6;
}

/**
 * Validates a webhook URL and resolves its host ONCE, returning the
 * address to connect to. Checks the scheme, then **resolves the host via
 * DNS** and rejects if *any* resolved address is private/loopback/
 * link-local/etc. (an IP-literal host is checked directly, no DNS).
 *
 * The returned address is the one the request must use
 * ({@link buildPinnedRequest}): connecting by name would resolve again,
 * and that second answer was never checked.
 *
 * @param rawUrl    The URL to validate.
 * @param allowHttp Permit `http:` in addition to `https:` (operator opt-in).
 * @param resolver  DNS lookup returning every address, injectable for tests.
 * @returns The parsed URL, its host name and one validated address (IPv4
 *   preferred, as for MX delivery: an IPv6 route is not always available).
 * @throws BlockedUrlError if the URL must not be fetched.
 */
export async function resolvePublicWebhookTarget(
  rawUrl: string,
  allowHttp = false,
  resolver: ResolveAll = lookupAll,
): Promise<PublicWebhookTarget> {
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

  /** `URL.hostname` keeps the brackets of an IPv6 literal; strip them. */
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (!host) throw new BlockedUrlError("Webhook URL has no host.");

  /** If the host is a literal IP, check it directly (no DNS). */
  if (isIP(host)) {
    if (isBlockedIp(host)) {
      throw new BlockedUrlError(
        `Webhook URL host ${host} is a private/reserved address.`,
      );
    }
    return {
      url,
      hostname: host,
      isIpLiteral: true,
      address: host,
      family: familyOf(host),
    };
  }

  /** Resolve every A/AAAA record and reject if ANY is blocked. */
  let addresses: { address: string }[];
  try {
    addresses = await resolver(host);
  } catch {
    throw new BlockedUrlError(`Webhook URL host "${host}" could not be resolved.`);
  }
  if (addresses.length === 0) {
    throw new BlockedUrlError(`Webhook URL host "${host}" resolved to no addresses.`);
  }
  /**
   * A scoped address (zone id, `fe80::1%eth0`) names a local interface and
   * is never a public receiver, so it is refused like a private one.
   * Deliberately no address in the message: it is returned to the caller
   * and stored as the delivery's `lastError`.
   */
  if (addresses.some(({ address }) => address.includes("%") || isBlockedIp(address))) {
    throw new BlockedUrlError(
      `Webhook URL host "${host}" resolves to a private/reserved address.`,
    );
  }
  const chosen = addresses.find(({ address }) => isIP(address) === 4) ?? addresses[0];
  if (!chosen) {
    throw new BlockedUrlError(`Webhook URL host "${host}" resolved to no addresses.`);
  }
  return {
    url,
    hostname: host,
    isIpLiteral: false,
    address: chosen.address,
    family: familyOf(chosen.address),
  };
}

/** IP family of an address already known to be a valid IP. */
function familyOf(address: string): 4 | 6 {
  return isIP(address) === 6 ? 6 : 4;
}

/**
 * Validates a webhook URL and throws {@link BlockedUrlError} if it must not
 * be fetched. Same checks as {@link resolvePublicWebhookTarget}, for
 * callers that only need the verdict (webhook create / update).
 *
 * @param rawUrl    The URL to validate.
 * @param allowHttp Permit `http:` in addition to `https:` (operator opt-in).
 */
export async function assertPublicWebhookUrl(
  rawUrl: string,
  allowHttp = false,
): Promise<void> {
  await resolvePublicWebhookTarget(rawUrl, allowHttp);
}

/* ─── Pinned request ─── */

/** The connection-level parts of a request pinned to a validated address. */
export interface PinnedRequest {
  /** The original URL with its host replaced by the validated address. */
  url: string;
  /** Host header value: the original host, with the port if non-default. */
  host: string;
  /**
   * TLS options for an `https` URL with a host name: the original host
   * name is sent as SNI and the certificate is verified against it, not
   * against the address. Absent for `http` and for IP-literal hosts
   * (verified against the IP as usual).
   */
  tls?: Pick<BunFetchRequestInitTLS, "serverName">;
}

/**
 * Builds the URL, Host header and TLS options that send a request to the
 * address {@link resolvePublicWebhookTarget} validated, while the receiver
 * still sees (and the certificate is still checked against) the original
 * host name. Pure: no DNS, no validation, so callers must pass a target
 * that came from the guard.
 *
 * Only `serverName` is set: Bun's fetch sends it as SNI and checks the
 * certificate's names against it during the handshake, before any byte
 * of the request is written. A custom `checkServerIdentity` is
 * deliberately NOT set: in Bun it replaces that built-in check and runs
 * only after the request has been sent.
 *
 * Fails closed: the URL host setter silently keeps the previous host when
 * it rejects a value, so the result is checked to carry exactly the
 * validated address, and anything else throws instead of falling back to
 * the original host name.
 *
 * @param target A target returned by {@link resolvePublicWebhookTarget}.
 * @returns The pinned URL, the Host header value and, for https with a
 *   host name, the TLS options.
 * @throws BlockedUrlError if the URL cannot carry the validated address.
 */
export function buildPinnedRequest(target: PublicWebhookTarget): PinnedRequest {
  const pinned = new URL(target.url.href);
  pinned.hostname = target.family === 6 ? `[${target.address}]` : target.address;
  if (!hostIsAddress(pinned.hostname, target)) {
    throw new BlockedUrlError(
      "Webhook URL could not be pinned to its validated address.",
    );
  }

  if (target.isIpLiteral || pinned.protocol !== "https:") {
    return { url: pinned.href, host: target.url.host };
  }

  return {
    url: pinned.href,
    host: target.url.host,
    /** SNI carries no trailing dot (RFC 6066). */
    tls: { serverName: target.hostname.replace(/\.$/, "") },
  };
}

/**
 * True if a URL host (`URL.hostname`) is exactly the target's validated
 * address: the same dotted quad for IPv4, the same bracketed IPv6 address
 * (compared group by group, as the URL serializer compresses it).
 */
function hostIsAddress(hostname: string, target: PublicWebhookTarget): boolean {
  if (isIP(target.address) !== target.family) return false;
  if (target.family === 4) return hostname === target.address;
  const inner = /^\[(.*)\]$/.exec(hostname)?.[1];
  if (inner === undefined || isIP(inner) !== 6) return false;
  const got = parseIpv6(inner);
  const want = parseIpv6(target.address);
  return got !== null && want !== null && got.every((group, i) => group === want[i]);
}
