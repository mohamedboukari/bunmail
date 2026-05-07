import { and, eq, desc, gt, isNull, or, sql } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { suppressions } from "../models/suppression.schema.ts";
import { generateId } from "../../../utils/id.ts";
import { logger } from "../../../utils/logger.ts";
import { redactEmail } from "../../../utils/redact.ts";
import type {
  Suppression,
  CreateSuppressionInput,
  AddFromBounceInput,
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
 * Returns the active suppression row for a (apiKeyId, email) pair, or
 * `undefined` if the recipient is allowed to receive mail. "Active"
 * means the row exists and either has no expiry or the expiry is in
 * the future.
 *
 * Hot path — runs on every send. The composite `(api_key_id, email)`
 * index serves it; one btree probe.
 */
export async function isSuppressed(
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
 * Manual addition. Used by `POST /api/v1/suppressions`. Idempotent via
 * `ON CONFLICT (api_key_id, email) DO UPDATE` — re-suppressing an
 * address upserts the row, so a customer can update the reason or the
 * expiry without first deleting.
 *
 * The bounce-specific fields (`bounceType`, `diagnosticCode`,
 * `sourceEmailId`) are intentionally not exposed here; they're set by
 * `addFromBounce` only, so manual requests can't fabricate fake DSN
 * metadata.
 */
export async function createSuppression(
  apiKeyId: string,
  input: CreateSuppressionInput,
): Promise<Suppression> {
  const target = normaliseEmail(input.email);
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
         * Manual upserts clear bounce-specific metadata — they didn't
         * come from a DSN. Leaving stale fields would mislead operators.
         */
        bounceType: null,
        diagnosticCode: null,
        sourceEmailId: null,
      },
    })
    .returning();

  return row!;
}

/**
 * Auto-suppression hook for the future bounce path (#24). Different
 * shape from the manual `createSuppression` because we *want* the bounce
 * metadata persisted here — operators triaging a deliverability issue
 * need the diagnostic code + source email.
 *
 * Forces `reason = 'bounce'`. Idempotent — re-calling with a fresh
 * bounce updates the existing row (later bounce wins). Exported so
 * #24's DSN parser can call it directly.
 */
export async function addFromBounce(
  apiKeyId: string,
  input: AddFromBounceInput,
): Promise<Suppression> {
  const target = normaliseEmail(input.email);
  const id = generateId("sup");

  logger.info("Auto-suppressing from bounce", {
    id,
    apiKeyId,
    email: redactEmail(target),
    bounceType: input.bounceType,
    diagnosticCode: input.diagnosticCode,
  });

  const [row] = await db
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
    })
    .returning();

  return row!;
}

/**
 * Paginated list, scoped to one API key. `email` is exact-match — the
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
 * Single-row read. Scoped — a key can only fetch its own suppressions,
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
