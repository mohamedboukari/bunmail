import { config } from "../../../config.ts";
import type { DnsServer } from "../../../utils/dns-transport.ts";
import { logger } from "../../../utils/logger.ts";
import {
  observeDaneLookupFailure,
  observeUnconnectedAttempt,
} from "../../tls-rpt/services/tls-rpt-observe.service.ts";
import type { TlsRptDomain } from "../../tls-rpt/types/tls-rpt.types.ts";
import type { DaneHost, SecureMx } from "../types/dane.types.ts";
import { decideDaneHost, resolveDaneRoute, type DaneRoute } from "./dane.ts";
import { verifiedTlsOptions } from "./mailer-mta-sts.service.ts";
import { resolveMxAddresses } from "./mx-address.ts";
import { resolveMxRoute, type HostResolver } from "./mx-route.ts";
import { matchingMxHosts, type ActiveMtaStsPolicy } from "./mta-sts.ts";
import type { DaneTls, VerifiedTls } from "./mx-transport.ts";

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
 * - DANE applies (secure TLSA records) and at least one record is usable:
 *   the session requires TLS checked against them. DANE takes precedence
 *   over MTA-STS for that host (RFC 8461 section 2: MTA-STS never
 *   overrides a failing DANE validation), so the MTA-STS policy plays no
 *   part in it.
 * - DANE applies but no record is usable (#452): no DANE validation can
 *   happen, so RFC 8461 section 2 gives DANE no precedence. In enforce
 *   mode the host is handled as MTA-STS says, like a host DANE does not
 *   apply to (below): outside the policy it is skipped, in it the session
 *   gets verified TLS. Otherwise TLS is required but not authenticated
 *   (RFC 7672 section 2.2: publishing the records commits the host to
 *   TLS).
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
    /** DANE applies, but none of its records is usable and the policy is enforced (#452). */
    const unusableUnderSts =
      decision.kind === "dane" && mtaStsGoverns(decision.host, args.verifiedTls);
    if (
      (decision.kind === "none" || unusableUnderSts) &&
      args.verifiedTls &&
      policy !== null &&
      matchingMxHosts([mxHost], policy.policy).length === 0
    ) {
      for (const target of args.reportTargets) observeUnconnectedAttempt(target);
      throw new Error(`MTA-STS: MX host ${mxHost} is not in the enforce-mode policy`);
    }
    if (unusableUnderSts) {
      logger.debug("DANE: no usable TLSA record, MTA-STS verified TLS applies", {
        domain: args.dane.secureMx.nextHop,
        mxHost,
        baseDomain: decision.host.baseDomain,
      });
    }
    const addresses = await resolveMxAddresses(mxHost, {
      allowPrivate: args.allowPrivate,
      family: args.ipFamily,
      lookup: async () => decision.addresses.map((address) => ({ address })),
    });
    return { addresses, dane: decision.kind === "dane" ? decision.host : null };
  };
}

/**
 * Whether MTA-STS, not DANE, secures a session to `host` (#452): none of
 * its TLSA records is usable, so no DANE validation can happen (RFC 8461
 * section 2 lets DANE take precedence only when it does), and the domain's
 * MTA-STS policy is in enforce mode (`verifiedTls`).
 */
function mtaStsGoverns(host: DaneHost, verifiedTls: boolean): boolean {
  return host.usable.length === 0 && verifiedTls;
}

/** The TLS of one MX session (#345, #452): DANE, MTA-STS verified TLS, or neither (opportunistic). */
export interface SessionTls {
  dane?: DaneTls;
  verifiedTls?: VerifiedTls;
}

/**
 * The TLS of a session to an MX host (#345, #452). `dane`: the host's
 * TLSA records when DANE applies to it (the host resolver's answer), else
 * `null`. `verifiedTls`: the domain's MTA-STS policy is in enforce mode.
 *
 * | DANE for the host     | MTA-STS enforce | Session                               |
 * | --------------------- | --------------- | ------------------------------------- |
 * | usable TLSA records   | either          | DANE (authenticated)                  |
 * | no usable TLSA record | yes             | MTA-STS verified TLS                  |
 * | no usable TLSA record | no              | DANE: TLS required, not authenticated |
 * | none (off, insecure)  | yes             | MTA-STS verified TLS                  |
 * | none (off, insecure)  | no              | opportunistic TLS                     |
 */
export function sessionTls(dane: DaneHost | null, verifiedTls: boolean): SessionTls {
  if (dane !== null && !mtaStsGoverns(dane, verifiedTls)) return { dane: { host: dane } };
  return verifiedTls ? { verifiedTls: verifiedTlsOptions() } : {};
}
