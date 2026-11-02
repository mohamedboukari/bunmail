/**
 * The email queue's public surface (#380). The code lives in one file per
 * concern, beside this one:
 *
 *   - `queue-worker.service.ts`: the poll loop, its state and the send slots
 *   - `queue-claim.service.ts`: the fair claim, the lease and the fenced row release
 *   - `queue-send.service.ts`: one claimed email's send attempt
 *   - `queue-domain.service.ts`: the sender domain's DKIM key and unsubscribe settings
 *   - `queue-outcome.service.ts`: the outcome transaction, bounces and events
 *   - `queue-decision.service.ts`: the deferred, retry or terminal decision
 *
 * Importers keep using this module.
 */
export type { DomainLookupRow } from "./queue-domain.service.ts";
export { resolveDomainForEmail } from "./queue-domain.service.ts";
export { start, stop, runQueueCycle } from "./queue-worker.service.ts";
export { claimNextEmails, releaseOwnLeases } from "./queue-claim.service.ts";
export { exhaustedSoftBounces } from "./queue-outcome.service.ts";
