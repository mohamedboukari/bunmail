import { sharedWindowCounter } from "../../utils/shared-store.ts";

/**
 * DNS-verify throttle (#133). `POST /dashboard/domains/:id/verify` (and
 * the DKIM rotation's complete step, which also looks up DNS) runs live
 * DNS lookups (SPF/DKIM/DMARC); the API rate-limiter only covers
 * `/api/v1/*`. A rapid click-loop (or a same-origin script) could hammer
 * the resolver, so each domain id gets at most `DNS_VERIFY_MAX` checks per
 * `DNS_VERIFY_WINDOW_MS`. Keyed by domain id, not IP: the resource
 * protected is the DNS lookup for that domain.
 *
 * A fixed window from the first check, in the shared store (#185): Redis
 * when `REDIS_URL` is set, so every replica counts against one budget per
 * domain; else process memory, one replica. Every key expires with its
 * window (the sweep drops ended ones from memory), so ids never seen
 * again, including ids of no domain at all, do not pile up.
 */

/** Most checks per domain in one window. */
const DNS_VERIFY_MAX = 5;

/** Window length. */
const DNS_VERIFY_WINDOW_MS = 60_000;

/** Checks per domain id. */
const verifyCounter = sharedWindowCounter("rl:dns-verify");

/**
 * The in-memory counts, keyed by domain id: the whole state without
 * Redis. Exported for tests; the routes go through the function below.
 */
export const dnsVerifyMap = verifyCounter.local.entries;

/**
 * Counts one DNS check for `domainId`; true when it is over the budget
 * and the caller should be throttled.
 */
export async function isDnsVerifyThrottled(domainId: string): Promise<boolean> {
  const decision = await verifyCounter.take([domainId], {
    max: DNS_VERIFY_MAX,
    windowMs: DNS_VERIFY_WINDOW_MS,
  });
  return decision.limited;
}
