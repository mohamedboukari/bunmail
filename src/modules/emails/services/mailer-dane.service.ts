import { config } from "../../../config.ts";
import type { DnsServer } from "../../../utils/dns-transport.ts";
import {
  observeDaneLookupFailure,
  observeUnconnectedAttempt,
} from "../../tls-rpt/services/tls-rpt-observe.service.ts";
import type { TlsRptDomain } from "../../tls-rpt/types/tls-rpt.types.ts";
import type { SecureMx } from "../types/dane.types.ts";
import { decideDaneHost, resolveDaneRoute, type DaneRoute } from "./dane.ts";
import { resolveMxAddresses } from "./mx-address.ts";
import { resolveMxRoute, type HostResolver } from "./mx-route.ts";
import { matchingMxHosts, type ActiveMtaStsPolicy } from "./mta-sts.ts";

/**
 * The mailer's side of DANE (RFC 7672, #345): which route lookup a domain
 * gets, and how a DANE domain's MX hosts are resolved one by one.
 *
 * **Route** ({@link resolveRoute}): with `DANE_ENABLED`, every recipient
 * domain's MX records come from the trusted resolver (`dane.ts`), which
 * also says whether its MX RRset is secure. Off, or for a TLS report (RFC
 * 8460 section 3: reports go out despite TLS failures, as they already do
 * without MTA-STS), the route is `mx-route.ts`'s, exactly as without DANE.
 *
 * **Hosts of a DANE domain** ({@link daneHostResolver}): each host is
 * decided when delivery reaches it, in MX preference order (RFC 7672
 * section 2.2.1: preference before security):
 *
 * - DANE applies (secure TLSA records): the session requires TLS checked
 *   against them. DANE takes precedence over MTA-STS for that host (RFC
 *   8461 section 2: MTA-STS never overrides a failing DANE validation), so
 *   the MTA-STS policy plays no part in it.
 * - DANE does not apply: the host is handled as MTA-STS says. In enforce
 *   mode a host outside the policy is skipped (recorded for TLS-RPT as
 *   `mx-not-in-policy`, as when no host matches without DANE) and a
 *   matching one gets verified TLS (the plan's `verifiedTls`); otherwise
 *   opportunistic TLS.
 * - A DNSSEC lookup failed: the host is skipped (RFC 7672 section 2.1.2),
 *   recorded as `dnssec-invalid` for TLS-RPT.
 *
 * Addresses come from the trusted resolver's validated answers and go
 * through the same address check as any MX host (`resolveMxAddresses`:
 * no private address unless `MAIL_ALLOW_PRIVATE_MX`, the `MAIL_IP_FAMILY`
 * order).
 */

/** The trusted resolver when DANE is on, else `null`. */
function daneResolver(): DnsServer | null {
  return config.dane.enabled ? config.dane.resolver : null;
}

/**
 * `domain`'s route for this attempt (#345): under DANE when it is on and
 * `useDane` (not a report), else the plain MX route with no DANE. Never
 * throws.
 */
export async function resolveRoute(domain: string, useDane: boolean): Promise<DaneRoute> {
  const resolver = useDane ? daneResolver() : null;
  if (resolver === null) return { route: await resolveMxRoute(domain), secureMx: null };
  return resolveDaneRoute(domain, { resolver });
}

/** What a DANE domain's plan carries for its hosts. */
export interface DanePlan {
  secureMx: SecureMx;
  /** The domain's MTA-STS policy: applies to the hosts DANE does not. */
  stsPolicy: ActiveMtaStsPolicy | null;
}

/**
 * The host resolver of a DANE domain's delivery (#345); see the module
 * comment. `verifiedTls`: the domain's MTA-STS policy is in enforce mode.
 * `reportTargets`: the domains and their policies to record a skipped host
 * for in TLS-RPT (`dnssec-invalid`, `mx-not-in-policy`; none for a report). The lookups go to `resolver`; tests pass the address options.
 */
export function daneHostResolver(args: {
  dane: DanePlan;
  verifiedTls: boolean;
  reportTargets: readonly TlsRptDomain[];
  resolver: DnsServer;
  allowPrivate: boolean;
  ipFamily: 4 | 6;
  /** Lookup timeouts; production defaults when absent (tests shorten them). */
  timeouts?: { attemptTimeoutMs: number; timeoutMs: number };
}): HostResolver {
  return async (mxHost, port) => {
    const decision = await decideDaneHost(mxHost, args.dane.secureMx, port, {
      resolver: args.resolver,
      ...args.timeouts,
    });
    if (decision.kind === "skip") {
      if (decision.lookupFailed) {
        for (const target of args.reportTargets) {
          observeDaneLookupFailure(target.domain, mxHost);
        }
      }
      throw new Error(`DANE: MX host ${mxHost} not usable: ${decision.reason}`);
    }
    const policy = args.dane.stsPolicy;
    if (
      decision.kind === "none" &&
      args.verifiedTls &&
      policy !== null &&
      matchingMxHosts([mxHost], policy.policy).length === 0
    ) {
      for (const target of args.reportTargets) observeUnconnectedAttempt(target);
      throw new Error(`MTA-STS: MX host ${mxHost} is not in the enforce-mode policy`);
    }
    const addresses = await resolveMxAddresses(mxHost, {
      allowPrivate: args.allowPrivate,
      family: args.ipFamily,
      lookup: async () => decision.addresses.map((address) => ({ address })),
    });
    return { addresses, dane: decision.kind === "dane" ? decision.host : null };
  };
}
