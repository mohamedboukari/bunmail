import { resolve4, resolve6, reverse } from "dns/promises";
import { isIPv6 } from "net";
import { config } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";

/**
 * The public IP addresses this server sends mail from (#247, #248): what
 * SPF must authorize and what the PTR check reverse-resolves.
 *
 * `MAIL_PUBLIC_IP` when set; otherwise the A and AAAA records of
 * `MAIL_HOSTNAME`. Behind Docker NAT the container cannot see its egress
 * address, so the hostname's records stand in for it: the checks then
 * prove that DNS is consistent, not which address a connection used.
 */
export interface SendingIps {
  ips: string[];
  /** Where the list came from, for messages and logs. */
  source: "MAIL_PUBLIC_IP" | "MAIL_HOSTNAME";
}

/** DNS lookups, injectable for tests. */
export interface SendingIpDeps {
  resolve4: (hostname: string) => Promise<string[]>;
  resolve6: (hostname: string) => Promise<string[]>;
}

const defaultDeps: SendingIpDeps = { resolve4, resolve6 };

/** Records of one family, or none when the lookup fails (no such record, DNS down). */
async function recordsOf(
  lookup: (hostname: string) => Promise<string[]>,
  hostname: string,
): Promise<string[]> {
  try {
    return await lookup(hostname);
  } catch {
    return [];
  }
}

export async function resolveSendingIps(
  deps: SendingIpDeps = defaultDeps,
): Promise<SendingIps> {
  if (config.mail.publicIps.length > 0) {
    return { ips: config.mail.publicIps, source: "MAIL_PUBLIC_IP" };
  }
  const hostname = config.mail.hostname;
  const [v4, v6] = await Promise.all([
    recordsOf(deps.resolve4, hostname),
    recordsOf(deps.resolve6, hostname),
  ]);
  const ips = [...v4, ...v6];
  if (ips.length === 0) {
    logger.warn("MAIL_HOSTNAME has no A or AAAA record: sending IPs unknown", {
      hostname,
    });
  }
  return { ips, source: "MAIL_HOSTNAME" };
}

/** One sending IP's forward-confirmed reverse DNS result (#248). */
export interface ReverseDnsCheck {
  ip: string;
  ok: boolean;
  /** The PTR names found for `ip`. */
  ptr: string[];
  reason: string;
}

/** DNS lookups for the reverse check, injectable for tests. */
export interface ReverseDnsDeps extends SendingIpDeps {
  reverse: (ip: string) => Promise<string[]>;
}

const defaultReverseDeps: ReverseDnsDeps = { resolve4, resolve6, reverse };

/** Lowercase, without the trailing dot of a fully qualified name. */
function normalizeHostname(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Forward-confirmed reverse DNS for every sending IP (#248): the PTR of
 * the IP must name `MAIL_HOSTNAME`, and `MAIL_HOSTNAME` must resolve back
 * to the same IP. Gmail rejects mail without it (550 5.7.25); Outlook and
 * Yahoo penalize it. The PTR is set at the hosting provider, so this
 * check only reports, it changes nothing.
 */
export async function checkReverseDns(
  deps: ReverseDnsDeps = defaultReverseDeps,
): Promise<{ source: SendingIps["source"]; checks: ReverseDnsCheck[] }> {
  const { ips, source } = await resolveSendingIps(deps);
  const hostname = normalizeHostname(config.mail.hostname);
  const checks: ReverseDnsCheck[] = [];
  for (const ip of ips) {
    const ptr = await recordsOf(deps.reverse, ip);
    const named = ptr.some((name) => normalizeHostname(name) === hostname);
    if (!named) {
      checks.push({
        ip,
        ok: false,
        ptr,
        reason: `PTR of ${ip} is ${ptr.length > 0 ? ptr.join(", ") : "missing"}, expected ${hostname}: set it at your hosting provider`,
      });
      continue;
    }
    const forward = await recordsOf(isIPv6(ip) ? deps.resolve6 : deps.resolve4, hostname);
    checks.push(
      forward.includes(ip)
        ? { ip, ok: true, ptr, reason: `${ip} and ${hostname} confirm each other` }
        : {
            ip,
            ok: false,
            ptr,
            reason: `PTR of ${ip} names ${hostname}, but ${hostname} does not resolve back to ${ip}`,
          },
    );
  }
  return { source, checks };
}

/** A reverse DNS check result, with when it ran (for the dashboard, #248). */
export interface ReverseDnsStatus {
  hostname: string;
  source: SendingIps["source"];
  checks: ReverseDnsCheck[];
  checkedAt: Date;
}

/** How long a reverse DNS result is shown before a background refresh. */
const STATUS_TTL_MS = 10 * 60 * 1000;

/** The latest result, shared by the boot check and the dashboard. */
let latestStatus: ReverseDnsStatus | null = null;
/** The refresh in flight, so concurrent page loads share one lookup. */
let refreshing: Promise<void> | null = null;

/** Runs the check and stores the result. Never throws. */
async function refreshReverseDnsStatus(
  deps?: ReverseDnsDeps,
): Promise<ReverseDnsStatus | null> {
  try {
    const { source, checks } = await checkReverseDns(deps);
    latestStatus = {
      hostname: normalizeHostname(config.mail.hostname),
      source,
      checks,
      checkedAt: new Date(),
    };
  } catch (error: unknown) {
    logger.warn("Reverse DNS status refresh failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return latestStatus;
}

/**
 * The latest reverse DNS result for the dashboard (#248), without waiting
 * on DNS: returns what is cached (possibly `null` before the first check)
 * and starts a background refresh once it is older than 10 minutes.
 */
export function peekReverseDnsStatus(now: number = Date.now()): ReverseDnsStatus | null {
  const stale =
    latestStatus === null || now - latestStatus.checkedAt.getTime() >= STATUS_TTL_MS;
  if (stale && refreshing === null) {
    refreshing = refreshReverseDnsStatus().then(() => {
      refreshing = null;
    });
  }
  return latestStatus;
}

/**
 * Logs the reverse DNS check once at boot (#248). Never fatal and never
 * blocks startup. Behind NAT the container cannot see its real egress
 * address: the check then proves DNS consistency for the configured
 * addresses, and `MAIL_PUBLIC_IP` should name the real one.
 */
export async function logReverseDnsAtBoot(deps?: ReverseDnsDeps): Promise<void> {
  try {
    const status = await refreshReverseDnsStatus(deps);
    if (status === null) return;
    const { source, checks } = status;
    const failed = checks.filter((check) => !check.ok);
    if (checks.length > 0 && failed.length === 0) {
      logger.info("Reverse DNS confirmed for every sending IP", {
        source,
        ips: checks.map((c) => c.ip),
      });
      return;
    }
    for (const check of failed) {
      logger.warn("Reverse DNS check failed: receivers may reject or spam-folder mail", {
        source,
        ip: check.ip,
        ptr: check.ptr,
        reason: check.reason,
        note: "behind NAT, set MAIL_PUBLIC_IP to the real egress address",
      });
    }
  } catch (error: unknown) {
    logger.warn("Reverse DNS check could not run", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
