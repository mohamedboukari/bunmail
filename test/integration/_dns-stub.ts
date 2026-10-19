import { setDomainDnsDeps } from "../../src/modules/domains/services/domain-dns-status.service.ts";
import { setMtaStsDeps } from "../../src/modules/emails/services/mta-sts.ts";
import { setDnsblDeps } from "../../src/modules/domains/services/sending-ip-dnsbl.service.ts";

/**
 * Hermetic DNS for the integration run (#250): the domains module's DNS
 * seam answers NXDOMAIN at once for every TXT and MX lookup, so no test
 * waits on a real resolver (slow CI resolvers made create time out).
 * Installed by `_preload.ts`; a test that needs specific answers calls
 * `setDomainDnsDeps` itself and puts this stub back afterwards.
 */
function notFound(name: string): Promise<never> {
  return Promise.reject(
    Object.assign(new Error(`ENOTFOUND ${name}`), { code: "ENOTFOUND" }),
  );
}

export function installHermeticDomainDns(): void {
  setDomainDnsDeps({ resolveTxt: notFound, resolveMx: notFound });
}

/**
 * No real DNS or HTTPS for MTA-STS (#250): every `_mta-sts` TXT lookup
 * answers NXDOMAIN (no policy), and a policy fetch could neither resolve
 * nor connect. Installed by `_preload.ts`; the MTA-STS tests install their
 * own answers and put this back afterwards.
 */
export function installHermeticMtaSts(): void {
  setMtaStsDeps({
    resolveTxt: notFound,
    lookup: notFound,
    fetch: () => Promise.reject(new Error("no real HTTPS in integration tests")),
  });
}

/**
 * No real DNS for the DNSBL self-check (#250): no sending IP is found and
 * every zone answers NXDOMAIN. Installed by `_preload.ts`; the DNSBL
 * tests install their own answers and put this back afterwards.
 */
export function installHermeticDnsbl(): void {
  setDnsblDeps({
    resolve4: notFound,
    sendingIps: () => Promise.resolve({ ips: [], source: "MAIL_HOSTNAME" }),
  });
}
