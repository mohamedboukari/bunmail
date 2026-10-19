import { setDomainDnsDeps } from "../../src/modules/domains/services/domain-dns-status.service.ts";

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
