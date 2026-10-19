import { and, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { config } from "../../../config.ts";
import { generateId } from "../../../utils/id.ts";
import { idempotencyKeys } from "../models/idempotency-key.schema.ts";
import type { DbExecutor, JsonObject, SendEmailInput, Tx } from "../types/email.types.ts";

/**
 * Storage side of idempotency keys on the send API (#188): request
 * hashing, the claiming upsert, completion and the expiry purge. The
 * send flow that ties them to the email insert is `createEmailIdempotent`
 * in `email.service.ts`.
 *
 * Never logs or returns the key itself: it is caller-chosen and may
 * carry identifiers from the caller's system.
 */

/** Rows per purge delete, and how many batches one purge pass runs at most. */
const PURGE_BATCH_SIZE = 5000;
const PURGE_MAX_BATCHES = 100;

/** A stored idempotency key, as the send flow reads it. */
export type IdempotencyRecord = typeof idempotencyKeys.$inferSelect;

/**
 * Canonical JSON of a value: object keys sorted (by UTF-16 code unit),
 * `undefined` members dropped, arrays in order, no whitespace. Two bodies
 * that are the same JSON with keys in another order give the same string.
 * Built as a string, never as an intermediate object, so a `__proto__`
 * key (allowed in `variables` and `headers`) is kept like any other.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    return `[${items.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries: [string, unknown][] = Object.entries(value);
    const members = entries
      .filter(([, member]) => member !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, member]) => `${JSON.stringify(name)}:${canonicalJson(member)}`);
    return `{${members.join(",")}}`;
  }
  /** `JSON.stringify` gives `undefined` for `undefined` (an array hole): JSON says null. */
  return JSON.stringify(value) ?? "null";
}

/**
 * SHA-256 hex of the canonical JSON of a validated send body: what
 * `request_hash` stores and a retry is compared against.
 */
export function hashSendRequest(input: SendEmailInput): string {
  return new Bun.CryptoHasher("sha256").update(canonicalJson(input)).digest("hex");
}

/**
 * The JSON a response body serializes to (dates become ISO strings), as
 * stored in `response_body` and returned on the first request, so the
 * first response and every replay are the same JSON value (jsonb may
 * store the members in another order).
 */
export function toJsonObject(body: object): JsonObject {
  /** `JSON.parse` is untyped; the input is an object, so the output is one. */
  const json: JsonObject = JSON.parse(JSON.stringify(body));
  return json;
}

/**
 * The stored row for `(apiKeyId, key)`, or undefined. With `liveOnly`, an
 * expired row (`expires_at <= now()`) counts as absent: the key is
 * reusable, whether or not the purge has deleted it yet.
 */
export async function findIdempotencyRecord(
  executor: DbExecutor,
  apiKeyId: string,
  key: string,
  opts: { liveOnly: boolean },
): Promise<IdempotencyRecord | undefined> {
  const [row] = await executor
    .select()
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.apiKeyId, apiKeyId),
        eq(idempotencyKeys.key, key),
        opts.liveOnly ? gt(idempotencyKeys.expiresAt, sql`now()`) : undefined,
      ),
    );
  return row;
}

/**
 * Claims `(apiKeyId, key)` for this transaction: inserts the row, or
 * takes over an expired one (a conditional upsert, so the expired row is
 * replaced in place). Returns the row id when claimed, `null` when a live
 * row exists.
 *
 * The unique index serializes concurrent claims: a second transaction
 * claiming the same key waits until the first commits (it then gets
 * `null` and reads the committed, complete row) or rolls back (it then
 * claims the key itself). Two claims of the same expired row are
 * serialized the same way by the row lock: after the first commits, the
 * second re-checks `expires_at` on the new version and gets `null`.
 */
export async function claimIdempotencyKey(
  tx: Tx,
  claim: { apiKeyId: string; key: string; requestHash: string },
): Promise<string | null> {
  const expiresAt = sql`now() + make_interval(hours => ${config.idempotency.keyTtlHours}::int)`;
  const [row] = await tx
    .insert(idempotencyKeys)
    .values({
      id: generateId("idk"),
      apiKeyId: claim.apiKeyId,
      key: claim.key,
      requestHash: claim.requestHash,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [idempotencyKeys.apiKeyId, idempotencyKeys.key],
      set: {
        requestHash: claim.requestHash,
        emailId: null,
        responseStatus: null,
        responseBody: null,
        createdAt: sql`now()`,
        expiresAt,
      },
      setWhere: lte(idempotencyKeys.expiresAt, sql`now()`),
    })
    .returning({ id: idempotencyKeys.id });
  return row?.id ?? null;
}

/**
 * Completes a claimed row with the email it created and the response,
 * inside the claiming transaction, so the row is never committed without
 * them.
 */
export async function completeIdempotencyKey(
  tx: Tx,
  id: string,
  outcome: { emailId: string; status: number; body: JsonObject },
): Promise<void> {
  await tx
    .update(idempotencyKeys)
    .set({
      emailId: outcome.emailId,
      responseStatus: outcome.status,
      responseBody: outcome.body,
    })
    .where(eq(idempotencyKeys.id, id));
}

/**
 * Deletes expired idempotency keys in batches of `batchSize`, at most
 * `PURGE_MAX_BATCHES` batches per call (the rest goes at the next pass).
 * Housekeeping only: an expired row is already treated as absent by the
 * send flow, so correctness never depends on this sweep.
 *
 * @returns how many rows were deleted.
 */
export async function purgeExpiredIdempotencyKeys(
  batchSize: number = PURGE_BATCH_SIZE,
): Promise<number> {
  const expired = lte(idempotencyKeys.expiresAt, sql`now()`);
  let deleted = 0;
  for (let batch = 0; batch < PURGE_MAX_BATCHES; batch += 1) {
    const ids = db
      .select({ id: idempotencyKeys.id })
      .from(idempotencyKeys)
      .where(expired)
      .limit(batchSize);
    const rows = await db
      .delete(idempotencyKeys)
      /** Re-checked on the row itself: a send that took the key over in between keeps it. */
      .where(and(inArray(idempotencyKeys.id, ids), expired))
      .returning({ id: idempotencyKeys.id });
    deleted += rows.length;
    if (rows.length < batchSize) break;
  }
  return deleted;
}
