import { randomBytes } from "crypto";
import { hostname } from "os";
import { eq, asc, and, or, isNull, inArray, sql, getTableColumns } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { db } from "../../../db/index.ts";
import { emails } from "../models/email.schema.ts";
import type { DeliveryState, DeliveryGroup } from "../models/email.schema.ts";
import { domains } from "../../domains/models/domain.schema.ts";
import { sendMail } from "./mailer.service.ts";
import type { DkimOptions, UnsubscribeOptions } from "./mailer.service.ts";
import { dispatchEvent } from "../../webhooks/services/webhook-dispatch.service.ts";
import { addFromBounce } from "../../suppressions/services/suppression.service.ts";
import { logger } from "../../../utils/logger.ts";
import { runWithLogContext } from "../../../utils/log-context.ts";
import { redactEmail } from "../../../utils/redact.ts";
import { decryptSecret, isEncryptedSecret } from "../../../utils/crypto.ts";
import { parseSmtpError } from "../../../utils/smtp-error.ts";
import { config } from "../../../config.ts";
import { nextRetryDelayMs } from "./retry-schedule.ts";
import { findById as findApiKeyById } from "../../api-keys/services/api-key.service.ts";

/**
 * Subset of the `domains` row used by the queue's DKIM + unsubscribe
 * resolution. Kept narrow so unit tests can build fixtures without
 * faking the full Drizzle row type.
 */
export interface DomainLookupRow {
  name: string;
  dkimSelector: string;
  dkimPrivateKey: string | null;
  unsubscribeEmail: string | null;
  unsubscribeUrl: string | null;
}

/**
 * Resolves the `domains` row that should drive DKIM signing and
 * `List-Unsubscribe` overrides for an outbound email.
 *
 * Lookup order:
 *   1. **By `domainId` (canonical)**: the FK stamped on the email row
 *      at create-time. Survives sender renames and is the right answer
 *      even if a future schema allows non-unique names per API key.
 *   2. **By sender domain name (legacy fallback)**, only used when
 *      `domainId` is null, which only happens for rows created before
 *      the FK existed (schema 0001). New rows always carry `domainId`
 *      when the domain is registered.
 *
 * Exported for unit testing, see test/unit/resolve-domain-for-email.test.ts.
 */
export async function resolveDomainForEmail(
  email: { domainId: string | null; fromAddress: string },
  queries: {
    byId: (id: string) => Promise<DomainLookupRow | undefined>;
    byName: (name: string) => Promise<DomainLookupRow | undefined>;
  },
): Promise<DomainLookupRow | undefined> {
  /** Primary path: FK is the canonical pointer. */
  if (email.domainId !== null) {
    return queries.byId(email.domainId);
  }

  /** Legacy fallback: pre-FK rows. Skip if `fromAddress` is malformed. */
  const senderDomain = email.fromAddress.split("@")[1];
  if (!senderDomain) return undefined;
  return queries.byName(senderDomain);
}

/**
 * Decrypts a stored DKIM private key for use with nodemailer's signer.
 *
 * Three input shapes are tolerated:
 *   - `null`: no key on file; returned unchanged so the caller falls
 *     back to unsigned mail.
 *   - encrypted (`v1:...`): the normal post-migration path; AES-256-GCM
 *     decrypted with `config.dkimEncryptionKey`.
 *   - plaintext PEM: possible during the upgrade window before the
 *     boot-time encrypter runs, or if an operator inserted a row by
 *     hand. Logged as a warning so it shows up in incident review,
 *     then returned as-is so the email still signs.
 *
 * On decrypt failure (wrong key, tampered ciphertext) we log and return
 * `null`: the mail is sent unsigned rather than failed outright. This
 * is **fail-open** by design: a key-rotation accident shouldn't take
 * down outbound delivery.
 */
function decryptDkimPrivateKey(stored: string | null, domainName: string): string | null {
  if (stored === null) return null;

  if (!isEncryptedSecret(stored)) {
    logger.warn("DKIM private key stored as plaintext: boot encrypter has not run", {
      domain: domainName,
    });
    return stored;
  }

  try {
    return decryptSecret(stored, config.dkimEncryptionKey);
  } catch (err) {
    logger.error("Failed to decrypt DKIM private key: sending unsigned", {
      domain: domainName,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Concrete `byId` query against the live Drizzle DB. */
async function queryDomainById(id: string): Promise<DomainLookupRow | undefined> {
  const [row] = await db
    .select({
      name: domains.name,
      dkimSelector: domains.dkimSelector,
      dkimPrivateKey: domains.dkimPrivateKey,
      unsubscribeEmail: domains.unsubscribeEmail,
      unsubscribeUrl: domains.unsubscribeUrl,
    })
    .from(domains)
    .where(eq(domains.id, id));
  if (!row) return undefined;
  return { ...row, dkimPrivateKey: decryptDkimPrivateKey(row.dkimPrivateKey, row.name) };
}

/** Concrete `byName` query against the live Drizzle DB. */
async function queryDomainByName(name: string): Promise<DomainLookupRow | undefined> {
  const [row] = await db
    .select({
      name: domains.name,
      dkimSelector: domains.dkimSelector,
      dkimPrivateKey: domains.dkimPrivateKey,
      unsubscribeEmail: domains.unsubscribeEmail,
      unsubscribeUrl: domains.unsubscribeUrl,
    })
    .from(domains)
    .where(eq(domains.name, name));
  if (!row) return undefined;
  return { ...row, dkimPrivateKey: decryptDkimPrivateKey(row.dkimPrivateKey, row.name) };
}

/** How often the queue checks for new emails to send (in ms) */
const POLL_INTERVAL_MS = 2000;

/** Max emails to process in a single poll cycle */
const BATCH_SIZE = 5;

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
const LEASE_RENEW_MS = 60_000;

/**
 * Oldest an email may get while temporary failures are still retried.
 * Read at use time, not import time, so modules that import this one
 * with a partial config stub (unit tests) still load.
 */
function retryMaxAgeMs(): number {
  return config.mail.retryMaxAgeHours * 60 * 60 * 1000;
}

/**
 * Identifies this process in `emails.locked_by`, so its updates only
 * apply to rows it still holds.
 */
const WORKER_ID = `${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`.slice(
  0,
  64,
);

/**
 * A claimed row, plus its age on the database clock. `created_at` has no
 * time zone and is written by the database, so its age is computed there
 * rather than against the app's clock.
 */
type ClaimedEmail = typeof emails.$inferSelect & { ageMs: number };

/** The mailer, injectable so tests can drive the queue without SMTP. */
interface QueueDeps {
  sendMail: typeof sendMail;
}

const defaultDeps: QueueDeps = { sendMail };

/** Reference to the setInterval timer: used to stop the queue */
let pollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the queue processor: polls every 2 seconds for due emails.
 *
 * There is no recovery step at boot (#180). Rows a crashed worker left in
 * `sending` are reclaimed by the normal claim once their lease expires.
 * The old boot step reset every `sending` row, including ones another
 * replica was still sending, which delivered those emails twice.
 */
export async function start(): Promise<void> {
  logger.info("Starting email queue processor", {
    pollIntervalMs: POLL_INTERVAL_MS,
    batchSize: BATCH_SIZE,
    retryMaxAgeHours: config.mail.retryMaxAgeHours,
    workerId: WORKER_ID,
  });

  /** Begin the poll loop */
  pollTimer = setInterval(() => {
    runQueueCycle().catch((error) => {
      logger.error("Queue processing error", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, POLL_INTERVAL_MS);
}

/**
 * Stops the queue processor.
 *
 * Called during graceful shutdown (SIGINT/SIGTERM) to prevent
 * new emails from being picked up while the server is stopping.
 */
export function stop(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    logger.info("Email queue processor stopped");
  }
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
 * A `sending` row with no lease (claimed by a version without leases,
 * e.g. an old replica during a rolling deploy) counts as leased until 15
 * minutes after its last update. The claim takes a lease for this worker.
 *
 * Exported so the integration test can hit it directly without going
 * through the poll loop.
 */
export async function claimNextEmails(n: number): Promise<ClaimedEmail[]> {
  /** Inner subquery that picks the next `n` due ids and locks them. */
  const pickIds = db
    .select({ id: emails.id })
    .from(emails)
    .where(
      and(
        isNull(emails.deletedAt),
        or(
          and(eq(emails.status, "queued"), sql`${emails.nextAttemptAt} <= NOW()`),
          and(
            eq(emails.status, "sending"),
            /** `updated_at` holds UTC wall time written by the app. */
            sql`COALESCE(${emails.leaseUntil}, (${emails.updatedAt} AT TIME ZONE 'UTC') + interval ${sql.raw(`'${LEASE_MINUTES} minutes'`)}) < NOW()`,
          ),
        ),
      ),
    )
    .orderBy(asc(emails.nextAttemptAt), asc(emails.createdAt))
    .limit(n)
    .for("update", { skipLocked: true });

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
    .where(inArray(emails.id, pickIds))
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
interface Claim {
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
async function renewLease(claim: Claim): Promise<boolean> {
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

/**
 * Writes a row's outcome and releases its lease, only if this claim still
 * holds it. If the lease was lost (the row was reclaimed), the update is
 * skipped and logged rather than overwriting the newer claim's state.
 */
async function releaseRow(
  claim: Claim,
  values: PgUpdateSetSource<typeof emails>,
): Promise<void> {
  const updated = await db
    .update(emails)
    .set({ ...values, lockedBy: null, leaseUntil: null, updatedAt: new Date() })
    .where(heldBy(claim))
    .returning({ id: emails.id });
  if (updated.length === 0) {
    logger.warn("Email outcome not saved: lease was lost to another claim", {
      emailId: claim.emailId,
    });
  }
}

/** Earliest time any MX group was delivered, if one was. */
function firstDeliveredAt(state: DeliveryState): Date | null {
  const times = Object.values(state)
    .map((g) => (g.deliveredAt ? Date.parse(g.deliveredAt) : NaN))
    .filter((t) => !Number.isNaN(t));
  return times.length > 0 ? new Date(Math.min(...times)) : null;
}

/**
 * Single poll cycle: claims a batch of queued emails and processes them.
 *
 * Steps:
 * 1. Atomically claim up to BATCH_SIZE rows (queued → sending in one
 *    statement, with `FOR UPDATE SKIP LOCKED` so concurrent workers
 *    can't claim the same row, see {@link claimNextEmails}).
 * 2. For each claimed row (concurrently):
 *    a. Try SMTP delivery via the mailer service.
 *    b. On success: mark "sent" with timestamp.
 *    c. On failure: hard 5xx groups are auto-suppressed (#68); temporary
 *       failures are requeued with backoff until the email is older than
 *       `MAIL_RETRY_MAX_AGE_HOURS`, then marked "failed" (#180).
 *
 * Exported (with an injectable mailer) so tests can drive one cycle.
 */
export async function runQueueCycle(deps: QueueDeps = defaultDeps): Promise<void> {
  const batch = await claimNextEmails(BATCH_SIZE);

  /** Nothing to process: skip silently */
  if (batch.length === 0) return;

  logger.debug("Processing email batch", { count: batch.length });

  /** Process all emails in the batch concurrently */
  await Promise.allSettled(batch.map((email) => processEmail(email, deps)));
}

/**
 * Processes a single email: marks it as sending, attempts SMTP delivery,
 * and updates the status based on the outcome.
 *
 * @param email - The queued email row to process
 */
async function processEmail(email: ClaimedEmail, deps: QueueDeps): Promise<void> {
  const claim: Claim = { emailId: email.id, attempt: email.attempts };
  /** Keep the lease alive for as long as this send takes. */
  const renewal = setInterval(() => {
    renewLease(claim)
      .then((held) => {
        if (!held) logger.warn("Lease lost while sending", { ...claim });
      })
      .catch((error: unknown) => {
        logger.error("Lease renewal failed", {
          ...claim,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, LEASE_RENEW_MS);
  /**
   * The attempt runs in its own log context (#284): every line it writes,
   * down to the mailer, DKIM and the webhooks it fires, carries the email
   * id and attempt number.
   */
  const startedAt = performance.now();
  try {
    await runWithLogContext({ job: "email-send", jobId: email.id }, () =>
      sendClaimedEmail(email, claim, deps),
    );
  } finally {
    clearInterval(renewal);
    logger.debug("Email send attempt finished", {
      emailId: email.id,
      attempt: email.attempts,
      durationMs: Math.round(performance.now() - startedAt),
    });
  }
}

/** Sends one claimed email and records the outcome (see {@link runQueueCycle}). */
async function sendClaimedEmail(
  email: ClaimedEmail,
  claim: Claim,
  deps: QueueDeps,
): Promise<void> {
  const emailId = email.id;
  /**
   * The row arrives already in `sending` state with `attempts` incremented:
   * `claimNextEmails` did both atomically (#20). So `email.attempts` is
   * the count for *this* attempt, not the previous one.
   */
  const attempt = email.attempts;

  logger.info("Processing email", {
    emailId,
    attempt,
    to: redactEmail(email.toAddress),
  });

  /**
   * Retries can run for up to `MAIL_RETRY_MAX_AGE_HOURS` after the send
   * was accepted, so check that the sending key is still active: a key
   * revoked in the meantime (#239) must not keep sending.
   */
  const key = await findApiKeyById(email.apiKeyId);
  if (!key?.isActive) {
    await releaseRow(claim, {
      status: "failed",
      lastError: "API key revoked before delivery",
    });
    logger.warn("Email not sent: API key revoked", { emailId, apiKeyId: email.apiKeyId });
    return;
  }

  try {
    /**
     * Look up DKIM keys + unsubscribe overrides for the sender's domain.
     * Both fall back gracefully.
     */
    const domain = await resolveDomainForEmail(email, {
      byId: queryDomainById,
      byName: queryDomainByName,
    });

    let dkim: DkimOptions | undefined;
    let unsubscribe: UnsubscribeOptions | undefined;

    if (domain?.dkimPrivateKey) {
      dkim = {
        domainName: domain.name,
        keySelector: domain.dkimSelector,
        privateKey: domain.dkimPrivateKey,
      };
      logger.debug("DKIM signing enabled", {
        domain: domain.name,
        selector: domain.dkimSelector,
      });
    }

    if (domain?.unsubscribeEmail || domain?.unsubscribeUrl) {
      unsubscribe = {
        mailto: domain.unsubscribeEmail ?? undefined,
        url: domain.unsubscribeUrl ?? undefined,
      };
    }

    /**
     * Canonical Message-ID: locked in on first attempt, reused on
     * retries. Stable identifier is what bounce / complaint feedback
     * loops join on: minting a new one per attempt would break
     * correlation entirely. (#97)
     */
    const messageId =
      email.messageId ?? `<${randomBytes(16).toString("hex")}@${config.mail.hostname}>`;

    const existingState = email.deliveryState;
    /** Capture pre-attempt status per group so we can detect
     *  transitions (retry → failed via hard 5xx) for bounce webhooks. */
    const priorStatuses = new Map<string, DeliveryGroup["status"]>();
    if (existingState) {
      for (const [mx, g] of Object.entries(existingState)) {
        priorStatuses.set(mx, g.status);
      }
    }

    const result = await deps.sendMail({
      from: email.fromAddress,
      to: email.toAddress,
      cc: email.cc,
      bcc: email.bcc,
      replyTo: email.replyTo,
      subject: email.subject,
      html: email.html,
      text: email.textContent,
      messageId,
      existingState,
      dkim,
      unsubscribe,
    });

    /**
     * Fire `email.bounced` + auto-suppress for groups that **newly
     * transitioned to `failed`** this attempt via a hard 5xx. Skip
     * groups that were already `failed` before this attempt (we'd
     * already fired for them on the earlier pass) and skip groups
     * still in `retry` (no terminal outcome yet).
     */
    for (const [mxHost, group] of Object.entries(result.deliveryState)) {
      if (group.status !== "failed") continue;
      if (priorStatuses.get(mxHost) === "failed") continue; /** Already handled. */
      const parsed = group.lastError ? parseSmtpError(group.lastError) : undefined;
      if (parsed?.kind !== "hard")
        continue; /** Synthetic DNS failures + transient exhaust handled separately. */

      for (const rcpt of group.recipients) {
        const suppression = await addFromBounce(email.apiKeyId, {
          email: rcpt,
          bounceType: "hard",
          diagnosticCode: parsed.code,
          sourceEmailId: emailId,
          expiresAt: null,
        });
        dispatchEvent(
          "email.bounced",
          {
            emailId,
            to: email.toAddress,
            recipient: rcpt,
            bounceType: "hard",
            status: parsed.code,
            diagnostic: group.lastError ?? "(no diagnostic)",
            suppressionId: suppression.id,
            source: "inline",
          },
          { apiKeyId: email.apiKeyId },
        );
        logger.warn("Multi-MX recipient hard-bounced: auto-suppressed", {
          emailId,
          apiKeyId: email.apiKeyId,
          recipient: redactEmail(rcpt),
          status: parsed.code,
          suppressionId: suppression.id,
        });
      }
    }

    /**
     * Decide row-level outcome from the aggregate group state.
     *
     * - any group still `retry` AND the email is young enough → schedule
     *   the next pass after the backoff (#180)
     * - else (all terminal, or too old to retry) → terminal row status:
     *   - any group `sent` → row `sent`
     *   - else any failed-due-to-hard-5xx → row `bounced`
     *   - else → row `failed`
     */
    const groups = Object.entries(result.deliveryState);
    const anyRetry = groups.some(([, g]) => g.status === "retry");
    const anySent = groups.some(([, g]) => g.status === "sent");

    const retryDelayMs = anyRetry
      ? nextRetryDelayMs(attempt, email.ageMs, retryMaxAgeMs())
      : null;

    if (retryDelayMs !== null) {
      /** At least one group transient-failed; row goes back to `queued`
       *  and is not claimable before the backoff passes (database clock).
       *  Persist the state so the next pass can skip already-sent groups;
       *  `sentAt` records the first delivered group. */
      const retrySeconds = Math.round(retryDelayMs / 1000);
      await releaseRow(claim, {
        status: "queued",
        nextAttemptAt: sql`NOW() + interval ${sql.raw(`'${retrySeconds} seconds'`)}`,
        messageId,
        deliveryState: result.deliveryState,
        sentAt: firstDeliveredAt(result.deliveryState),
        lastError: summariseRetries(result.deliveryState),
      });
      logger.warn("Email send had retry groups, requeued", {
        emailId,
        attempt,
        retryInSeconds: retrySeconds,
      });
      /** If this attempt landed at least one group, fire `email.sent`
       *  once: checked against priorStatuses so we don't double-fire
       *  on a future attempt where the same group is already sent. */
      if (anySent && !anySentBefore(priorStatuses)) {
        dispatchEvent(
          "email.sent",
          {
            emailId,
            from: email.fromAddress,
            to: email.toAddress,
            subject: email.subject,
            messageId,
          },
          { apiKeyId: email.apiKeyId },
        );
      }
      return;
    }

    /** Too-old-to-retry or all-terminal path. Flip any straggling retry
     *  groups to `failed` (transient-exhausted, not hard-bounced) so
     *  the persisted state has no ambiguous statuses left. */
    const finalState: DeliveryState = { ...result.deliveryState };
    for (const [mx, g] of Object.entries(finalState)) {
      if (g.status === "retry") finalState[mx] = { ...g, status: "failed" };
    }

    const finalGroups = Object.values(finalState);
    const finalAnySent = finalGroups.some((g) => g.status === "sent");
    const finalAnyHardBounce = Object.entries(finalState).some(([, g]) => {
      if (g.status !== "failed") return false;
      const p = g.lastError ? parseSmtpError(g.lastError) : undefined;
      return p?.kind === "hard";
    });

    const finalStatus: "sent" | "bounced" | "failed" = finalAnySent
      ? "sent"
      : finalAnyHardBounce
        ? "bounced"
        : "failed";

    await releaseRow(claim, {
      status: finalStatus,
      messageId,
      deliveryState: finalState,
      sentAt: finalAnySent ? (firstDeliveredAt(finalState) ?? new Date()) : null,
      lastError:
        finalStatus === "sent" && finalGroups.every((g) => g.status === "sent")
          ? null
          : summariseFailures(finalState),
    });

    logger.info("Email reached terminal state", {
      emailId,
      messageId,
      attempt,
      finalStatus,
      sentGroups: finalGroups.filter((g) => g.status === "sent").length,
      failedGroups: finalGroups.filter((g) => g.status === "failed").length,
    });

    if (finalAnySent && !anySentBefore(priorStatuses)) {
      dispatchEvent(
        "email.sent",
        {
          emailId,
          from: email.fromAddress,
          to: email.toAddress,
          subject: email.subject,
          messageId,
        },
        { apiKeyId: email.apiKeyId },
      );
    }

    if (!finalAnySent && finalStatus === "failed") {
      /** Pure failure (no group ever delivered + no hard 5xx): keep
       *  the `email.failed` webhook fired by the legacy path so
       *  consumers that watch this event still see it. */
      dispatchEvent(
        "email.failed",
        {
          emailId,
          from: email.fromAddress,
          to: email.toAddress,
          subject: email.subject,
          error: summariseFailures(finalState),
          /** Some receiver refused the sender (#246), not the recipient. */
          blocked: Object.values(finalState).some((g) => g.blocked === true),
        },
        { apiKeyId: email.apiKeyId },
      );
    }
  } catch (error) {
    /**
     * `sendMail` only throws for fundamental input errors now (no
     * valid recipients after parsing): never for transport / SMTP
     * failures, which return as `failed`/`retry` groups in state.
     * So this catch is a one-shot terminal: mark `failed`, no retry.
     */
    const errorMessage = error instanceof Error ? error.message : String(error);
    await releaseRow(claim, { status: "failed", lastError: errorMessage });
    logger.error("Email permanently failed (input error)", {
      emailId,
      attempt,
      error: errorMessage,
    });
    dispatchEvent(
      "email.failed",
      {
        emailId,
        from: email.fromAddress,
        to: email.toAddress,
        subject: email.subject,
        error: errorMessage,
      },
      { apiKeyId: email.apiKeyId },
    );
  }
}

/**
 * Compact human-readable digest of which groups are still in retry
 * and why. Stored in `emails.last_error` between retry passes so
 * operators reading the DB can see "outlook retrying after 421" at a
 * glance without dumping the full `delivery_state` JSON.
 */
function summariseRetries(state: DeliveryState): string {
  const retrying = Object.entries(state).filter(([, g]) => g.status === "retry");
  if (retrying.length === 0) return "";
  return `Retrying ${retrying.length} group(s): ${retrying
    .map(([mx, g]) => `${mx} (${g.recipients.length} rcpt): ${g.lastError ?? "?"}`)
    .join(" | ")}`;
}

/**
 * Compact human-readable digest of failed groups for the row's final
 * `last_error` field after a terminal outcome. Mirrors the schema
 * change from #87 phase 1 (single string), keeps the legacy column
 * useful without making operators parse the JSON every time.
 */
function summariseFailures(state: DeliveryState): string {
  const failed = Object.entries(state).filter(([, g]) => g.status === "failed");
  if (failed.length === 0) return "";
  return `Failed ${failed.length} group(s): ${failed
    .map(([mx, g]) => `${mx} (${g.recipients.length} rcpt): ${g.lastError ?? "?"}`)
    .join(" | ")}`;
}

/**
 * Returns true when the row had at least one group already in `sent`
 * state before this attempt: used to skip duplicate `email.sent`
 * webhook dispatches across retry passes.
 */
function anySentBefore(priorStatuses: Map<string, DeliveryGroup["status"]>): boolean {
  for (const s of priorStatuses.values()) if (s === "sent") return true;
  return false;
}
