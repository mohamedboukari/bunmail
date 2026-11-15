import {
  MtaStsFetchError,
  parseMtaStsTxt,
  type MtaStsPolicy,
} from "../../emails/services/mta-sts.ts";
import type { Domain } from "../types/domain.types.ts";
import type { DnsCheckOutcome } from "../types/domain-check.types.ts";
import {
  mtaStsPolicyUrl,
  servedMtaStsPolicy,
  type MtaStsPolicySettings,
  type ServedMtaStsPolicy,
} from "./mta-sts-served-policy.ts";

/**
 * The MTA-STS check of Verify (#472): for a domain whose mode is not
 * `none`, whether senders can find and fetch the policy BunMail serves.
 *
 * 1. The TXT record at `_mta-sts.<domain>` announces exactly one valid
 *    `v=STSv1` policy whose `id` is the current one.
 * 2. `https://mta-sts.<domain>/.well-known/mta-sts.txt`, fetched the way
 *    a sender does (`fetchMtaStsPolicy`: verified certificate for the
 *    host, no redirects, `text/plain`, parsed strictly), returns the same
 *    mode, `mx` patterns and `max_age`. This reaches BunMail through the
 *    public DNS and the reverse proxy, so it also proves the certificate
 *    and the proxy's `Host` forwarding.
 *
 * Its own status, never part of the domain's verification: a failure here
 * never fails SPF, DKIM or DMARC, nor flips the domain. A failed TXT
 * lookup is `unknown`; everything else that is not right is `fail`.
 */

/** The TXT lookup and the policy fetch, replaceable in tests. */
export interface MtaStsCheckDeps {
  resolveTxt: (hostname: string) => Promise<string[][]>;
  /** Fetches and parses `domain`'s policy as a sender does, or throws `MtaStsFetchError`. */
  fetchPolicy: (domain: string) => Promise<MtaStsPolicy>;
}

/** DNS answers meaning "no such record", as opposed to a failed lookup. */
const NO_RECORD_CODES = new Set(["ENOTFOUND", "ENODATA"]);

/** The `code` of a DNS error, or an empty string. */
function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error
    ? String(Reflect.get(error, "code"))
    : "";
}

/** What the TXT lookup found: the announced id, none, or a failed lookup. */
type TxtFinding = { kind: "id"; id: string } | { kind: "none" } | { kind: "error" };

async function announcedId(host: string, deps: MtaStsCheckDeps): Promise<TxtFinding> {
  try {
    const id = parseMtaStsTxt(await deps.resolveTxt(host));
    return id === null ? { kind: "none" } : { kind: "id", id };
  } catch (error) {
    return NO_RECORD_CODES.has(errorCode(error)) ? { kind: "none" } : { kind: "error" };
  }
}

/** What the fetch found: the policy, or why there is none. */
type FetchFinding =
  { kind: "policy"; policy: MtaStsPolicy } | { kind: "error"; reason: string };

async function fetchedPolicy(name: string, deps: MtaStsCheckDeps): Promise<FetchFinding> {
  try {
    return { kind: "policy", policy: await deps.fetchPolicy(name) };
  } catch (error) {
    if (!(error instanceof MtaStsFetchError)) {
      return { kind: "error", reason: "the fetch failed" };
    }
    if (error.kind === "webpki-invalid") {
      return {
        kind: "error",
        reason: `the certificate is not valid for mta-sts.${name}`,
      };
    }
    /** BunMail's own messages: HTTP status, content type, address problems. */
    return { kind: "error", reason: error.message };
  }
}

/** True when `fetched` says what `expected` says (patterns compared as sets). */
function samePolicy(fetched: MtaStsPolicy, expected: ServedMtaStsPolicy): boolean {
  const want = expected.mx.toSorted().join(",");
  const got = [...new Set(fetched.mx)].toSorted().join(",");
  return (
    fetched.mode === expected.mode && fetched.maxAge === expected.maxAge && got === want
  );
}

/**
 * Checks `domain`'s MTA-STS setup, or returns `null` when its mode is
 * `none` (nothing to check). Never rejects.
 */
export async function checkMtaSts(
  domain: Pick<Domain, "name"> & Partial<Pick<Domain, "mtaStsMode" | "verifiedAt">>,
  deps: MtaStsCheckDeps,
  settings?: MtaStsPolicySettings,
): Promise<DnsCheckOutcome | null> {
  const mode = domain.mtaStsMode ?? "none";
  if (mode === "none") return null;
  const expected = servedMtaStsPolicy(mode, settings);
  const host = `_mta-sts.${domain.name}`;
  const [txt, fetched] = await Promise.all([
    announcedId(host, deps),
    fetchedPolicy(domain.name, deps),
  ]);

  if (txt.kind === "error") {
    return {
      status: "unknown",
      reason: `DNS lookup of ${host} failed (temporary): try again later`,
    };
  }
  if (txt.kind === "none") {
    return {
      status: "fail",
      reason: `No valid MTA-STS record at ${host}: publish exactly one TXT record v=STSv1; id=${expected.id}`,
    };
  }
  if (txt.id !== expected.id) {
    return {
      status: "fail",
      reason: `The record at ${host} announces another policy id: update it to id=${expected.id}`,
    };
  }
  const url = mtaStsPolicyUrl(domain.name);
  if (fetched.kind === "error") {
    const unverified =
      domain.verifiedAt === null
        ? " BunMail serves the policy only while the domain is verified: verify again once it is."
        : "";
    return {
      status: "fail",
      reason: `${url} could not be fetched as a sender does: ${fetched.reason}.${unverified}`,
    };
  }
  if (!samePolicy(fetched.policy, expected)) {
    return {
      status: "fail",
      reason: `${url} serves another policy than BunMail's (a cache, or another server?)`,
    };
  }
  return {
    status: "pass",
    reason: `The ${mode} policy is announced and served at ${url}`,
  };
}
