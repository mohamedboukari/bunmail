import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { logger } from "../../../utils/logger.ts";
import { recordAuditEvent } from "../../audit/services/audit.service.ts";
import type { AuditContext } from "../../audit/types/audit.types.ts";
import { forgetTrackingEpoch } from "../../tracking/services/tracking-epoch.service.ts";
import { MAX_TRACKING_EPOCH } from "../../tracking/services/tracking-token.ts";
import { TrackingEpochExhaustedError } from "../errors.ts";
import { domains } from "../models/domain.schema.ts";
import type { Domain } from "../types/domain.types.ts";

/**
 * Revokes every click tracking link already sent from a domain (#424):
 * bumps `domains.tracking_epoch`, which every click token's MAC covers,
 * so the redirect refuses links of the old epoch (and links from before
 * #424, which count as epoch 0). Links minted afterwards, including by a
 * retry of mail still queued, carry the new epoch and work. Open pixels
 * are not affected: they redirect nowhere.
 *
 * The bump and its `domain.tracking_links_revoked` audit event commit
 * together. This process stops redirecting the old links at once (the
 * cached epoch is dropped after the commit); another replica within
 * `TRACKING_EPOCH_TTL_MS` (30 s). Returns the updated domain, or
 * `undefined` when there is none with that id. Throws
 * `TrackingEpochExhaustedError` (409) when the epoch is already at its
 * highest value; nothing changes.
 */
export async function revokeTrackingLinks(
  id: string,
  audit: AuditContext,
): Promise<Domain | undefined> {
  const domain = await db.transaction(async (tx) => {
    const [changed] = await tx
      .update(domains)
      .set({ trackingEpoch: sql`${domains.trackingEpoch} + 1`, updatedAt: new Date() })
      .where(and(eq(domains.id, id), lt(domains.trackingEpoch, MAX_TRACKING_EPOCH)))
      .returning();
    if (changed === undefined) {
      /** No row updated: an unknown domain, or one already at the highest epoch. */
      const [existing] = await tx
        .select({ id: domains.id })
        .from(domains)
        .where(eq(domains.id, id));
      if (existing !== undefined) {
        logger.warn("Tracking links not revoked: epoch at its highest value", {
          domainId: id,
        });
        throw new TrackingEpochExhaustedError();
      }
      return undefined;
    }
    await recordAuditEvent(
      {
        ...audit,
        action: "domain.tracking_links_revoked",
        target: { type: "domain", id, label: changed.name },
        metadata: { epoch: changed.trackingEpoch },
      },
      tx,
    );
    return changed;
  });

  if (domain === undefined) {
    logger.warn("Tracking links not revoked: domain not found", { domainId: id });
    return undefined;
  }
  forgetTrackingEpoch(id);
  logger.info("Tracking links revoked", { domainId: id, epoch: domain.trackingEpoch });
  return domain;
}
