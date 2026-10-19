/**
 * DNSBL self-check of the sending IPs (#250).
 *
 * A sending IP listed on a major blocklist sends mail that big receivers
 * reject or spam-folder, and nothing in BunMail used to say so. This
 * worker looks up each sending address (`MAIL_PUBLIC_IP`, or the A/AAAA
 * records of `MAIL_HOSTNAME`, see `sending-ips.service.ts`) on three
 * zones about a minute after boot, then once a day, and keeps the result
 * in memory for the dashboard home page. Per replica, no table.
 *
 * Information only: a listing never holds or refuses mail.
 *
 * Reading answers (A lookups, 5 s timeout each):
 * - `127.0.0.2` to `127.0.0.11`: listed, with the return code kept;
 * - any `127.255.255.x`: the zone refused the query (Spamhaus answers this
 *   way to queries sent through public resolvers): `unavailable`;
 * - NXDOMAIN (or no A record): not listed;
 * - errors and timeouts: `unknown`;
 * - any other answer: `unknown`, never listed (a resolver that rewrites
 *   NXDOMAIN, or a zone answering something undocumented).
 *
 * IPv4 is queried as reversed octets, IPv6 as reversed nibbles, and IPv6
 * only on zones that list it (today Spamhaus ZEN alone).
 */
import { resolve4 } from "dns/promises";
import { isIP } from "net";
import { config } from "../../../config.ts";
import { generateId } from "../../../utils/id.ts";
import { logger } from "../../../utils/logger.ts";
import { runWithLogContext } from "../../../utils/log-context.ts";
import { isBlockedIp, parseIpv6 } from "../../../utils/ssrf-guard.ts";
import { withTimeout } from "../../emails/services/mx-route.ts";
import { resolveSendingIps, type SendingIps } from "./sending-ips.service.ts";

/** One blocklist zone the sending IPs are checked against. */
export interface DnsblZone {
  /** The DNS zone queried, e.g. `zen.spamhaus.org`. */
  zone: string;
  /** Display name. */
  name: string;
  /** Whether the zone lists IPv6 addresses; IPv6 is never queried otherwise. */
  ipv6: boolean;
  /** The zone's lookup and removal page. */
  removalUrl: string;
}

/** The zones checked, in display order. */
export const DNSBL_ZONES: readonly DnsblZone[] = [
  {
    zone: "zen.spamhaus.org",
    name: "Spamhaus ZEN",
    ipv6: true,
    removalUrl: "https://check.spamhaus.org/",
  },
  {
    zone: "b.barracudacentral.org",
    name: "Barracuda BRBL",
    ipv6: false,
    removalUrl: "https://www.barracudacentral.org/rbl/removal-request",
  },
  {
    zone: "bl.spamcop.net",
    name: "SpamCop",
    ipv6: false,
    removalUrl: "https://www.spamcop.net/bl.shtml",
  },
];

/** One return code of a listing, with what it means. */
export interface ListingCode {
  /** The A record answered, e.g. `127.0.0.2`. */
  code: string;
  meaning: string;
  /**
   * A policy listing (Spamhaus PBL: an address range not meant to send
   * mail directly), not a sign of abuse.
   */
  policy: boolean;
}

/** The result of one address on one zone. */
export type ZoneResult =
  | { status: "listed"; codes: ListingCode[] }
  | { status: "not-listed" }
  /** The zone refused the query (`127.255.255.x`). */
  | { status: "unavailable"; code: string }
  /** The lookup failed, timed out or got an unexpected answer. */
  | { status: "unknown"; reason: string };

/** One address on one zone. */
export interface ZoneCheck {
  zone: string;
  name: string;
  removalUrl: string;
  result: ZoneResult;
}

/** One sending address and its results. */
export interface AddressCheck {
  ip: string;
  /** Not publicly routable (private, loopback, reserved): never looked up. */
  skipped: boolean;
  /** One entry per zone that lists this address family. */
  zones: ZoneCheck[];
}

/** One run of the check, kept for the dashboard. */
export interface DnsblSnapshot {
  source: SendingIps["source"];
  addresses: AddressCheck[];
  checkedAt: Date;
}

/** The lookups, the sending addresses and the timeout, replaceable in tests. */
export interface DnsblDeps {
  resolve4: (name: string) => Promise<string[]>;
  sendingIps: () => Promise<SendingIps>;
  timeoutMs: number;
}

const realDeps: DnsblDeps = {
  /** Called through, so a replaced `dns/promises` export is honoured. */
  resolve4: (name) => resolve4(name),
  sendingIps: () => resolveSendingIps(),
  timeoutMs: 5_000,
};

let activeDeps: DnsblDeps = realDeps;

/** Replaces the lookups (tests), or restores the real ones with `null`. */
export function setDnsblDeps(override: Partial<DnsblDeps> | null): void {
  activeDeps = override === null ? realDeps : { ...realDeps, ...override };
}

/** `1.2.3.4` as `4.3.2.1`. */
export function reverseIpv4(ip: string): string {
  return ip.split(".").toReversed().join(".");
}

/**
 * An IPv6 address as its 32 reversed nibbles (`2001:db8::1` becomes
 * `1.0.0.0. ... .8.b.d.0.1.0.0.2`), or null when it does not parse.
 */
export function reverseIpv6Nibbles(ip: string): string | null {
  const groups = parseIpv6(ip);
  if (groups === null) return null;
  return groups
    .map((group) => group.toString(16).padStart(4, "0"))
    .join("")
    .split("")
    .toReversed()
    .join(".");
}

/** The IPv4 address an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) carries, or null. */
function mappedIpv4(ip: string): string | null {
  const groups = parseIpv6(ip);
  if (groups === null) return null;
  if (!groups.slice(0, 5).every((group) => group === 0) || groups[5] !== 0xffff) {
    return null;
  }
  const high = groups[6] ?? 0;
  const low = groups[7] ?? 0;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

/** The address to look up: an IPv4-mapped IPv6 address as its IPv4. */
function lookupAddress(ip: string): string {
  return isIP(ip) === 6 ? (mappedIpv4(ip) ?? ip) : ip;
}

/**
 * The query name for `ip` on `zone`, or null when the zone does not list
 * that address family (IPv6 on an IPv4-only zone) or `ip` is not an IP.
 */
export function dnsblQueryName(ip: string, zone: DnsblZone): string | null {
  const addr = lookupAddress(ip);
  const family = isIP(addr);
  if (family === 4) return `${reverseIpv4(addr)}.${zone.zone}`;
  if (family === 6 && zone.ipv6) {
    const nibbles = reverseIpv6Nibbles(addr);
    return nibbles === null ? null : `${nibbles}.${zone.zone}`;
  }
  return null;
}

/** `127.0.0.N` with N from 2 to 11: the only answers that mean listed. */
function listedOctet(answer: string): number | null {
  const match = /^127\.0\.0\.(\d{1,3})$/.exec(answer);
  if (!match) return null;
  const octet = Number(match[1]);
  return octet >= 2 && octet <= 11 ? octet : null;
}

/** What a Spamhaus ZEN return code means. */
function zenMeaning(octet: number): { meaning: string; policy: boolean } {
  if (octet === 2) return { meaning: "SBL: a known spam source", policy: false };
  if (octet === 3) {
    return { meaning: "SBL CSS: low-reputation or snowshoe sending", policy: false };
  }
  if (octet >= 4 && octet <= 7) {
    return {
      meaning: "XBL: a compromised host (malware, botnet, open proxy)",
      policy: false,
    };
  }
  if (octet === 9) {
    return { meaning: "DROP: a hijacked or criminal network", policy: false };
  }
  if (octet === 10 || octet === 11) {
    return {
      meaning:
        "PBL: a range its owner says should not send mail directly (a policy listing, not abuse)",
      policy: true,
    };
  }
  return { meaning: `listed (code 127.0.0.${octet})`, policy: false };
}

/** A listed return code with its meaning on `zone`. */
function describeCode(zone: DnsblZone, answer: string, octet: number): ListingCode {
  if (zone.zone === "zen.spamhaus.org") return { code: answer, ...zenMeaning(octet) };
  return { code: answer, meaning: "listed", policy: false };
}

/** Reads the A records answered for a query on `zone`. */
export function classifyAnswers(zone: DnsblZone, answers: readonly string[]): ZoneResult {
  const refused = answers.find((answer) => answer.startsWith("127.255.255."));
  if (refused !== undefined) return { status: "unavailable", code: refused };
  const codes: ListingCode[] = [];
  for (const answer of answers) {
    const octet = listedOctet(answer);
    if (octet !== null) codes.push(describeCode(zone, answer, octet));
  }
  if (codes.length > 0) return { status: "listed", codes };
  if (answers.length === 0) return { status: "not-listed" };
  return {
    status: "unknown",
    reason: `unexpected answer ${answers.join(", ")}: is the resolver rewriting NXDOMAIN?`,
  };
}

/** DNS codes that mean "no such name or record": not listed. */
const NOT_LISTED_CODES = new Set(["ENOTFOUND", "ENODATA"]);

/** The `code` of a DNS error (`ENOTFOUND`, `ETIMEOUT`, ...), if it has one. */
function dnsCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

/** Reads a failed lookup: NXDOMAIN is "not listed", anything else "unknown". */
export function classifyError(error: unknown): ZoneResult {
  const code = dnsCode(error);
  if (code !== undefined && NOT_LISTED_CODES.has(code)) return { status: "not-listed" };
  return { status: "unknown", reason: `lookup failed (${code ?? "no error code"})` };
}

/** Looks up `query` and reads the answer. Never rejects. */
async function lookupZone(
  query: string,
  zone: DnsblZone,
  deps: DnsblDeps,
): Promise<ZoneResult> {
  try {
    return classifyAnswers(zone, await withTimeout(deps.resolve4(query), deps.timeoutMs));
  } catch (error: unknown) {
    return classifyError(error);
  }
}

/** Checks one address on every zone that lists its family, in parallel. */
export async function checkAddress(
  ip: string,
  deps: DnsblDeps = activeDeps,
  zones: readonly DnsblZone[] = DNSBL_ZONES,
): Promise<AddressCheck> {
  if (isBlockedIp(lookupAddress(ip))) return { ip, skipped: true, zones: [] };
  const checks = await Promise.all(
    zones.map(async (zone): Promise<ZoneCheck | null> => {
      const query = dnsblQueryName(ip, zone);
      if (query === null) return null;
      return {
        zone: zone.zone,
        name: zone.name,
        removalUrl: zone.removalUrl,
        result: await lookupZone(query, zone, deps),
      };
    }),
  );
  return {
    ip,
    skipped: false,
    zones: checks.filter((check): check is ZoneCheck => check !== null),
  };
}

/** Checks every sending address. Never rejects on a lookup failure. */
export async function checkSendingIpsDnsbl(
  deps: DnsblDeps = activeDeps,
  now: () => Date = () => new Date(),
): Promise<DnsblSnapshot> {
  const { ips, source } = await deps.sendingIps();
  const addresses = await Promise.all(ips.map((ip) => checkAddress(ip, deps)));
  return { source, addresses, checkedAt: now() };
}

/**
 * Whether each address was last seen listed on each zone, keyed
 * `ip zone`. Only definitive results (listed or not listed) update it, so
 * an `unknown` between two listed results logs nothing.
 */
export type ListingMemory = Map<string, boolean>;

/** The memory of the running worker. */
const listingMemory: ListingMemory = new Map();

/**
 * Logs each change since the previous run: `warn` when an address becomes
 * listed on a zone (including on the first run), `info` when it is
 * delisted. Nothing while a state holds. Returns the counts.
 */
export function logListingTransitions(
  snapshot: DnsblSnapshot,
  memory: ListingMemory = listingMemory,
): { listed: number; delisted: number } {
  let listed = 0;
  let delisted = 0;
  for (const address of snapshot.addresses) {
    for (const check of address.zones) {
      const key = `${address.ip} ${check.zone}`;
      const was = memory.get(key);
      const { result } = check;
      if (result.status === "listed") {
        memory.set(key, true);
        if (was === true) continue;
        listed++;
        logger.warn(
          "Sending IP listed on a DNSBL: receivers may reject or spam-folder mail",
          {
            ip: address.ip,
            zone: check.zone,
            codes: result.codes.map((c) => c.code),
            meanings: result.codes.map((c) => c.meaning),
            policyOnly: result.codes.every((c) => c.policy),
            removal: check.removalUrl,
          },
        );
      } else if (result.status === "not-listed") {
        memory.set(key, false);
        if (was !== true) continue;
        delisted++;
        logger.info("Sending IP delisted from a DNSBL", {
          ip: address.ip,
          zone: check.zone,
        });
      }
    }
  }
  return { listed, delisted };
}

/** What one run found, logged once as its outcome line. */
export interface DnsblRunSummary {
  addresses: number;
  /** Addresses never looked up (not publicly routable). */
  skipped: number;
  /** Address and zone pairs per result. */
  listed: number;
  notListed: number;
  unavailable: number;
  unknown: number;
  /** Changes since the previous run. */
  newlyListed: number;
  delisted: number;
  durationMs: number;
}

/** Counts the results of a snapshot. */
function summarize(
  snapshot: DnsblSnapshot,
): Omit<DnsblRunSummary, "newlyListed" | "delisted" | "durationMs"> {
  const counts = { listed: 0, notListed: 0, unavailable: 0, unknown: 0 };
  for (const address of snapshot.addresses) {
    for (const { result } of address.zones) {
      if (result.status === "listed") counts.listed++;
      else if (result.status === "not-listed") counts.notListed++;
      else if (result.status === "unavailable") counts.unavailable++;
      else counts.unknown++;
    }
  }
  return {
    addresses: snapshot.addresses.length,
    skipped: snapshot.addresses.filter((a) => a.skipped).length,
    ...counts,
  };
}

/** The latest result, read by the dashboard. */
let latestSnapshot: DnsblSnapshot | null = null;

/** Shown when a zone refused the queries. */
export const PUBLIC_RESOLVER_HINT =
  "Spamhaus refuses queries sent through public resolvers (8.8.8.8, 1.1.1.1, 9.9.9.9): point this server at a local recursive resolver";

/**
 * One run: checks every sending address, stores the result for the
 * dashboard and logs transitions plus one outcome line. Runs in its own
 * log context (`job: "dnsbl-self-check"`, a fresh `jobId`). Does nothing
 * and returns null while `SENDING_IP_DNSBL_CHECK=false`. Never rejects.
 */
export function runDnsblSelfCheck(
  deps: DnsblDeps = activeDeps,
  memory: ListingMemory = listingMemory,
): Promise<DnsblRunSummary | null> {
  return runWithLogContext(
    { job: "dnsbl-self-check", jobId: generateId("dbl") },
    async () => {
      if (!config.sendingIpDnsbl.enabled) return null;
      const startedAt = Date.now();
      try {
        const snapshot = await checkSendingIpsDnsbl(deps);
        latestSnapshot = snapshot;
        const { listed: newlyListed, delisted } = logListingTransitions(snapshot, memory);
        const summary: DnsblRunSummary = {
          ...summarize(snapshot),
          newlyListed,
          delisted,
          durationMs: Date.now() - startedAt,
        };
        logger.info("DNSBL self-check completed", {
          source: snapshot.source,
          ...summary,
          ...(summary.unavailable > 0 ? { hint: PUBLIC_RESOLVER_HINT } : {}),
        });
        return summary;
      } catch (error: unknown) {
        logger.error("DNSBL self-check failed", {
          errorName: error instanceof Error ? error.name : typeof error,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
  );
}

/** What the dashboard card shows. */
export interface DnsblStatus {
  /** `SENDING_IP_DNSBL_CHECK`. */
  enabled: boolean;
  /** The latest result; null before the first run. */
  snapshot: DnsblSnapshot | null;
}

/** The latest result for the dashboard, without any lookup. */
export function getDnsblStatus(): DnsblStatus {
  return { enabled: config.sendingIpDnsbl.enabled, snapshot: latestSnapshot };
}

/** Forgets the latest result and the listing memory (tests). */
export function resetDnsblState(): void {
  latestSnapshot = null;
  listingMemory.clear();
}

/** Delay of the first run after boot, before jitter. */
const FIRST_RUN_DELAY_MS = 60 * 1000;
/** Time between two runs, before jitter. */
const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** `ms` plus or minus `fraction` of it, so replicas do not run in lockstep. */
function withJitter(ms: number, fraction: number): number {
  return Math.round(ms * (1 - fraction + Math.random() * 2 * fraction));
}

/** True between `start()` and `stop()`. */
let running = false;
/** True while a run is in progress; it schedules the next one when it ends. */
let inRun = false;
/** The next scheduled run, or null while a run is in progress or once stopped. */
let timer: ReturnType<typeof setTimeout> | null = null;

/** Schedules the next run after `delayMs`, unless the worker was stopped. */
function scheduleRun(delayMs: number): void {
  if (!running) return;
  timer = setTimeout(() => {
    timer = null;
    inRun = true;
    void runDnsblSelfCheck().finally(() => {
      inRun = false;
      scheduleRun(withJitter(RUN_INTERVAL_MS, 0.05));
    });
  }, delayMs);
}

/**
 * Starts the worker: the first run about a minute after boot (45 to 75
 * s), then one about every 24 hours (plus or minus 5%), each scheduled
 * when the previous one ends. Idempotent. Does nothing while
 * `SENDING_IP_DNSBL_CHECK=false`.
 */
export function start(): void {
  if (running) return;
  if (!config.sendingIpDnsbl.enabled) {
    logger.info("Sending IP DNSBL self-check disabled (SENDING_IP_DNSBL_CHECK=false)");
    return;
  }
  running = true;
  logger.info("Starting sending IP DNSBL self-check", {
    zones: DNSBL_ZONES.map((z) => z.zone),
    intervalHours: RUN_INTERVAL_MS / 3_600_000,
  });
  /** Restarted during a run: that run schedules the next one. */
  if (!inRun) scheduleRun(withJitter(FIRST_RUN_DELAY_MS, 0.25));
}

/** Stops the worker. Called from the SIGINT/SIGTERM shutdown path. */
export function stop(): void {
  if (!running) return;
  running = false;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  logger.info("Sending IP DNSBL self-check stopped");
}

/** Whether the worker is running (tests). */
export function isRunning(): boolean {
  return running;
}
