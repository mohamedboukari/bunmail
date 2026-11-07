import { logger } from "../../../utils/logger.ts";
import type { VerifiedTls } from "./mx-transport.ts";
import {
  matchingMxHosts,
  mtaStsCache,
  mtaStsTrustAnchors,
  type ActiveMtaStsPolicy,
} from "./mta-sts.ts";
import type { DeliveryMtaSts } from "../models/email.schema.ts";

/** The mode recorded on entries: `enforce` or `testing`, else `null` (no policy, or `none`). */
export function mtaStsModeOf(policy: ActiveMtaStsPolicy | null): DeliveryMtaSts | null {
  const mode = policy?.policy.mode;
  return mode === "enforce" || mode === "testing" ? mode : null;
}

/**
 * The MX hosts to try for `domain` under its MTA-STS policy (#250): in
 * `enforce` mode only those matching a policy pattern, in their order
 * (none: the caller retries without connecting); otherwise all of them.
 * In `testing` mode, no matching host is what enforce would have refused,
 * which is logged once per policy.
 */
export function policyHosts(
  domain: string,
  hosts: string[],
  policy: ActiveMtaStsPolicy | null,
): string[] {
  if (policy === null || policy.policy.mode === "none") return hosts;
  const matching = matchingMxHosts(hosts, policy.policy);
  if (policy.policy.mode === "testing") {
    if (matching.length === 0) {
      warnTestingPolicy(domain, policy, "no MX host matches the policy");
    }
    return hosts;
  }
  if (matching.length < hosts.length) {
    logger.debug("MX hosts outside the MTA-STS policy not tried", {
      domain,
      policyId: policy.id,
      skipped: hosts.filter((host) => !matching.includes(host)),
    });
  }
  return matching;
}

/**
 * Logs, once per domain and policy `id`, that a `testing` policy would
 * have failed this delivery in enforce mode (#250). With `TLSRPT_ENABLED`
 * the recipient domain also sees it in its TLS report (#345); the
 * operator's log is where it shows here.
 */
export function warnTestingPolicy(
  domain: string,
  policy: ActiveMtaStsPolicy,
  reason: string,
): void {
  if (!mtaStsCache().firstWarning(domain, policy.id)) return;
  logger.warn("MTA-STS testing policy would fail in enforce mode", {
    domain,
    policyId: policy.id,
    reason,
  });
}

/** Verified TLS for an enforce-mode session: the system trust store, or the test CA. */
export function verifiedTlsOptions(): VerifiedTls {
  const ca = mtaStsTrustAnchors();
  return ca === undefined ? {} : { ca };
}
