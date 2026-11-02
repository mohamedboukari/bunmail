import { randomBytes } from "crypto";
import { hostname } from "os";
import { eq, and, sql, getTableColumns, type SQL } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { db, type DbExecutor } from "../../../db/index.ts";
import { emails } from "../models/email.schema.ts";
import { apiKeys } from "../../api-keys/models/api-key.schema.ts";
import { attachmentStorage } from "./attachment-storage.ts";
import { logger } from "../../../utils/logger.ts";

/**
 * How long a claim lasts (#180). The worker renews it every
 * `LEASE_RENEW_MS` while it sends, so only a dead or stuck worker lets it
 * expire; the row is then claimable again.
 */
const LEASE_MINUTES = 15;

/** `NOW() + 15 minutes`, in database time. The length is a constant, so
 *  it is inlined rather than bound as a parameter. */
const LEASE_EXPIRY = sql`NOW() + interval ${sql.raw(`'${LEASE_MINUTES} minutes'`)}`;

/** How often a worker renews the lease on a row it is sending. */
export const LEASE_RENEW_MS = 60_000;

/**
 * Identifies this process in `emails.locked_by`, so its updates only
 * apply to rows it still holds.
 */
export const WORKER_ID =
  `${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`.slice(0, 64);

/**
 * A claimed row, plus its age on the database clock. `created_at` has no
 * time zone and is written by the database, so its age is computed there
 * rather than against the app's clock.
 */
export type ClaimedEmail = typeof emails.$inferSelect & { ageMs: number };

/**
 * `COALESCE(lease_until, updated_at + 15 minutes) < NOW()`: the lease of
 * a `sending` row has expired. A row with no lease (claimed by a version
 * without leases, e.g. an old replica during a rolling deploy) counts as
 * leased until 15 minutes after its last update; `updated_at` holds UTC
 * wall time written by the app.
 */
const LEASE_EXPIRED = sql`COALESCE(${emails.leaseUntil}, (${emails.updatedAt} AT TIME ZONE 'UTC') + interval ${sql.raw(`'${LEASE_MINUTES} minutes'`)}) < NOW()`;

/**
 * The ids of the next `n` claimable emails, shared fairly across API keys
 * (#258), each row locked `FOR UPDATE SKIP LOCKED`.
 *
 * A plain global FIFO let one key with a large backlog fill every batch,
 * so another key's single email waited behind all of it. Instead:
 *
 *   1. For each API key, a `LATERAL` subquery takes its first `n` due
 *      queued rows in due order (`next_attempt_at`, then `created_at`)
 *      through `idx_emails_due_per_key`, locking them `SKIP LOCKED`. The
 *      cost is one short index probe per key, whatever the backlog.
 *      Rows whose lease expired (their worker died) are added from
 *      `idx_emails_lease`, at most `n` of them.
 *   2. The candidates are ranked within their key (1 = the key's oldest
 *      due row), and the batch takes the lowest ranks first, oldest first
 *      within a rank: round-robin across keys. A single key keeps plain
 *      FIFO order.
 *
 * The lock sits in the per-key subqueries because Postgres refuses
 * `FOR UPDATE` at the level of a window function. Locking there keeps
 * `SKIP LOCKED` doing its job: concurrent workers skip each other's rows
 * and take the next ones, so their claims stay disjoint. Candidates that
 * are locked but not taken are released when the statement ends. The
 * eligibility test sits in the same subqueries, so a row another worker
 * claimed in the meantime is re-checked against its new state and dropped.
 */
function fairDueEmailIds(n: number): SQL {
  return sql`
    SELECT fair.id FROM (
      SELECT due.id, due.next_attempt_at, due.created_at,
        row_number() OVER (
          PARTITION BY due.api_key_id ORDER BY due.next_attempt_at, due.created_at, due.id
        ) AS key_rank
      FROM (
        SELECT per_key.* FROM ${apiKeys} CROSS JOIN LATERAL (
          SELECT ${emails.id}, ${emails.apiKeyId}, ${emails.nextAttemptAt}, ${emails.createdAt}
          FROM ${emails}
          WHERE ${emails.apiKeyId} = ${apiKeys.id}
            AND ${emails.status} = 'queued'
            AND ${emails.deletedAt} IS NULL
            AND ${emails.nextAttemptAt} <= NOW()
          ORDER BY ${emails.nextAttemptAt}, ${emails.createdAt}
          LIMIT ${n}
          FOR UPDATE OF ${emails} SKIP LOCKED
        ) AS per_key
        UNION ALL
        SELECT expired.* FROM (
          SELECT ${emails.id}, ${emails.apiKeyId}, ${emails.nextAttemptAt}, ${emails.createdAt}
          FROM ${emails}
          WHERE ${emails.status} = 'sending'
            AND ${emails.deletedAt} IS NULL
            AND ${LEASE_EXPIRED}
          ORDER BY ${emails.nextAttemptAt}, ${emails.createdAt}
          LIMIT ${n}
          FOR UPDATE OF ${emails} SKIP LOCKED
        ) AS expired
      ) AS due
    ) AS fair
    ORDER BY fair.key_rank, fair.next_attempt_at, fair.created_at, fair.id
    LIMIT ${n}`;
}

/**
 * Atomically claims up to `n` queued emails for processing.
 *
 * The query is a single statement that flips `queued → sending` with
 * `attempts` incremented, gated by `FOR UPDATE SKIP LOCKED` on the
 * inner SELECT. That gives us two guarantees no separate select+update
 * pair could:
 *
 *   1. **Atomicity**: by the time the row appears in `RETURNING *`, it
 *      is already in `sending` state. There is no window where a row
 *      is "selected but not yet marked", which is the window the old
 *      code raced through (#20).
 *   2. **Concurrency-safety**: `SKIP LOCKED` makes a concurrent caller
 *      *skip past* any row another transaction has locked rather than
 *      blocking on it or grabbing the same id. So two workers running
 *      this query at the same time get **disjoint** result sets, never
 *      overlapping ones. Each returned row was claimed by exactly one
 *      caller.
 *
 * Eligible rows (#180): `queued` rows whose `next_attempt_at` has passed
 * (retries wait out their backoff), and `sending` rows whose lease has
 * expired (their worker died). Both comparisons use the database clock.
 * The batch is shared across API keys round-robin (#258, see
 * {@link fairDueEmailIds}). The claim takes a lease for this worker.
 *
 * Exported so the integration test can hit it directly without going
 * through the poll loop.
 */
export async function claimNextEmails(n: number): Promise<ClaimedEmail[]> {
  /** Inner subquery that picks the next `n` due ids, fairly, and locks them. */
  const pickIds = fairDueEmailIds(n);

  /** Outer UPDATE flips state, bumps attempts and takes the lease. */
  const claimed = await db
    .update(emails)
    .set({
      status: "sending",
      attempts: sql`${emails.attempts} + 1`,
      lockedBy: WORKER_ID,
      leaseUntil: LEASE_EXPIRY,
      updatedAt: new Date(),
    })
    .where(sql`${emails.id} IN (${pickIds})`)
    .returning({
      ...getTableColumns(emails),
      ageMs:
        sql<number>`(extract(epoch from (NOW() - ${emails.createdAt})) * 1000)::float8`.mapWith(
          Number,
        ),
    });

  return claimed;
}

/**
 * One claim of a row: the row id plus its `attempts` value at claim time.
 * Every claim increments `attempts`, so it works as a fencing token: a
 * claim that was superseded (even by this same process reclaiming its own
 * expired row) no longer matches.
 */
export interface Claim {
  emailId: string;
  attempt: number;
}

/** Matches the row only while this exact claim still holds it. */
function heldBy(claim: Claim) {
  return and(
    eq(emails.id, claim.emailId),
    eq(emails.lockedBy, WORKER_ID),
    eq(emails.attempts, claim.attempt),
    eq(emails.status, "sending"),
  );
}

/**
 * Extends the lease on a row this claim is still sending. Returns false
 * when the claim no longer holds the row (its lease expired and the row
 * was reclaimed).
 */
export async function renewLease(claim: Claim): Promise<boolean> {
  const renewed = await db
    .update(emails)
    .set({ leaseUntil: LEASE_EXPIRY })
    .where(heldBy(claim))
    .returning({ id: emails.id });
  return renewed.length > 0;
}

/**
 * Expires the leases on every row this process is sending, so other
 * workers can claim them right away. Called on shutdown: the process is
 * about to exit, so its in-flight sends will not finish, and without this
 * those rows would wait out their 15-minute lease.
 */
export async function releaseOwnLeases(): Promise<void> {
  const released = await db
    .update(emails)
    .set({ leaseUntil: sql`NOW()` })
    .where(and(eq(emails.lockedBy, WORKER_ID), eq(emails.status, "sending")))
    .returning({ id: emails.id });
  if (released.length > 0) {
    logger.info("Released leases on shutdown", { count: released.length });
  }
}

/** The statuses an email never leaves through the queue: no attempt follows. */
const FINAL_STATUSES: ReadonlySet<unknown> = new Set(["sent", "failed", "bounced"]);

/**
 * Writes a row's outcome and releases its lease, only if this claim still
 * holds it. If the lease was lost (the row was reclaimed), the update is
 * skipped and logged rather than overwriting the newer claim's state.
 *
 * An outcome with a final status (`sent`, `failed`, `bounced`) also drops
 * the email's attachment bytes (#181), keeping their metadata, through the
 * same executor: in the outcome transaction, the bytes go exactly when the
 * status is saved. No later attempt needs them.
 *
 * @param executor The transaction that also enqueues the outcome's events (#184).
 * @returns Whether the claim still held the row and the outcome was saved.
 */
export async function releaseRow(
  claim: Claim,
  values: PgUpdateSetSource<typeof emails>,
  executor: DbExecutor,
): Promise<boolean> {
  const updated = await executor
    .update(emails)
    .set({ ...values, lockedBy: null, leaseUntil: null, updatedAt: new Date() })
    .where(heldBy(claim))
    .returning({ id: emails.id });
  if (updated.length === 0) {
    logger.warn("Email outcome not saved: lease was lost to another claim", {
      emailId: claim.emailId,
    });
    return false;
  }
  if (FINAL_STATUSES.has(values.status)) {
    const dropped = await attachmentStorage.dropAttachmentBytes(executor, [
      claim.emailId,
    ]);
    if (dropped > 0) {
      logger.debug("Attachment bytes dropped at the final state", {
        emailId: claim.emailId,
        dropped,
      });
    }
  }
  return true;
}
