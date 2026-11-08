import { and, eq, desc, gt, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { db, type DbExecutor } from "../../../db/index.ts";
import { suppressions } from "../models/suppression.schema.ts";
import { generateId } from "../../../utils/id.ts";
import { logger } from "../../../utils/logger.ts";
import { redactEmail } from "../../../utils/redact.ts";
import { config } from "../../../config.ts";
import type {
  Suppression,
  CreateSuppressionInput,
  AddFromBounceInput,
  AddFromUnsubscribeInput,
  AddFromComplaintInput,
} from "../types/suppression.types.ts";

/**
 * Lower-cases an address so the unique constraint behaves intuitively
 * (`Alice@Example.com` and `alice@example.com` are the same recipient).
 * RFC 5321 says the local part is technically case-sensitive, but
 * essentially every modern receiver folds case, and matching that
 * behaviour at suppression time avoids surprise bypasses.
 */
function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * How long a soft-bounce suppression lasts (#24, #250): an async soft DSN,
 * or a `4.2.2` mailbox-full reply that outlasted the retry window.
 */
export const SOFT_BOUNCE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Returns the active suppression row for a (apiKeyId, email) pair, or
 * `undefined` if the key has none. "Active" means the row exists and
 * either has no expiry or the expiry is in the future.
 *
 * The key's own list only: the bounce handler reads it to escalate a
 * repeated soft bounce. Send gates use {@link isSuppressed}, which may
 * also apply the shared hard suppressions.
 *
 * The composite `(api_key_id, email)` index serves it; one btree probe.
 */
export async function findActiveSuppression(
  apiKeyId: string,
  email: string,
): Promise<Suppression | undefined> {
  const target = normaliseEmail(email);
  const now = new Date();

  const [row] = await db
    .select()
    .from(suppressions)
    .where(
      and(
        eq(suppressions.apiKeyId, apiKeyId),
        eq(suppressions.email, target),
        /** Either permanent (expires_at IS NULL) or not yet expired. */
        or(isNull(suppressions.expiresAt), gt(suppressions.expiresAt, now)),
      ),
    )
    .limit(1);

  return row;
}

/**
 * Why the send gate refused an address: the key's own suppression, or a
 * shared one (`SUPPRESSIONS_SHARED_HARD`, #250). A shared match carries
 * nothing about the row behind it, so no caller can reveal another key's
 * suppression, its id or its reason.
 */
export type SuppressionMatch =
  { shared: false; suppression: Suppression } | { shared: true };

/**
 * The condition behind {@link hasSharedHardSuppression}: a row of ANY API
 * key that holds an automatic permanent hard-bounce or verified complaint
 * suppression for `target` (already normalised). Exported so a test can
 * EXPLAIN the lookup.
 *
 * Only rows the automatic paths wrote count, never a tenant's own
 * decision: a hard bounce carries `bounce_type = 'hard'` (a manual row
 * never has a bounce type), and a complaint counts only when its report
 * was **verified** (`complaint_verified`, see `isVerifiedReport`): the
 * tenant that sent an email knows its Message-ID, so an unverified report
 * proves nothing beyond its own key, and a manual row is never verified.
 * Unsubscribe, manual, unverified-complaint and temporary rows never count.
 *
 * The predicates are literals, not parameters, so the planner can match
 * the partial index `suppressions_shared_hard_email_idx` in every plan.
 */
export function sharedHardSuppressionWhere(target: string): SQL | undefined {
  return and(
    eq(suppressions.email, target),
    sql`${suppressions.expiresAt} IS NULL`,
    sql`${suppressions.reason} IN ('bounce', 'complaint')`,
    sql`((${suppressions.reason} = 'bounce' AND ${suppressions.bounceType} = 'hard') OR (${suppressions.reason} = 'complaint' AND ${suppressions.complaintVerified} = true))`,
  );
}

/** Whether the shared gate (#250) refuses `target`, see {@link sharedHardSuppressionWhere}. */
async function hasSharedHardSuppression(target: string): Promise<boolean> {
  const [row] = await db
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(sharedHardSuppressionWhere(target))
    .limit(1);
  return row !== undefined;
}

/**
 * The send gate (#25): whether mail to `email` under `apiKeyId` must be
 * refused. Used by `createEmail` (the REST API and SMTP submission) and by
 * the queue's re-check before a retry (#262).
 *
 * 1. The key's own active suppression ({@link findActiveSuppression}), of
 *    any reason.
 * 2. With `SUPPRESSIONS_SHARED_HARD=true` (#250), an automatic permanent
 *    hard bounce or verified complaint under ANY key (see
 *    {@link hasSharedHardSuppression}): the sending IP and DKIM domains
 *    are shared, so one key's bad list must not damage every key's
 *    delivery. Logged at `info` with the requesting key and the redacted
 *    address only; the match names no row.
 *
 * Hot path: runs on every send, one index probe per step.
 */
export async function isSuppressed(
  apiKeyId: string,
  email: string,
): Promise<SuppressionMatch | undefined> {
  const own = await findActiveSuppression(apiKeyId, email);
  if (own) return { shared: false, suppression: own };
  if (!config.suppressions.sharedHard) return undefined;

  const target = normaliseEmail(email);
  if (!(await hasSharedHardSuppression(target))) return undefined;
  logger.info("Shared suppression applied", {
    apiKeyId,
    email: redactEmail(target),
  });
  return { shared: true };
}

/**
 * The row on file for `(apiKeyId, email)`, expired or not. Used after an
 * upsert left an existing row in place, to report the suppression in effect.
 */
async function findRow(
  apiKeyId: string,
  email: string,
  executor: DbExecutor = db,
): Promise<Suppression | undefined> {
  const [row] = await executor
    .select()
    .from(suppressions)
    .where(and(eq(suppressions.apiKeyId, apiKeyId), eq(suppressions.email, email)))
    .limit(1);
  return row;
}

/**
 * Manual addition. Used by `POST /api/v1/suppressions`. Idempotent via
 * `ON CONFLICT (api_key_id, email) DO UPDATE`: re-suppressing an
 * address upserts the row, so a customer can update the reason or the
 * expiry without first deleting.
 *
 * Except over a permanent `complaint` (#191): a complaint is the
 * strongest reason, so a manual upsert leaves it exactly as it is and
 * returns it. Lifting a complaint takes a deliberate DELETE first.
 *
 * The bounce-specific fields (`bounceType`, `diagnosticCode`,
 * `sourceEmailId`) are intentionally not exposed here; they're set by
 * `addFromBounce` only, so manual requests can't fabricate fake DSN
 * metadata.
 *
 * @returns The suppression in effect: the written row, or the permanent
 *   complaint left in place.
 */
export async function createSuppression(
  apiKeyId: string,
  input: CreateSuppressionInput,
): Promise<Suppression> {
  const target = normaliseEmail(input.email);

  /**
   * Two attempts: the upsert either writes a row or finds a permanent
   * complaint to return. Only when that complaint is deleted between the
   * two statements does the second attempt run, and it then inserts.
   */
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const id = generateId("sup");

    logger.info("Creating suppression", {
      id,
      apiKeyId,
      email: redactEmail(target),
      reason: input.reason,
    });

    const [row] = await db
      .insert(suppressions)
      .values({
        id,
        apiKeyId,
        email: target,
        reason: input.reason,
        expiresAt: input.expiresAt ?? null,
      })
      .onConflictDoUpdate({
        target: [suppressions.apiKeyId, suppressions.email],
        set: {
          reason: input.reason,
          expiresAt: input.expiresAt ?? null,
          /**
           * Manual upserts clear bounce-specific metadata: they didn't
           * come from a DSN. Leaving stale fields would mislead operators.
           */
          bounceType: null,
          diagnosticCode: null,
          sourceEmailId: null,
          /** Nor is it a verified feedback-loop complaint. */
          complaintVerified: false,
        },
        /** A permanent complaint is never replaced (#191). */
        setWhere: or(
          isNotNull(suppressions.expiresAt),
          ne(suppressions.reason, "complaint"),
        ),
      })
      .returning();
    if (row) return row;

    const kept = await findRow(apiKeyId, target);
    if (kept) {
      logger.info("Manual suppression left a permanent complaint in place", {
        id: kept.id,
        apiKeyId,
        email: redactEmail(target),
      });
      return kept;
    }
  }
  throw new Error("Suppression could not be written");
}

/** What a bounce did to the suppression list (#191). */
export interface BounceSuppressionResult {
  /** True when the row was created, or a temporary one was rewritten. */
  applied: boolean;
  /**
   * The suppression in effect for the address afterwards: the written
   * row, or the permanent one left in place. `undefined` only when that
   * row was deleted between the write and the read-back.
   */
  suppression: Suppression | undefined;
}

/**
 * Auto-suppression from a bounce: the async DSN path (#24) and inline
 * hard 5xx during the send (#68). Different shape from the manual
 * `createSuppression` because we *want* the bounce metadata persisted
 * here: operators triaging a deliverability issue need the diagnostic
 * code + source email.
 *
 * A bounce never weakens a suppression (#191). With no row on file it
 * inserts one (`reason = 'bounce'`). On conflict it only touches a
 * **temporary** row (`expires_at IS NOT NULL`, expired or not): a soft
 * bounce refreshes the backoff window, a hard bounce makes it a permanent
 * bounce. A **permanent** row of any reason (complaint, unsubscribe,
 * manual, an earlier hard bounce) is left exactly as it is; otherwise a
 * late soft bounce could turn a complaint into a 24-hour entry that
 * lapses. The check and the write are one statement, so it is race-safe.
 *
 * @param executor The transaction that also enqueues `email.bounced` (#184).
 */
export async function addFromBounce(
  apiKeyId: string,
  input: AddFromBounceInput,
  executor: DbExecutor = db,
): Promise<BounceSuppressionResult> {
  const target = normaliseEmail(input.email);
  const id = generateId("sup");

  const [row] = await executor
    .insert(suppressions)
    .values({
      id,
      apiKeyId,
      email: target,
      reason: "bounce",
      bounceType: input.bounceType,
      diagnosticCode: input.diagnosticCode ?? null,
      sourceEmailId: input.sourceEmailId ?? null,
      expiresAt: input.expiresAt ?? null,
    })
    .onConflictDoUpdate({
      target: [suppressions.apiKeyId, suppressions.email],
      set: {
        reason: "bounce",
        bounceType: input.bounceType,
        diagnosticCode: input.diagnosticCode ?? null,
        sourceEmailId: input.sourceEmailId ?? null,
        expiresAt: input.expiresAt ?? null,
      },
      /** Only a temporary row is rewritten; a permanent one stays. */
      setWhere: isNotNull(suppressions.expiresAt),
    })
    .returning();

  const suppression = row ?? (await findRow(apiKeyId, target, executor));

  logger.info("Auto-suppressing from bounce", {
    id: suppression?.id ?? null,
    apiKeyId,
    email: redactEmail(target),
    bounceType: input.bounceType,
    diagnosticCode: input.diagnosticCode,
    outcome: row ? "suppressed" : "permanent-kept",
    keptReason: row ? undefined : suppression?.reason,
  });

  return { applied: row !== undefined, suppression };
}

/**
 * Suppression from an unsubscribe request (#249): the one-click POST, the
 * confirmation page or the `unsub+<token>` mailto, each verified against
 * its token before this runs. Permanent, `reason = 'unsubscribe'`, scoped
 * to the key the email was sent with.
 *
 * Idempotent, and never weakens an entry: a permanent suppression already
 * on file for the key and address (a hard bounce, a complaint, a manual
 * entry, an earlier unsubscribe) is left exactly as it is. A temporary
 * one (a soft-bounce backoff with `expires_at`) is turned into the
 * permanent unsubscribe, since it would otherwise lapse and mail would
 * resume.
 *
 * @returns The row when this call created it or made it a permanent
 *   unsubscribe (the caller fires `email.unsubscribed` then), `undefined`
 *   when it was already permanent (a repeated request).
 * @param executor The transaction that also enqueues `email.unsubscribed` (#184).
 */
export async function addFromUnsubscribe(
  input: AddFromUnsubscribeInput,
  executor: DbExecutor = db,
): Promise<Suppression | undefined> {
  const target = normaliseEmail(input.email);

  const [row] = await executor
    .insert(suppressions)
    .values({
      id: generateId("sup"),
      apiKeyId: input.apiKeyId,
      email: target,
      reason: "unsubscribe",
      sourceEmailId: input.emailId,
      expiresAt: null,
    })
    .onConflictDoUpdate({
      target: [suppressions.apiKeyId, suppressions.email],
      set: {
        reason: "unsubscribe",
        bounceType: null,
        diagnosticCode: null,
        sourceEmailId: input.emailId,
        expiresAt: null,
      },
      /** Only a temporary entry is replaced; a permanent one stays. */
      setWhere: isNotNull(suppressions.expiresAt),
    })
    .returning();

  logger.info("Unsubscribe request processed", {
    emailId: input.emailId,
    apiKeyId: input.apiKeyId,
    email: redactEmail(target),
    source: input.source,
    outcome: row ? "suppressed" : "already-suppressed",
  });

  return row;
}

/**
 * Suppression from a feedback-loop complaint (#191): a recipient marked an
 * email as spam and their mailbox provider sent an ARF report, linked to
 * that email by its Message-ID before this runs. Permanent,
 * `reason = 'complaint'`, scoped to the key the email was sent with.
 *
 * A complaint is the strongest reason, so it takes precedence: it creates
 * the row, turns a temporary one (a soft-bounce backoff, or a manual entry
 * with an expiry) into a permanent complaint, and replaces any other
 * permanent reason (`bounce`, `unsubscribe`, `manual`). Only a permanent
 * `complaint` already on file is left as it is, which makes a repeated
 * report a no-op. The check and the write are one statement, so two
 * reports racing each other change the row once.
 *
 * `complaint_verified` (only verified complaints are shared, see
 * {@link sharedHardSuppressionWhere}) only goes up: `existing OR new`. A
 * verified report about an unverified permanent complaint upgrades it in a
 * second statement, which is not a change (no second event).
 *
 * @returns The row when this call created or changed it (the caller fires
 *   `email.complained` then), `undefined` when the address already had a
 *   permanent complaint suppression (its flag possibly upgraded).
 * @param executor The transaction that also enqueues `email.complained` (#184).
 */
export async function addFromComplaint(
  input: AddFromComplaintInput,
  executor: DbExecutor = db,
): Promise<Suppression | undefined> {
  const target = normaliseEmail(input.email);

  const [row] = await executor
    .insert(suppressions)
    .values({
      id: generateId("sup"),
      apiKeyId: input.apiKeyId,
      email: target,
      reason: "complaint",
      sourceEmailId: input.emailId,
      expiresAt: null,
      complaintVerified: input.verified,
    })
    .onConflictDoUpdate({
      target: [suppressions.apiKeyId, suppressions.email],
      set: {
        reason: "complaint",
        bounceType: null,
        diagnosticCode: null,
        sourceEmailId: input.emailId,
        expiresAt: null,
        /** Never downgraded: the row's flag OR this report's. */
        complaintVerified: sql`${suppressions.complaintVerified} OR excluded.complaint_verified`,
      },
      /** Everything but a permanent complaint is replaced. */
      setWhere: or(
        isNotNull(suppressions.expiresAt),
        ne(suppressions.reason, "complaint"),
      ),
    })
    .returning();

  /** A permanent complaint was on file: a verified report upgrades its flag. */
  let upgraded = false;
  if (!row && input.verified) {
    const lifted = await executor
      .update(suppressions)
      .set({ complaintVerified: true })
      .where(
        and(
          eq(suppressions.apiKeyId, input.apiKeyId),
          eq(suppressions.email, target),
          eq(suppressions.reason, "complaint"),
          isNull(suppressions.expiresAt),
          eq(suppressions.complaintVerified, false),
        ),
      )
      .returning({ id: suppressions.id });
    upgraded = lifted.length > 0;
  }

  logger.info("Complaint suppression processed", {
    emailId: input.emailId,
    apiKeyId: input.apiKeyId,
    email: redactEmail(target),
    verified: input.verified,
    outcome: row ? "suppressed" : upgraded ? "verified-upgrade" : "already-complained",
  });

  return row;
}

/**
 * Paginated list, scoped to one API key. `email` is exact-match: the
 * indexed lookup serves both the gate and this query path.
 */
export async function listSuppressions(
  apiKeyId: string,
  filters: { page: number; limit: number; email?: string },
): Promise<{ data: Suppression[]; total: number }> {
  const offset = (filters.page - 1) * filters.limit;
  const conditions = [eq(suppressions.apiKeyId, apiKeyId)];
  if (filters.email) {
    conditions.push(eq(suppressions.email, normaliseEmail(filters.email)));
  }
  const where = and(...conditions);

  const [data, totalRows] = await Promise.all([
    db
      .select()
      .from(suppressions)
      .where(where)
      .orderBy(desc(suppressions.createdAt))
      .limit(filters.limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(suppressions)
      .where(where),
  ]);

  return { data, total: totalRows[0]?.count ?? 0 };
}

/**
 * Single-row read. Scoped: a key can only fetch its own suppressions,
 * just like every other module's read paths.
 */
export async function getSuppressionById(
  id: string,
  apiKeyId: string,
): Promise<Suppression | undefined> {
  const [row] = await db
    .select()
    .from(suppressions)
    .where(and(eq(suppressions.id, id), eq(suppressions.apiKeyId, apiKeyId)))
    .limit(1);
  return row;
}

/**
 * Hard delete. Scoped to the calling key. Returns the deleted row so
 * the plugin can serialise it back, or `undefined` when nothing matched
 * (the plugin maps that to 404).
 */
export async function deleteSuppression(
  id: string,
  apiKeyId: string,
): Promise<Suppression | undefined> {
  const [row] = await db
    .delete(suppressions)
    .where(and(eq(suppressions.id, id), eq(suppressions.apiKeyId, apiKeyId)))
    .returning();
  return row;
}

/* The unscoped dashboard variants (#89) are in `suppression-unscoped.service.ts`. */
