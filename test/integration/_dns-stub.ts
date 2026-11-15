import { afterAll, afterEach } from "bun:test";
import { getServers, setServers } from "dns";
import {
  setDomainDnsDeps,
  type DomainDnsDeps,
} from "../../src/modules/domains/services/domain-dns-status.service.ts";
import { setMtaStsDeps } from "../../src/modules/emails/services/mta-sts.ts";
import type { MtaStsDeps } from "../../src/modules/emails/services/mta-sts-fetch.ts";
import { setDnsblDeps } from "../../src/modules/domains/services/sending-ip-dnsbl.service.ts";
import { setSendingIpDeps } from "../../src/modules/domains/services/sending-ips.service.ts";
import { buildResponse, startFakeDns } from "../fake-dns.ts";

/**
 * Hermetic DNS for the integration run (#250): the domains module's DNS
 * seam answers NXDOMAIN at once for every TXT and MX lookup, so no test
 * waits on a real resolver (slow CI resolvers made create time out).
 * Installed by `_preload.ts`; a test that needs specific answers passes
 * them as `overrides` (the other lookups stay stubbed: `setDomainDnsDeps`
 * fills what it is not given with the REAL lookups, #482) and puts this
 * stub back afterwards.
 */
function notFound(name: string): Promise<never> {
  return Promise.reject(
    Object.assign(new Error(`ENOTFOUND ${name}`), { code: "ENOTFOUND" }),
  );
}

export function installHermeticDomainDns(overrides: Partial<DomainDnsDeps> = {}): void {
  setDomainDnsDeps({ resolveTxt: notFound, resolveMx: notFound, ...overrides });
}

/**
 * No real DNS or HTTPS for MTA-STS (#250): every `_mta-sts` TXT lookup
 * answers NXDOMAIN (no policy), and a policy fetch could neither resolve
 * nor connect. Installed by `_preload.ts`; the MTA-STS tests install their
 * own answers and put this back afterwards. `overrides` replaces some of
 * the stubs and keeps the rest: `setMtaStsDeps` itself fills what it is not
 * given with the REAL lookups, and its `null` restores them all (#482), so a
 * test replaces some of the stubs through this helper and puts them back
 * with it, never with `null`.
 */
export function installHermeticMtaSts(overrides: Partial<MtaStsDeps> = {}): void {
  setMtaStsDeps({
    resolveTxt: notFound,
    lookup: notFound,
    fetch: () => Promise.reject(new Error("no real HTTPS in integration tests")),
    ...overrides,
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

/**
 * No real DNS for the sending IPs (#482): `MAIL_HOSTNAME` has no A or AAAA
 * record, so the dashboard's reverse DNS card and Verify's SPF check never
 * resolve the developer's real hostname. Tests of the lookups themselves
 * pass their own resolvers. Installed by `_preload.ts`.
 */
export function installHermeticSendingIps(): void {
  setSendingIpDeps({ resolve4: notFound, resolve6: notFound, reverse: notFound });
}

/**
 * The guard behind the stubs (#482): a lookup that gets past them (a seam
 * a test put back to the real resolver, with `null` or a partial override)
 * fails the test instead of waiting on a real resolver. Every server of
 * Bun's `dns` module, which our own TXT lookup reads too, becomes a fake
 * on 127.0.0.1 that answers NXDOMAIN at once and records the query; after
 * each test of every file, a recorded query or a changed server list
 * fails that test and names the lookups. The test that fails may be a
 * victim: the leak is in a hook or test that ran before it, often in an
 * earlier file. `dns.lookup` (the system resolver) is not covered.
 * Installed by `_preload.ts`, whose hooks run for every test file.
 */
export async function guardRealDns(): Promise<void> {
  const fake = await startFakeDns((query) => [buildResponse(query, { rcode: 3 })]);
  setServers([fake.server]);

  afterEach(() => {
    const escaped = fake.queries
      .splice(0)
      .map((query) => `${query.name} (type ${query.qtype})`);
    const servers = getServers();
    if (servers.length !== 1 || servers[0] !== fake.server) {
      setServers([fake.server]);
      throw new Error(
        `a test changed the DNS servers (${servers.join(", ")}): integration tests stub the lookup seams instead`,
      );
    }
    if (escaped.length > 0) {
      throw new Error(
        `real DNS lookups escaped the hermetic stubs: ${[...new Set(escaped)].join(", ")}. ` +
          "A seam was left on the real resolver (`set...Deps(null)` or a partial override) " +
          "by this test or one before it; put back the stub of test/integration/_dns-stub.ts instead",
      );
    }
  });

  afterAll(() => {
    fake.stop();
  });
}
