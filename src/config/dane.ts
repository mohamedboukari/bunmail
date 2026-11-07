import { BlockList } from "net";
import { parseServer, type DnsServer } from "../utils/dns-transport.ts";
import { optionalEnv, optionalStrictBoolean } from "./env.ts";

/**
 * Reads `DANE_ENABLED` (#345): whether outbound delivery applies DANE for
 * SMTP (RFC 7672). Default `false`: off means no DNSSEC lookups and
 * delivery exactly as without DANE. Only `true` or `false`; anything else
 * refuses to boot. Exported for tests.
 */
export function readDaneEnabled(
  raw: string | undefined = process.env["DANE_ENABLED"],
): boolean {
  return optionalStrictBoolean("DANE_ENABLED", false, raw);
}

/**
 * Reads `DANE_RESOLVER` (#345): the validating DNS resolver whose AD bit
 * DANE trusts, as an IP literal with an optional port (`172.30.53.53`,
 * `172.30.53.53:5353`, `2001:db8::53`, `[2001:db8::53]:5353`; port 53 by
 * default). A host name is refused: resolving it would need a resolver
 * already trusted. Required when DANE is on (RFC 7672 section 2.1.1: the
 * validation status is only trusted from a resolver reached over a path
 * BunMail trusts); a malformed value refuses to boot even when DANE is
 * off. `null` when unset. Exported for tests.
 */
export function readDaneResolver(
  enabled: boolean,
  raw: string = optionalEnv("DANE_RESOLVER", ""),
): DnsServer | null {
  const value = raw.trim();
  if (value === "") {
    if (!enabled) return null;
    throw new Error(
      "[config] DANE_ENABLED=true needs DANE_RESOLVER, the validating resolver DANE trusts.\n" +
        "  → Run the compose `dane` profile (a local Unbound) and set DANE_RESOLVER to its\n" +
        "    address, e.g. DANE_RESOLVER=172.30.53.53. See docs/self-hosting.md.",
    );
  }
  const server = parseServer(value);
  if (server === null) {
    throw new Error(
      `[config] DANE_RESOLVER must be an IP address with an optional port, got "${raw}".\n` +
        "  → e.g. 172.30.53.53, 172.30.53.53:5353 or [2001:db8::53]:53 (a host name is not accepted).",
    );
  }
  return server;
}

/** The `config.dane` section. */
export interface DaneConfig {
  /** `DANE_ENABLED`: outbound DANE (RFC 7672) is applied. */
  enabled: boolean;
  /** `DANE_RESOLVER`: the trusted validating resolver; set whenever `enabled`. */
  resolver: DnsServer | null;
}

/** Outbound DANE for SMTP (RFC 7672, #345). */
export function buildDaneConfig(): DaneConfig {
  const enabled = readDaneEnabled();
  return { enabled, resolver: readDaneResolver(enabled) };
}

/**
 * Addresses a resolver BunMail can trust the AD bit of is expected at:
 * loopback, private (RFC 1918, IPv6 ULA) and link-local, the same host or
 * network. RFC 7672 section 2.1.1 trusts a remote validator's AD bit only
 * over a secure channel, which plain DNS is not.
 */
const LOCAL_RESOLVER_RANGES = (() => {
  const list = new BlockList();
  list.addSubnet("127.0.0.0", 8, "ipv4");
  list.addSubnet("10.0.0.0", 8, "ipv4");
  list.addSubnet("172.16.0.0", 12, "ipv4");
  list.addSubnet("192.168.0.0", 16, "ipv4");
  list.addSubnet("169.254.0.0", 16, "ipv4");
  list.addAddress("::1", "ipv6");
  list.addSubnet("fc00::", 7, "ipv6");
  list.addSubnet("fe80::", 10, "ipv6");
  return list;
})();

/**
 * Whether `resolver` is on a loopback, private or link-local address
 * (#345). Not refused when it is not: the boot logs a `warn` instead
 * (`warnIgnoredSettings`), since only the operator knows the path to it.
 */
export function daneResolverIsLocal(resolver: DnsServer): boolean {
  return LOCAL_RESOLVER_RANGES.check(
    resolver.address,
    resolver.family === 6 ? "ipv6" : "ipv4",
  );
}
