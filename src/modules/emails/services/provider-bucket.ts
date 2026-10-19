import { isIP } from "net";
import { organizationalDomain } from "../../domains/services/dmarc-check.service.ts";

/**
 * Provider buckets for the outbound throttle (#250).
 *
 * The per-MX lock (`withMxLock`, #91) and the rate budget
 * (`MAIL_MX_RATE_PER_MIN`, `rate-budget.ts`) used to be keyed by MX host
 * name. A large provider answers on many host names (Microsoft gives every
 * tenant its own `*.mail.protection.outlook.com` host, Google spreads
 * domains over `aspmx.l.google.com`, `alt1.aspmx.l.google.com`, ...), but
 * counts concurrent sessions and message rates per sending IP across all of
 * them. Keyed by host, BunMail opened one session per host name at once and
 * ran into `421 Too many concurrent SMTP connections` anyway. So the key is
 * the provider, derived from the MX host actually connected to:
 *
 * - `microsoft`: `outlook.com` and every host under it
 *   (`*.protection.outlook.com`, `*.olc.protection.outlook.com`);
 * - `google`: hosts under `google.com` or `googlemail.com`;
 * - `yahoo`: hosts under `yahoodns.net` (Yahoo, AOL, Verizon);
 * - `apple`: hosts under `icloud.com` (`mx01.mail.icloud.com`);
 * - an address literal (an MX given as an IP, or an implicit MX that is
 *   one): the address itself;
 * - any other host: its registrable domain, by the heuristic of the DMARC
 *   check (`organizationalDomain`, #250): `mx1.example.co.uk` and
 *   `mx2.example.co.uk` share `example.co.uk`.
 *
 * Suffixes match on label boundaries only: `evilgoogle.com` is not
 * `google`, and neither is `google.com.evil.net`. A provider's bucket has
 * no dot and a domain bucket always has one (a single-label host keeps a
 * trailing dot), so an MX host named `google` cannot join Google's bucket
 * and slow its deliveries down.
 */

/** A provider and the domains its MX hosts live under. */
interface Provider {
  bucket: string;
  suffixes: readonly string[];
}

/** The providers BunMail knows, in the order they are checked. */
const PROVIDERS: readonly Provider[] = [
  { bucket: "microsoft", suffixes: ["outlook.com"] },
  { bucket: "google", suffixes: ["google.com", "googlemail.com"] },
  { bucket: "yahoo", suffixes: ["yahoodns.net"] },
  { bucket: "apple", suffixes: ["icloud.com"] },
];

/** Whether `host` is `suffix` or a name under it (a whole-label match). */
function isUnder(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/**
 * The provider bucket of an MX host (#250), see the module comment. The
 * host is compared lowercased, without surrounding space, a trailing dot or
 * the brackets of an address literal.
 */
export function providerBucket(mxHost: string): string {
  const host = mxHost
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[(.*)\]$/, "$1");
  if (isIP(host) !== 0) return host;
  for (const provider of PROVIDERS) {
    if (provider.suffixes.some((suffix) => isUnder(host, suffix))) return provider.bucket;
  }
  const domain = organizationalDomain(host);
  /** A single-label name keeps a trailing dot, so it never equals a provider's bucket. */
  return domain.includes(".") ? domain : `${domain}.`;
}
