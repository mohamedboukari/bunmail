import { resolve4 } from "dns/promises";
import { isIP } from "net";
import { logger } from "../../../utils/logger.ts";
import { runWithLogContext } from "../../../utils/log-context.ts";
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

/** What the A records answered for a DNSBL query mean. */
type DnsblAnswer =
  | { kind: "listed" }
  | { kind: "not-listed" }
  /** The zone refused the query (`127.255.255.x`), e.g. sent through a public resolver. */
  | { kind: "refused"; answer: string }
  /** Not a listing code: a resolver rewriting NXDOMAIN, or an undocumented answer. */
  | { kind: "unexpected"; answer: string };

/** A listing return code: `127.0.0.2` and up (`127.0.0.1` is not a listing on common zones). */
const LISTED_ANSWER = /^127\.0\.0\.(\d{1,3})$/;

/**
 * Reads the A records answered for a DNSBL query, like the outbound
 * self-check does (`sending-ip-dnsbl.service.ts`). Only a listing code
 * means listed: Spamhaus answers `127.255.255.254` to every query sent
 * through a public resolver such as 1.1.1.1, and treating that as a
 * listing would refuse every sender.
 */
export function classifyDnsblAnswers(answers: readonly string[]): DnsblAnswer {
  const refused = answers.find((answer) => answer.startsWith("127.255.255."));
  if (refused !== undefined) return { kind: "refused", answer: refused };
  const listed = answers.some((answer) => {
    const octet = LISTED_ANSWER.exec(answer)?.[1];
    return octet !== undefined && Number(octet) >= 2 && Number(octet) <= 255;
  });
  if (listed) return { kind: "listed" };
  const [first] = answers;
  return first === undefined
    ? { kind: "not-listed" }
    : { kind: "unexpected", answer: first };
}

/** How long one reason for an unchecked connection stays quiet after it was logged. */
const UNCHECKED_WARN_INTERVAL_MS = 10 * 60 * 1000;

/** Per reason: when it was last logged and how many repeats were suppressed since. */
const uncheckedWarnings = new Map<string, { at: number; suppressed: number }>();

/**
 * Logs that the DNSBL check did not run, at most once per reason every
 * ten minutes: a resolver outage or a refusing zone would otherwise warn
 * on every connection. Each line carries how many were suppressed before it.
 */
function warnUnchecked(
  reason: string,
  fields: Record<string, unknown>,
  now: number,
): void {
  const last = uncheckedWarnings.get(reason);
  if (last !== undefined && now - last.at < UNCHECKED_WARN_INTERVAL_MS) {
    last.suppressed += 1;
    return;
  }
  logger.warn("DNSBL check did not run: connection allowed unchecked", {
    reason,
    ...fields,
    suppressedSinceLast: last?.suppressed ?? 0,
  });
  uncheckedWarnings.set(reason, { at: now, suppressed: 0 });
}

/** Injectable for tests: the A-record lookup and the clock. */
export interface DnsblDeps {
  lookup?: (hostname: string) => Promise<string[]>;
  now?: () => number;
}

/**
 * Checks if an IP address is listed on a DNSBL (DNS-based blacklist).
 *
 * Queries the DNSBL zone by reversing the IP octets and appending the zone,
 * e.g. 1.2.3.4 → 4.3.2.1.zen.spamhaus.org. A listing return code means
 * listed; NOTFOUND / NODATA means clean. Anything else means the check did
 * not run: a failed lookup (timeout, SERVFAIL), a refused query
 * (`127.255.255.x`) or an unexpected answer. The connection is then still
 * allowed (fail open), with a throttled warning so the gap shows in the logs.
 *
 * @param ip   - The connecting client's IP address
 * @param zone - The DNSBL zone to query (e.g. "zen.spamhaus.org")
 * @param deps - The lookup (`resolve4`) and clock; injectable for tests
 * @returns true if the IP is blacklisted
 */
export async function isBlacklistedIp(
  ip: string,
  zone: string,
  deps: DnsblDeps = {},
): Promise<boolean> {
  const query = dnsblQueryName(ip, zone);
  if (query === null) return false;
  const lookup = deps.lookup ?? resolve4;
  const now = deps.now ?? Date.now;

  let answers: string[];
  try {
    answers = await lookup(query);
  } catch (error: unknown) {
    const code: unknown =
      typeof error === "object" && error !== null
        ? Reflect.get(error, "code")
        : undefined;
    /** No such record: the IP is not listed. */
    if (code === "ENOTFOUND" || code === "ENODATA") return false;
    const shown = typeof code === "string" ? code : "unknown";
    warnUnchecked(`lookup-failed:${shown}`, { ip, zone, code: shown }, now());
    return false;
  }

  const result = classifyDnsblAnswers(answers);
  if (result.kind === "listed") return true;
  if (result.kind === "refused" || result.kind === "unexpected") {
    warnUnchecked(
      `${result.kind}:${result.answer}`,
      { ip, zone, answer: result.answer },
      now(),
    );
  }
  return false;
}

/** How to make a zone answer when it does not through the current resolver. */
const RESOLVER_HINT =
  "Spamhaus blocks queries sent through public resolvers (Google, Cloudflare): run a local recursive resolver, or set SMTP_DNSBL_ZONE to a Spamhaus DQS zone with your key";

/** The outcome of the boot self-test. */
export type DnsblSelfTest = "ok" | "refused" | "not-answering" | "unexpected";

/**
 * Boot self-test of the inbound DNSBL (RFC 5782 §5: every DNSBL lists
 * `127.0.0.2`). Through a resolver the zone blocks, that entry comes back
 * unlisted (Google Public DNS: NXDOMAIN) or refused (Cloudflare:
 * `127.255.255.254`), and the per-connection check then protects nothing
 * without any error to show for it. Logs one line, never fatal.
 *
 * @param zone - The DNSBL zone to test (`SMTP_DNSBL_ZONE`)
 * @param deps - The lookup (`resolve4`); injectable for tests
 * @returns What the test found
 */
export function selfTestDnsbl(
  zone: string,
  deps: DnsblDeps = {},
): Promise<DnsblSelfTest> {
  const lookup = deps.lookup ?? resolve4;
  return runWithLogContext({ job: "inbound-dnsbl-self-test" }, async () => {
    let answers: string[];
    try {
      answers = await lookup(`2.0.0.127.${zone}`);
    } catch (error: unknown) {
      const code: unknown =
        typeof error === "object" && error !== null
          ? Reflect.get(error, "code")
          : undefined;
      logger.warn(
        "Inbound DNSBL self-test failed: the zone does not answer, no IP is blocked",
        {
          zone,
          code: typeof code === "string" ? code : "unknown",
          hint: RESOLVER_HINT,
        },
      );
      return "not-answering";
    }
    const result = classifyDnsblAnswers(answers);
    if (result.kind === "listed") {
      logger.info("Inbound DNSBL self-test passed", { zone });
      return "ok";
    }
    if (result.kind === "not-listed") {
      logger.warn(
        "Inbound DNSBL self-test failed: the zone does not answer, no IP is blocked",
        {
          zone,
          hint: RESOLVER_HINT,
        },
      );
      return "not-answering";
    }
    logger.warn(
      "Inbound DNSBL self-test failed: the zone refused or answered oddly, no IP is blocked",
      {
        zone,
        answer: result.answer,
        hint: RESOLVER_HINT,
      },
    );
    return result.kind;
  });
}
