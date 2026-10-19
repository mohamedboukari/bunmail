import { eq } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { config } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";
import { enqueueEvent } from "../../webhooks/services/webhook-dispatch.service.ts";
import { domains } from "../models/domain.schema.ts";
import type { Domain } from "../types/domain.types.ts";
import type { DomainCheckResult } from "../types/domain-check.types.ts";
import {
  nextDomainCheckState,
  type DomainCheckTransition,
} from "./domain-check-state.ts";

/**
 * Stores the result of one DNS check of a domain (#250), by Verify or the
 * re-verification loop, following the state machine of
 * `domain-check-state.ts`.
 *
 * One transaction locks the row, reads its current state (not the copy the
 * caller had before its DNS lookups, which may be stale), writes the next
 * state, the check time and result and the next check, and enqueues the
 * webhook event of a flip or a recovery through the outbox (#184): the
 * state change and its event commit together or not at all. Both events go
 * to admin keys' webhooks only (`{ adminOnly: true }`): a domain has no
 * owning API key and managing domains is admin-only (#130), like
 * `email.received`.
 */

/** A stored check: the updated row and what changed. */
export interface AppliedDomainCheck {
  domain: Domain;
  transition: DomainCheckTransition;
}

/** Hours to milliseconds. */
const HOUR_MS = 60 * 60 * 1000;

/**
 * Applies `result` to the domain `domainId`. Returns undefined when the
 * domain no longer exists (deleted during the lookups).
 */
export async function applyDomainCheck(
  domainId: string,
  result: DomainCheckResult,
  now: Date = new Date(),
  intervalMs: number = config.domainReverify.intervalHours * HOUR_MS,
): Promise<AppliedDomainCheck | undefined> {
  const applied = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(domains)
      .where(eq(domains.id, domainId))
      .for("update");
    if (!row) return undefined;

    const transition = nextDomainCheckState(row, result, now, intervalMs);
    const [updated] = await tx
      .update(domains)
      .set({
        ...transition.next,
        lastCheckedAt: now,
        nextCheckAt: transition.nextCheckAt,
        lastCheckResult: result,
        updatedAt: now,
      })
      .where(eq(domains.id, domainId))
      .returning();
    if (!updated) return undefined;

    if (transition.event === "failed") {
      await enqueueEvent(
        tx,
        "domain.verification_failed",
        {
          domainId,
          domain: row.name,
          failedChecks: transition.failedChecks,
          checkedAt: result.checkedAt,
        },
        { adminOnly: true },
      );
    } else if (transition.event === "verified") {
      await enqueueEvent(
        tx,
        "domain.verified",
        { domainId, domain: row.name, checkedAt: result.checkedAt },
        { adminOnly: true },
      );
    }
    return { domain: updated, transition };
  });

  if (applied?.transition.event === "failed") {
    logger.warn("Domain verification failed: verifiedAt cleared", {
      domainId,
      domain: applied.domain.name,
      failedChecks: applied.transition.failedChecks,
      consecutiveFailures: applied.domain.consecutiveFailures,
    });
  } else if (applied?.transition.event === "verified") {
    logger.info("Domain verified: every DNS check passes", {
      domainId,
      domain: applied.domain.name,
    });
  }
  return applied;
}
