/**
 * Webhook delivery service (#30).
 *
 * Replaces the old in-memory retry loop in `webhook-dispatch.service.ts`
 * with a durable, DB-backed queue. Three concerns live here:
 *
 *   1. **Enqueue.** `enqueueDelivery` turns one (webhook, event, body)
 *      tuple into a `webhook_deliveries` row at `status='pending'`.
 *      `dispatchEvent` calls this once per subscribed webhook.
 *   2. **Claim + send.** `claimAndDeliverDueAttempts` pulls the next N
 *      due rows atomically (FOR UPDATE SKIP LOCKED: same pattern as
 *      the email queue claim from #20), POSTs each one, and updates
 *      the row to `delivered`, rescheduled, or `failed`.
 *   3. **Replay.** `replayDelivery` flips a `failed` row back to
 *      `pending` so the next poll re-attempts it. Operator-driven via
 *      the dashboard / API.
 *
 * Retry schedule (see {@link RETRY_BACKOFF_MINUTES}): 1m, 5m, 15m, 1h,
 * 6h. After 5 failed attempts the row settles at `failed` and is kept
 * indefinitely for forensics. `delivered` rows get reaped by the
 * retention cleanup (see {@link purgeOldDeliveries}).
 *
 * The signature is NOT stored on the row: it's recomputed per attempt
 * with a fresh timestamp so a 6-hour-old retry doesn't ship a stale
 * signature that the consumer's freshness window (5 min default) would
 * reject. Body bytes are stored verbatim once at enqueue time.
 */

import { and, desc, eq, sql, inArray, lt } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { webhookDeliveries } from "../models/webhook-delivery.schema.ts";
import { webhooks } from "../models/webhook.schema.ts";
import { apiKeys } from "../../api-keys/models/api-key.schema.ts";
import { signPayload } from "./webhook-dispatch.service.ts";
import { logger } from "../../../utils/logger.ts";
import { generateId } from "../../../utils/id.ts";
import {
  buildPinnedRequest,
  resolvePublicWebhookTarget,
  type PinnedRequest,
  type PublicWebhookTarget,
  type ResolveAll,
} from "../../../utils/ssrf-guard.ts";
import { config } from "../../../config.ts";
import type { WebhookEventType } from "../types/webhook.types.ts";

/**
 * Backoff schedule per the issue's acceptance criteria. The value at
 * index `i` is the wait between attempt `i` (just-failed) and
 * attempt `i+1`. So a row with `attempts == 1` that just failed waits
 * 5 minutes before it's eligible for the next claim.
 *
 *   attempts=1 just-failed → wait 1m  (overall: 1m)
 *   attempts=2 just-failed → wait 5m  (overall: 6m)
 *   attempts=3 just-failed → wait 15m (overall: 21m)
 *   attempts=4 just-failed → wait 1h  (overall: 1h21m)
 *   attempts=5 just-failed → row flips to `failed`, no further attempts
 *
 * Tuned for the realistic consumer-outage profile: a brief deploy
 * (recovers within minutes) gets one or two retries; an extended
 * outage gets up-to-7-hours of cover before we stop trying.
 */
export const RETRY_BACKOFF_MINUTES = [1, 5, 15, 60] as const;
export const MAX_DELIVERY_ATTEMPTS = RETRY_BACKOFF_MINUTES.length + 1; // 5

/** Per-attempt HTTP timeout. Receivers SHOULD respond within seconds;
 *  slower than 10s is treated as a failure. */
const ATTEMPT_TIMEOUT_MS = 10_000;

/**
 * The claim advances `next_attempt_at` by this much so the row is
 * invisible to subsequent claims for the duration of the in-flight
 * HTTP attempt. Without this, two parallel workers would happily
 * re-pick the same row between (claim commit) and (recordAttempt commit)
 * because the row stays `pending` and remains due. Set to ~3x the
 * HTTP timeout: long enough to cover normal attempts plus slack for
 * `recordAttempt`'s round-trip; short enough that a worker crash
 * mid-attempt unblocks the row within half a minute. */
const ATTEMPT_LOCK_MS = 30_000;

/** Cap on stored body / error preview to avoid unbounded JSONB growth.
 *  Real consumer 5xx bodies are usually a few hundred bytes; 2KB is
 *  well over typical and still cheap to store. */
const RESPONSE_PREVIEW_LIMIT = 2048;

/**
 * Most bytes of a response body ever read. Reading stops (and the stream
 * is cancelled) once this much has arrived: enough for the 2 KB preview
 * even with multi-byte characters. The receiver is untrusted, so reading
 * the whole body would let it fill the worker's memory.
 */
const RESPONSE_READ_LIMIT_BYTES = 8 * 1024;

/**
 * Builds the stored preview from at most `RESPONSE_READ_LIMIT_BYTES` of the
 * body, then cancels the stream. The response must have been fetched with
 * `decompress: false`: Bun inflates a compressed body in native code
 * whatever JavaScript reads (a 0.5 MB gzip response cost about 1 GB of
 * memory in testing), so the body is never decompressed at all. A body
 * the receiver encoded anyway is not shown: decoding even a slice of it
 * would mean running a decompressor on attacker input.
 */
async function readBodyPreview(response: Response): Promise<string | null> {
  if (!response.body) return null;

  const encoding = (response.headers.get("content-encoding") ?? "").trim().toLowerCase();
  if (encoding !== "" && encoding !== "identity") {
    await response.body.cancel().catch(() => undefined);
    const label = encoding.replace(/[^a-z0-9, -]/g, "").slice(0, 40);
    return `[${label}-encoded response body not shown]`;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < RESPONSE_READ_LIMIT_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      /** Keep only what is still needed: a single chunk can be large. */
      const needed = value.subarray(0, RESPONSE_READ_LIMIT_BYTES - total);
      chunks.push(needed);
      total += needed.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return (
    new TextDecoder()
      .decode(Buffer.concat(chunks))
      /** Postgres jsonb rejects NUL, and the preview is stored as jsonb. */
      .replaceAll("\u0000", "")
      .slice(0, RESPONSE_PREVIEW_LIMIT)
      .toWellFormed()
  );
}

interface DeliveryEnvelope {
  event: WebhookEventType;
  /** ISO string: the time the event was *raised*, not the time it was
   *  delivered. Stored verbatim in the body so consumers can reason
   *  about event ordering even after retries. */
  timestamp: string;
  data: Record<string, unknown>;
}

/**
 * Enqueues one delivery row. Called by `dispatchEvent` for every
 * subscribed webhook. Returns the new row's id so callers (and tests)
 * can correlate.
 */
export async function enqueueDelivery(opts: {
  webhookId: string;
  envelope: DeliveryEnvelope;
}): Promise<{ id: string }> {
  const id = generateId("wdl");
  const body = JSON.stringify(opts.envelope);
  await db.insert(webhookDeliveries).values({
    id,
    webhookId: opts.webhookId,
    event: opts.envelope.event,
    payload: body,
  });
  return { id };
}

/**
 * Computes the next attempt timestamp after a failed attempt. Returns
 * `null` if `attempts` has reached the cap, signalling the caller
 * should mark the row `failed`.
 */
export function nextAttemptAt(attempts: number, now: Date = new Date()): Date | null {
  /** `attempts` is the count *after* the most-recent failure has been
   *  recorded, so attempts=1 means one attempt made, schedule wait
   *  according to RETRY_BACKOFF_MINUTES[0]. */
  const idx = attempts - 1;
  if (idx < 0 || idx >= RETRY_BACKOFF_MINUTES.length) return null;
  const minutes = RETRY_BACKOFF_MINUTES[idx]!;
  return new Date(now.getTime() + minutes * 60_000);
}

/**
 * Claims up to `n` due `pending` rows and returns them with the
 * webhook secret + url joined in. Atomic: two concurrent workers will
 * never see the same row, same guarantee as the email queue claim
 * from #20.
 *
 * The claim counts the attempt (`attempts + 1`) before it is made, and
 * returns the count from before the claim; `recordAttempt` then writes
 * that same `prior + 1`. Counting at claim time means an attempt that
 * crashes the process (before `recordAttempt` runs) still counts toward
 * the retry limit, so a delivery that kills the worker cannot be retried
 * forever; once the limit is exceeded the claim marks it `failed`. Drizzle
 * doesn't support a literal SELECT FOR UPDATE in the bun-sql adapter
 * cleanly without an UPDATE wrapper, and we want exclusive locks so
 * concurrent workers' SKIP LOCKED actually skips.
 *
 * Internal: exposed for the worker only.
 */
export async function claimDueDeliveries(
  n: number,
  now: Date = new Date(),
): Promise<
  Array<{
    id: string;
    webhookId: string;
    event: string;
    payload: string;
    attempts: number;
    url: string;
    secret: string;
  }>
> {
  /**
   * Inner: pick + lock the next `n` due rows.
   *
   * The "is this row due?" comparison uses Postgres `NOW()` rather
   * than the JS `now` we got from the caller. Why: rows set
   * `next_attempt_at` via Drizzle's `defaultNow()` (= Postgres NOW())
   * at insert time. On a CI runner with a containerised Postgres, the
   * DB clock can drift a few ms ahead of the worker process's clock,
   * which means a freshly-enqueued row's `next_attempt_at` is in the
   * Node-perceived future for a brief window, and the claim's `<=`
   * filter excludes it. Comparing both sides in DB time sidesteps the
   * skew entirely. The OUTER UPDATE below still uses the Node `now`
   * for its set values; minor skew on those is harmless.
   */
  const pickIds = db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.status, "pending"),
        sql`${webhookDeliveries.nextAttemptAt} <= NOW()`,
      ),
    )
    .orderBy(webhookDeliveries.nextAttemptAt)
    .limit(n)
    .for("update", { skipLocked: true });

  /** Outer: push `next_attempt_at` forward by ATTEMPT_LOCK_MS so the
   *  row is invisible to subsequent claims for the duration of the
   *  in-flight attempt. This is the actual concurrency-safety guarantee:
   *  the SELECT FOR UPDATE only locks rows for the few-ms duration of
   *  this single statement, but the HTTP attempt that follows takes
   *  much longer. Without this push, a parallel worker would re-claim
   *  the same row immediately after this statement commits.
   *
   *  `recordAttempt` runs after the HTTP call returns and overwrites
   *  `next_attempt_at` with either the real backoff schedule (failure)
   *  or sets `delivered_at` (success). If the worker process crashes
   *  before `recordAttempt` runs, the lock expires after ATTEMPT_LOCK_MS
   *  and the row becomes claimable again: natural crash recovery
   *  with no explicit `recoverInterrupted` step needed. */
  /**
   * The claim and its follow-up updates run in one transaction: if any
   * statement fails, the `attempts` increment rolls back instead of
   * costing every claimed row an attempt, and the claimed rows stay
   * locked until commit, so a concurrent replay or `recordAttempt` waits
   * rather than being overwritten by the updates below.
   */
  return db.transaction(async (tx) => {
    const claimed = await tx
      .update(webhookDeliveries)
      .set({
        nextAttemptAt: new Date(now.getTime() + ATTEMPT_LOCK_MS),
        attempts: sql`${webhookDeliveries.attempts} + 1`,
        updatedAt: now,
      })
      .where(inArray(webhookDeliveries.id, pickIds))
      .returning();

    if (claimed.length === 0) return [];

    /** Join the webhook's url + secret per row. We need both for delivery
     *  but they live on the parent table. One round-trip via inArray. */
    const webhookIds = [...new Set(claimed.map((r) => r.webhookId))];
    const hooks = await tx
      .select({
        id: webhooks.id,
        url: webhooks.url,
        secret: webhooks.secret,
        isActive: webhooks.isActive,
        /** Deliverable only while the owning key is active too: rows
         *  queued before a key was revoked are not sent afterwards. */
        keyActive: apiKeys.isActive,
      })
      .from(webhooks)
      .innerJoin(apiKeys, eq(apiKeys.id, webhooks.apiKeyId))
      .where(inArray(webhooks.id, webhookIds));
    const hookById = new Map(hooks.map((h) => [h.id, h]));

    /** Drop deliveries whose webhook was deactivated after enqueue. We
     *  mark them `failed` rather than send to a hook the operator has
     *  paused: that's the operator's stated intent. */
    const live: typeof claimed = [];
    for (const row of claimed) {
      /** Over the limit only if earlier attempts never reached
       *  `recordAttempt` (the process died mid-attempt): stop retrying. */
      if (row.attempts > MAX_DELIVERY_ATTEMPTS) {
        await tx
          .update(webhookDeliveries)
          .set({
            status: "failed",
            attempts: MAX_DELIVERY_ATTEMPTS,
            lastError: "attempt limit reached: earlier attempts were interrupted",
            updatedAt: now,
          })
          .where(eq(webhookDeliveries.id, row.id));
        logger.warn("Webhook delivery failed: attempts interrupted", {
          deliveryId: row.id,
          webhookId: row.webhookId,
        });
        continue;
      }
      const hook = hookById.get(row.webhookId);
      if (!hook || !hook.isActive || !hook.keyActive) {
        await tx
          .update(webhookDeliveries)
          .set({
            status: "failed",
            /** No request is made: undo the claim's increment. */
            attempts: row.attempts - 1,
            lastError: "webhook or its API key inactive at delivery time",
            updatedAt: now,
          })
          .where(eq(webhookDeliveries.id, row.id));
        logger.warn("Webhook delivery cancelled: webhook inactive", {
          deliveryId: row.id,
          webhookId: row.webhookId,
        });
        continue;
      }
      live.push(row);
    }

    return live.map((row) => {
      const hook = hookById.get(row.webhookId)!;
      return {
        id: row.id,
        webhookId: row.webhookId,
        event: row.event,
        payload: row.payload,
        /** Count before this attempt (the claim already added it). */
        attempts: row.attempts - 1,
        url: hook.url,
        secret: hook.secret,
      };
    });
  });
}

interface AttemptOutcome {
  ok: boolean;
  status: number | null;
  error: string | null;
  bodyPreview: string | null;
}

/**
 * Performs one HTTP POST attempt against the webhook URL. Pure-ish:
 * the side effect is the network call; the return value is enough for
 * the caller to update the delivery row.
 *
 * Re-signs per attempt: that's the whole point of separating the
 * stored body from the signature. A row sitting in `pending` for 6
 * hours, when finally retried, ships a fresh timestamp the consumer's
 * 5-min freshness window will accept.
 *
 * The request goes to the address the SSRF guard validated, not to the
 * host name (see {@link buildPinnedRequest}).
 */
export async function performHttpAttempt(opts: {
  url: string;
  secret: string;
  body: string;
  event: string;
  fetchImpl?: typeof fetch;
  /** DNS lookup for the SSRF guard; defaults to the system resolver. */
  resolver?: ResolveAll;
  timeoutMs?: number;
}): Promise<AttemptOutcome> {
  const fetchFn = opts.fetchImpl ?? globalThis.fetch;
  const sigTimestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signPayload(sigTimestamp, opts.body, opts.secret);

  /**
   * SSRF re-validation at delivery time (#128). The URL was checked at
   * create, but DNS can change and rows created before this guard existed
   * were never checked, so resolve and validate on every attempt. The host
   * is resolved exactly once here: the request below connects to the
   * address validated now, so a different later answer is never used.
   * A blocked URL, or one that cannot be pinned to the validated address,
   * is a failed attempt, not a fetch.
   */
  let target: PublicWebhookTarget;
  let pinned: PinnedRequest;
  try {
    target = await resolvePublicWebhookTarget(
      opts.url,
      config.webhookDelivery.allowInsecureHttp,
      opts.resolver,
    );
    pinned = buildPinnedRequest(target);
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : String(err),
      bodyPreview: null,
    };
  }
  logger.debug("Webhook attempt pinned to validated address", {
    family: target.family,
  });

  try {
    const response = await fetchFn(pinned.url, {
      method: "POST",
      headers: {
        /** The receiver sees the configured host, not the address. */
        Host: pinned.host,
        "Content-Type": "application/json",
        "X-BunMail-Signature": signature,
        "X-BunMail-Timestamp": sigTimestamp,
        "X-BunMail-Event": opts.event,
        /** Ask for an uncompressed reply, so honest receivers' previews
         *  can be shown (see readBodyPreview). */
        "Accept-Encoding": "identity",
      },
      body: opts.body,
      /** SNI and certificate check against the host name (https only). */
      tls: pinned.tls,
      /**
       * A fresh connection per attempt: a pooled connection to the same
       * address could have been opened, and its certificate checked, for
       * a different host name.
       */
      keepalive: false,
      /** Never inflate the untrusted body (Bun-specific option). */
      decompress: false,
      /**
       * Never follow redirects (#128): a 3xx `Location` into an internal
       * address (169.254.169.254, 127.0.0.1, …) would bypass the pre-fetch
       * host check. A redirect is treated as a non-2xx delivery failure.
       */
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? ATTEMPT_TIMEOUT_MS),
    });

    let bodyPreview: string | null = null;
    try {
      bodyPreview = await readBodyPreview(response);
    } catch {
      /** Body read can fail (already-consumed, network reset). Not
       *  fatal: the status code is the load-bearing signal. */
    }

    return {
      ok: response.ok,
      status: response.status,
      error: response.ok ? null : `HTTP ${response.status}`,
      bodyPreview,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : String(err),
      bodyPreview: null,
    };
  }
}

/**
 * Persists the outcome of one attempt to the delivery row. On success
 * the row is terminal (`delivered`). On failure, either reschedule via
 * `nextAttemptAt(attempts)` or terminate at `failed` if the cap has
 * been reached.
 */
export async function recordAttempt(opts: {
  deliveryId: string;
  outcome: AttemptOutcome;
  priorAttempts: number;
  now?: Date;
}): Promise<void> {
  const now = opts.now ?? new Date();
  const newAttempts = opts.priorAttempts + 1;

  if (opts.outcome.ok) {
    await db
      .update(webhookDeliveries)
      .set({
        status: "delivered",
        attempts: newAttempts,
        lastError: null,
        lastResponseStatus: opts.outcome.status,
        lastResponseBody: opts.outcome.bodyPreview
          ? { bodyPreview: opts.outcome.bodyPreview }
          : null,
        deliveredAt: now,
        updatedAt: now,
      })
      .where(eq(webhookDeliveries.id, opts.deliveryId));
    return;
  }

  const next = nextAttemptAt(newAttempts, now);
  if (next === null) {
    /** Cap reached: terminal failure. */
    await db
      .update(webhookDeliveries)
      .set({
        status: "failed",
        attempts: newAttempts,
        lastError: opts.outcome.error?.slice(0, RESPONSE_PREVIEW_LIMIT) ?? "unknown",
        lastResponseStatus: opts.outcome.status,
        lastResponseBody: opts.outcome.bodyPreview
          ? { bodyPreview: opts.outcome.bodyPreview }
          : null,
        updatedAt: now,
      })
      .where(eq(webhookDeliveries.id, opts.deliveryId));
    return;
  }

  await db
    .update(webhookDeliveries)
    .set({
      attempts: newAttempts,
      lastError: opts.outcome.error?.slice(0, RESPONSE_PREVIEW_LIMIT) ?? "unknown",
      lastResponseStatus: opts.outcome.status,
      lastResponseBody: opts.outcome.bodyPreview
        ? { bodyPreview: opts.outcome.bodyPreview }
        : null,
      nextAttemptAt: next,
      updatedAt: now,
    })
    .where(eq(webhookDeliveries.id, opts.deliveryId));
}

/* ─── Read-side queries ─── */

/**
 * Lists deliveries for a webhook, scoped by api key (the dashboard /
 * REST endpoint joins through `webhooks` for ownership).
 */
export async function listDeliveriesForWebhook(opts: {
  webhookId: string;
  apiKeyId: string;
  status?: "pending" | "delivered" | "failed";
  page: number;
  limit: number;
}): Promise<{ data: Array<typeof webhookDeliveries.$inferSelect>; total: number }> {
  /** Confirm the webhook belongs to this api key: defence in depth.
   *  The plugin layer already gates on the api key but we don't want
   *  this service to be a footgun if called from a different code
   *  path later. */
  const [hook] = await db
    .select({ id: webhooks.id })
    .from(webhooks)
    .where(and(eq(webhooks.id, opts.webhookId), eq(webhooks.apiKeyId, opts.apiKeyId)))
    .limit(1);
  if (!hook) return { data: [], total: 0 };

  const condition = opts.status
    ? and(
        eq(webhookDeliveries.webhookId, opts.webhookId),
        eq(webhookDeliveries.status, opts.status),
      )
    : eq(webhookDeliveries.webhookId, opts.webhookId);

  const offset = (opts.page - 1) * opts.limit;
  const [data, totalRows] = await Promise.all([
    db
      .select()
      .from(webhookDeliveries)
      .where(condition)
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(opts.limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(webhookDeliveries)
      .where(condition),
  ]);
  return { data, total: totalRows[0]?.count ?? 0 };
}

/**
 * Fetch a single delivery, scoped to the calling api key via the
 * parent webhook's ownership.
 */
export async function getDeliveryById(opts: {
  deliveryId: string;
  apiKeyId: string;
}): Promise<typeof webhookDeliveries.$inferSelect | undefined> {
  const [row] = await db
    .select({ delivery: webhookDeliveries })
    .from(webhookDeliveries)
    .innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhookId))
    .where(
      and(
        eq(webhookDeliveries.id, opts.deliveryId),
        eq(webhooks.apiKeyId, opts.apiKeyId),
      ),
    )
    .limit(1);
  return row?.delivery;
}

/* ─── Replay ─── */

/**
 * Flips a delivery row back to `pending` and resets `nextAttemptAt` to
 * now so the worker picks it up on the next poll. Used by operators
 * to manually retry a `failed` (or stuck) row.
 *
 * Resets `attempts` to 0: the operator is starting a fresh retry
 * cycle, not continuing the old one. Otherwise replay of a 5x-failed
 * row would immediately re-flip to `failed` after one more attempt.
 *
 * Returns `undefined` if the delivery doesn't exist or doesn't belong
 * to the calling api key.
 */
export async function replayDelivery(opts: {
  deliveryId: string;
  apiKeyId: string;
  now?: Date;
}): Promise<typeof webhookDeliveries.$inferSelect | undefined> {
  const now = opts.now ?? new Date();
  /** Ownership check via the parent webhook. */
  const existing = await getDeliveryById(opts);
  if (!existing) return undefined;

  const [updated] = await db
    .update(webhookDeliveries)
    .set({
      status: "pending",
      attempts: 0,
      lastError: null,
      lastResponseStatus: null,
      lastResponseBody: null,
      deliveredAt: null,
      /**
       * Use Postgres NOW() rather than the JS `now` so the row is
       * immediately due by the worker's DB-clock comparison even when
       * Node's clock is slightly ahead of PG's. Otherwise replay can
       * queue a row that's briefly invisible to the worker until the
       * next poll cycle catches up.
       */
      nextAttemptAt: sql`NOW()`,
      updatedAt: now,
    })
    .where(eq(webhookDeliveries.id, opts.deliveryId))
    .returning();
  return updated;
}

/* ─── Retention cleanup ─── */

/**
 * Purges `delivered` rows older than the retention cutoff. `failed`
 * rows are kept indefinitely: operators want them for forensic
 * "did this event ever land?" queries even months later.
 *
 * Run from the worker poll loop (once an hour, not on every tick).
 */
export async function purgeOldDeliveries(opts: {
  olderThan: Date;
}): Promise<{ deleted: number }> {
  const result = await db
    .delete(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.status, "delivered"),
        lt(webhookDeliveries.createdAt, opts.olderThan),
      ),
    )
    .returning({ id: webhookDeliveries.id });
  return { deleted: result.length };
}
