import { isIP } from "net";
import { isBlockedIp } from "../../../utils/ssrf-guard.ts";
import type { LookupAll } from "./mx-address.ts";
import { withTimeout } from "./mx-route.ts";
import { MTA_STS_POLICY_MAX_BYTES } from "./mta-sts-policy.ts";

/**
 * The MTA-STS policy fetch's seams and steps (#250): the replaceable
 * lookups and fetch, the fetch error, the policy host's address check
 * and the capped body read. `fetchMtaStsPolicy` itself is in
 * `mta-sts.ts`, beside the replaceable deps it defaults to.
 */

/** The lookups, the fetch and the clock, replaceable in tests. */
export interface MtaStsDeps {
  resolveTxt: (name: string) => Promise<string[][]>;
  /** Address lookup of `mta-sts.<domain>`. */
  lookup: LookupAll;
  /** Bun's fetch: `tls`, `decompress` and `redirect: "manual"` are used. */
  fetch: (url: string, init: BunFetchRequestInit) => Promise<Response>;
  /** HTTPS port of the policy host: 443. Tests point it at a local server. */
  httpsPort: number;
  /**
   * Trust anchors (PEM) instead of the system store, for the policy fetch
   * and for verified SMTP TLS in enforce mode. Tests only: production
   * leaves it unset.
   */
  ca?: string;
  fetchTimeoutMs: number;
  dnsTimeoutMs: number;
  now: () => number;
}

/* ─── Policy fetch ─── */

/** Thrown when a policy could not be fetched or is invalid. */
export class MtaStsFetchError extends Error {
  override readonly name = "MtaStsFetchError";
}

/**
 * Resolves the policy host to the one address to connect to: refused when
 * it resolves to nothing, or when any address is not public (the MX
 * address rule, `resolveMxAddresses`) unless `allowPrivate`; a scoped
 * address (zone id) is always refused. IPv4 first.
 */
export async function policyAddress(
  host: string,
  allowPrivate: boolean,
  policyDeps: MtaStsDeps,
): Promise<string> {
  let addresses: { address: string }[];
  try {
    addresses = await withTimeout(policyDeps.lookup(host), policyDeps.dnsTimeoutMs);
  } catch {
    throw new MtaStsFetchError(`policy host ${host} could not be resolved`);
  }
  if (addresses.length === 0) {
    throw new MtaStsFetchError(`policy host ${host} resolved to no addresses`);
  }
  if (
    addresses.some(
      ({ address }) =>
        address.includes("%") ||
        isIP(address) === 0 ||
        (!allowPrivate && isBlockedIp(address)),
    )
  ) {
    /** No address in the message: it is logged with the domain. */
    throw new MtaStsFetchError(`policy host ${host} resolves to a non-public address`);
  }
  const chosen = addresses.find(({ address }) => isIP(address) === 4) ?? addresses[0];
  if (!chosen) throw new MtaStsFetchError(`policy host ${host} resolved to no addresses`);
  return chosen.address;
}

/** Reads at most {@link MTA_STS_POLICY_MAX_BYTES} of the body as UTF-8, or throws. */
export async function readPolicyBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MTA_STS_POLICY_MAX_BYTES) {
        throw new MtaStsFetchError(
          `policy larger than ${MTA_STS_POLICY_MAX_BYTES} bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new MtaStsFetchError("policy is not valid UTF-8");
  }
}
