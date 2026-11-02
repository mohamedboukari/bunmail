import { sharedWindowCounter } from "../../../utils/shared-store.ts";

/**
 * Per-IP connection rate limit of the inbound SMTP receiver
 * (`SMTP_RATE_LIMIT_*`, default 10 per 60 s), keyed by the raw peer
 * address, in fixed windows that start with an IP's first connection:
 * every connection counts, and one over the limit gets `421`.
 *
 * In the shared store (#185): Redis when `REDIS_URL` is set, so every
 * replica counts against one budget per IP; else process memory, one
 * replica. During a Redis outage it falls back to each replica's memory,
 * like every rate limit (see `src/utils/shared-store.ts`).
 *
 * Config-free: the limit is passed in on every call, so the unit test
 * needs no `config` mock.
 */

/** Connections per IP. */
const connectionCounter = sharedWindowCounter("rl:smtp-inbound");

/**
 * The in-memory counts, keyed by IP: the whole state without Redis.
 * Exported for tests; the receiver goes through the function below.
 */
export const inboundConnectionMap = connectionCounter.local.entries;

/**
 * Counts one connection from `ip`; true when it is over `max` in its
 * window of `windowSec`, and the connection must be refused.
 */
export async function takeInboundConnection(
  ip: string,
  max: number,
  windowSec: number,
): Promise<boolean> {
  const decision = await connectionCounter.take([ip], {
    max,
    windowMs: windowSec * 1000,
  });
  return decision.limited;
}
