import { lookup } from "dns/promises";
import { isIP } from "net";
import { isBlockedIp } from "../../../utils/ssrf-guard.ts";

/**
 * Outbound SSRF guard for direct-to-MX delivery.
 *
 * The recipient domain is chosen by the API caller, and anyone can publish
 * an MX record that points at a private, loopback or link-local address.
 * Connecting to the MX host by name would let a caller aim the server's
 * port-25 connections at its internal network, and read the result back
 * through the email's `lastError`. Checking the name and then letting
 * nodemailer resolve it again is not enough either: the caller controls
 * the DNS answer and can change it between the two lookups. So the mailer
 * resolves the host here, refuses if any address is not public, and
 * connects to the address returned (the connection is pinned to it).
 *
 * Config-free (the caller passes `allowPrivate`), and `lookup` is
 * injectable, so it unit-tests with no environment and no `mock.module`.
 */

/** Thrown when an MX host must not be connected to. */
export class BlockedMxError extends Error {
  override readonly name = "BlockedMxError";
}

/** A DNS lookup returning every address for a host. */
export type LookupAll = (host: string) => Promise<{ address: string }[]>;

const lookupAll: LookupAll = (host) => lookup(host, { all: true });

/**
 * Resolves an MX host to the address to connect to.
 *
 * @param mxHost - The MX exchange name from DNS
 * @param options.allowPrivate - Operator opt-out (`MAIL_ALLOW_PRIVATE_MX`)
 * @param options.lookup - DNS lookup, injectable for tests
 * @returns The address to connect to (IPv4 preferred, as nodemailer does:
 *   receivers such as Gmail are stricter about reverse DNS over IPv6);
 *   every resolved address was checked
 * @throws BlockedMxError for a null MX, an unresolvable host, or any
 *   non-public address (unless `allowPrivate`)
 */
export async function resolveMxAddress(
  mxHost: string,
  options: { allowPrivate: boolean; lookup?: LookupAll },
): Promise<string> {
  /** RFC 7505 null MX ("." , which resolves to an empty exchange): the
   *  domain accepts no mail. Never fall back to a default host. */
  const host = mxHost.trim().replace(/\.$/, "");
  if (!host) throw new BlockedMxError("Domain publishes a null MX: it accepts no mail.");

  const addresses = isIP(host)
    ? [{ address: host }]
    : await (options.lookup ?? lookupAll)(host).catch(() => {
        throw new BlockedMxError(`MX host "${host}" could not be resolved.`);
      });
  const chosen = addresses.find(({ address }) => isIP(address) === 4) ?? addresses[0];
  if (!chosen) throw new BlockedMxError(`MX host "${host}" resolved to no addresses.`);

  if (!options.allowPrivate && addresses.some(({ address }) => isBlockedIp(address))) {
    /** Deliberately no address in the message: it is stored in `lastError`
     *  and returned to the caller. */
    throw new BlockedMxError(
      `MX host "${host}" resolves to a non-public address; refusing to deliver.`,
    );
  }

  return chosen.address;
}
