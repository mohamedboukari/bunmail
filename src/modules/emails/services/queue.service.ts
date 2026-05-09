import { eq, asc, and, isNull, inArray, sql } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { emails } from "../models/email.schema.ts";
import { domains } from "../../domains/models/domain.schema.ts";
import { sendMail } from "./mailer.service.ts";
import type { DkimOptions, UnsubscribeOptions } from "./mailer.service.ts";
import { dispatchEvent } from "../../webhooks/services/webhook-dispatch.service.ts";
import { addFromBounce } from "../../suppressions/services/suppression.service.ts";
import { logger } from "../../../utils/logger.ts";
import { redactEmail } from "../../../utils/redact.ts";
import { decryptSecret, isEncryptedSecret } from "../../../utils/crypto.ts";
import { parseSmtpError } from "../../../utils/smtp-error.ts";
import { config } from "../../../config.ts";

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
 *   1. **By `domainId` (canonical)** — the FK stamped on the email row
 *      at create-time. Survives sender renames and is the right answer
 *      even if a future schema allows non-unique names per API key.
 *   2. **By sender domain name (legacy fallback)** — only used when
 *      `domainId` is null, which only happens for rows created before
 *      the FK existed (schema 0001). New rows always carry `domainId`
 *      when the domain is registered.
 *
 * Exported for unit testing — see test/unit/resolve-domain-for-email.test.ts.
 */
export async function resolveDomainForEmail(
  email: { domainId: string | null; fromAddress: string },
  queries: {
    byId: (id: string) => Promise<DomainLookupRow | undefined>;
    byName: (name: string) => Promise<DomainLookupRow | undefined>;
  },
): Promise<DomainLookupRow | undefined> {
  /** Primary path — FK is the canonical pointer. */
  if (email.domainId !== null) {
    return queries.byId(email.domainId);
  }

  /** Legacy fallback — pre-FK rows. Skip if `fromAddress` is malformed. */
  const senderDomain = email.fromAddress.split("@")[1];
  if (!senderDomain) return undefined;
  return queries.byName(senderDomain);
}

/**
 * Decrypts a stored DKIM private key for use with nodemailer's signer.
 *
 * Three input shapes are tolerated:
 *   - `null` — no key on file; returned unchanged so the caller falls
 *     back to unsigned mail.
 *   - encrypted (`v1:...`) — the normal post-migration path; AES-256-GCM
 *     decrypted with `config.dkimEncryptionKey`.
 *   - plaintext PEM — possible during the upgrade window before the
 *     boot-time encrypter runs, or if an operator inserted a row by
 *     hand. Logged as a warning so it shows up in incident review,
 *     then returned as-is so the email still signs.
 *
 * On decrypt failure (wrong key, tampered ciphertext) we log and return
 * `null` — the mail is sent unsigned rather than failed outright. This
 * is **fail-open** by design: a key-rotation accident shouldn't take
 * down outbound delivery.
 */
function decryptDkimPrivateKey(stored: string | null, domainName: string): string | null {
  if (stored === null) return null;

  if (!isEncryptedSecret(stored)) {
    logger.warn("DKIM private key stored as plaintext — boot encrypter has not run", {
      domain: domainName,
    });
    return stored;
  }

  try {
    return decryptSecret(stored, config.dkimEncryptionKey);
  } catch (err) {
    logger.error("Failed to decrypt DKIM private key — sending unsigned", {
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

/** Max send attempts before marking an email as permanently failed */
const MAX_ATTEMPTS = 3;

/* ─── Send-failure handling (#68) ─── */

/**
 * Side-effect callbacks the failure handler relies on. Injected so tests
 * can run the classification logic without a DB / webhook dispatcher.
 * Same pattern as `bounce-handler.service.ts` from #24.
 */
export interface SendFailureDeps {
  /** `sending → bounced` transition. Set when an inline 5xx tells us the recipient is permanently unreachable. */
  markEmailBounced: (emailId: string, lastError: string) => Promise<void>;
  /** `sending → failed` transition. Used after `MAX_ATTEMPTS` retries on transient/non-SMTP errors. */
  markEmailFailed: (emailId: string, lastError: string) => Promise<void>;
  /** `sending → queued` transition for retry on the next poll cycle. */
  markEmailRequeued: (emailId: string, lastError: string) => Promise<void>;
  /** Persist the suppression for an inline-5xx hard rejection. */
  addFromBounce: (
    apiKeyId: string,
    input: {
      email: string;
      bounceType: "hard";
      diagnosticCode: string;
      sourceEmailId: string;
      expiresAt: null;
    },
  ) => Promise<{ id: string }>;
  /** Fire-and-forget webhook dispatch. Must accept the same event vocabulary the production dispatcher uses. */
  dispatchEvent: (
    event: "email.bounced" | "email.failed",
    data: Record<string, unknown>,
  ) => void;
}

export interface SendFailureContext {
  email: {
    id: string;
    apiKeyId: string;
    fromAddress: string;
    toAddress: string;
    subject: string;
  };
  /** 1-based attempt number that just failed. */
  attempt: number;
  errorMessage: string;
}

export interface HandleSendFailureResult {
  outcome: "auto-suppressed" | "permanently-failed" | "requeued";
  /** Set when we auto-suppressed this recipient on an inline 5xx. */
  suppressionId?: string;
}

/**
 * Decides what to do when a send attempt fails. Three outcomes:
 *
 *   1. **Inline 5xx → auto-suppress** (#68). Modern receivers reject
 *      obviously-bad recipients during the SMTP transaction with a
 *      `550 5.1.1` rather than accepting and later returning a DSN.
 *      Three retries to the same address would just be three more
 *      `550` hits on the receiver's MX — exactly what tanks IP
 *      reputation. So when we recognise a 5xx, we suppress immediately,
 *      mark the email `bounced`, fire `email.bounced`, and stop. The
 *      payload shape matches the async-DSN path from #24 so receivers
 *      get a uniform signal.
 *
 *   2. **Soft 4xx or non-SMTP error, attempt < MAX_ATTEMPTS → requeue.**
 *      Existing transient-failure behaviour. Soft inline 4xx rejections
 *      (greylisting, temporary unavailability) and infrastructure
 *      errors (DNS resolution, socket timeout, TLS handshake) all use
 *      this path.
 *
 *   3. **Soft 4xx or non-SMTP error, attempt >= MAX_ATTEMPTS → fail.**
 *      Existing retry-exhausted behaviour. Marks `failed` and fires
 *      `email.failed`. (Repeated 4xx escalation to a permanent
 *      suppression is left to the async-DSN path's escalation rule
 *      from #24, which has more signal to work with than this single
 *      catch block does.)
 *
 * Exported for unit testing via injected `deps` — see
 * `test/unit/handle-send-failure.test.ts`.
 */
export async function handleSendFailure(
  ctx: SendFailureContext,
  deps: SendFailureDeps,
): Promise<HandleSendFailureResult> {
  const parsed = parseSmtpError(ctx.errorMessage);

  if (parsed?.kind === "hard") {
    /**
     * Inline 5xx: stop retrying, suppress the recipient, mark bounced.
     * Reuses `addFromBounce` so the suppression row is indistinguishable
     * from one created by the DSN path — same `bounceType: "hard"`,
     * same diagnostic code shape, same `email.bounced` webhook payload.
     */
    const suppression = await deps.addFromBounce(ctx.email.apiKeyId, {
      email: ctx.email.toAddress,
      bounceType: "hard",
      diagnosticCode: parsed.code,
      sourceEmailId: ctx.email.id,
      expiresAt: null,
    });

    await deps.markEmailBounced(ctx.email.id, ctx.errorMessage);

    deps.dispatchEvent("email.bounced", {
      emailId: ctx.email.id,
      to: ctx.email.toAddress,
      bounceType: "hard",
      status: parsed.code,
      diagnostic: ctx.errorMessage,
      suppressionId: suppression.id,
      /** Distinguish the inline path from the async-DSN path in webhook
       *  consumers that care to slice their analytics that way. */
      source: "inline",
    });

    logger.warn("Inline SMTP 5xx — auto-suppressed and stopped retrying", {
      emailId: ctx.email.id,
      apiKeyId: ctx.email.apiKeyId,
      to: redactEmail(ctx.email.toAddress),
      status: parsed.code,
      attempt: ctx.attempt,
      suppressionId: suppression.id,
    });

    return { outcome: "auto-suppressed", suppressionId: suppression.id };
  }

  if (ctx.attempt >= MAX_ATTEMPTS) {
    await deps.markEmailFailed(ctx.email.id, ctx.errorMessage);

    deps.dispatchEvent("email.failed", {
      emailId: ctx.email.id,
      from: ctx.email.fromAddress,
      to: ctx.email.toAddress,
      subject: ctx.email.subject,
      error: ctx.errorMessage,
    });

    logger.error("Email permanently failed after max attempts", {
      emailId: ctx.email.id,
      attempt: ctx.attempt,
      error: ctx.errorMessage,
    });

    return { outcome: "permanently-failed" };
  }

  await deps.markEmailRequeued(ctx.email.id, ctx.errorMessage);

  logger.warn("Email send failed, will retry", {
    emailId: ctx.email.id,
    attempt: ctx.attempt,
    remainingAttempts: MAX_ATTEMPTS - ctx.attempt,
    error: ctx.errorMessage,
  });

  return { outcome: "requeued" };
}

/** Reference to the setInterval timer — used to stop the queue */
let pollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the queue processor.
 *
 * First recovers any emails stuck in "sending" state (from a previous
 * crash), then begins polling every 2 seconds for queued emails.
 */
export async function start(): Promise<void> {
  logger.info("Starting email queue processor", {
    pollIntervalMs: POLL_INTERVAL_MS,
    batchSize: BATCH_SIZE,
    maxAttempts: MAX_ATTEMPTS,
  });

  /** Recover emails that were mid-send when the server last shut down */
  await recoverInterrupted();

  /** Begin the poll loop */
  pollTimer = setInterval(() => {
    processQueue().catch((error) => {
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
 * Recovers emails stuck in "sending" status.
 *
 * This happens when the server crashes or restarts while emails are
 * being sent. We reset them back to "queued" so the queue picks them
 * up again on the next cycle.
 */
async function recoverInterrupted(): Promise<void> {
  const result = await db
    .update(emails)
    .set({ status: "queued", updatedAt: new Date() })
    .where(and(eq(emails.status, "sending"), isNull(emails.deletedAt)))
    .returning({ id: emails.id });

  if (result.length > 0) {
    logger.warn("Recovered interrupted emails", {
      count: result.length,
      ids: result.map((r) => r.id),
    });
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
 *   1. **Atomicity** — by the time the row appears in `RETURNING *`, it
 *      is already in `sending` state. There is no window where a row
 *      is "selected but not yet marked", which is the window the old
 *      code raced through (#20).
 *   2. **Concurrency-safety** — `SKIP LOCKED` makes a concurrent caller
 *      *skip past* any row another transaction has locked rather than
 *      blocking on it or grabbing the same id. So two workers running
 *      this query at the same time get **disjoint** result sets, never
 *      overlapping ones. Each returned row was claimed by exactly one
 *      caller.
 *
 * Exported so the integration test can hit it directly without going
 * through the poll loop.
 */
export async function claimNextEmails(
  n: number,
): Promise<Array<typeof emails.$inferSelect>> {
  /** Inner subquery that picks the next `n` queued ids and locks them. */
  const pickIds = db
    .select({ id: emails.id })
    .from(emails)
    .where(and(eq(emails.status, "queued"), isNull(emails.deletedAt)))
    .orderBy(asc(emails.createdAt))
    .limit(n)
    .for("update", { skipLocked: true });

  /** Outer UPDATE flips state + bumps attempts in the same statement. */
  const claimed = await db
    .update(emails)
    .set({
      status: "sending",
      attempts: sql`${emails.attempts} + 1`,
      updatedAt: new Date(),
    })
    .where(inArray(emails.id, pickIds))
    .returning();

  return claimed;
}

/**
 * Single poll cycle — claims a batch of queued emails and processes them.
 *
 * Steps:
 * 1. Atomically claim up to BATCH_SIZE rows (queued → sending in one
 *    statement, with `FOR UPDATE SKIP LOCKED` so concurrent workers
 *    can't claim the same row — see {@link claimNextEmails}).
 * 2. For each claimed row (concurrently):
 *    a. Try SMTP delivery via the mailer service.
 *    b. On success: mark "sent" with timestamp.
 *    c. On failure: hand off to `handleSendFailure` which classifies
 *       inline 5xx (auto-suppress, #68) vs transient (retry up to
 *       MAX_ATTEMPTS, then "failed").
 */
async function processQueue(): Promise<void> {
  const batch = await claimNextEmails(BATCH_SIZE);

  /** Nothing to process — skip silently */
  if (batch.length === 0) return;

  logger.debug("Processing email batch", { count: batch.length });

  /** Process all emails in the batch concurrently */
  await Promise.allSettled(batch.map((email) => processEmail(email)));
}

/**
 * Processes a single email — marks it as sending, attempts SMTP delivery,
 * and updates the status based on the outcome.
 *
 * @param email - The queued email row to process
 */
async function processEmail(email: typeof emails.$inferSelect): Promise<void> {
  const emailId = email.id;
  /**
   * The row arrives already in `sending` state with `attempts` incremented
   * — `claimNextEmails` did both atomically (#20). So `email.attempts` is
   * the count for *this* attempt, not the previous one.
   */
  const attempt = email.attempts;

  logger.info("Processing email", {
    emailId,
    attempt,
    to: redactEmail(email.toAddress),
  });

  try {
    /**
     * Look up DKIM keys + unsubscribe overrides for the sender's domain.
     * Both fall back gracefully — DKIM stays unsigned if the domain row
     * is missing, and `List-Unsubscribe` defaults to
     * `unsubscribe@<sender-domain>` inside the mailer when overrides are
     * absent.
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

    /**
     * Pass overrides only when at least one is set. Otherwise leave
     * `unsubscribe` undefined and let the mailer apply its default
     * (`unsubscribe@<sender-domain>` mailto, no URL).
     */
    if (domain?.unsubscribeEmail || domain?.unsubscribeUrl) {
      unsubscribe = {
        mailto: domain.unsubscribeEmail ?? undefined,
        url: domain.unsubscribeUrl ?? undefined,
      };
    }

    /** Step 2: Attempt SMTP delivery */
    const result = await sendMail({
      from: email.fromAddress,
      to: email.toAddress,
      cc: email.cc,
      bcc: email.bcc,
      subject: email.subject,
      html: email.html,
      text: email.textContent,
      dkim,
      unsubscribe,
    });

    /** Step 3a: Success — mark as "sent" and record the SMTP Message-ID */
    await db
      .update(emails)
      .set({
        status: "sent",
        messageId: result.messageId,
        sentAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(emails.id, emailId));

    logger.info("Email sent successfully", {
      emailId,
      messageId: result.messageId,
      attempt,
    });

    dispatchEvent("email.sent", {
      emailId,
      from: email.fromAddress,
      to: email.toAddress,
      subject: email.subject,
      messageId: result.messageId,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    /**
     * Step 3b: Failure — classify and dispatch.
     *
     * Inline 5xx (#68) → auto-suppress + stop retrying. Soft 4xx /
     * infrastructure errors → retry until MAX_ATTEMPTS, then mark
     * `failed`. See `handleSendFailure` above for the full decision
     * tree.
     */
    await handleSendFailure(
      {
        email: {
          id: emailId,
          apiKeyId: email.apiKeyId,
          fromAddress: email.fromAddress,
          toAddress: email.toAddress,
          subject: email.subject,
        },
        attempt,
        errorMessage,
      },
      {
        markEmailBounced: async (id, lastError) => {
          await db
            .update(emails)
            .set({ status: "bounced", lastError, updatedAt: new Date() })
            .where(eq(emails.id, id));
        },
        markEmailFailed: async (id, lastError) => {
          await db
            .update(emails)
            .set({ status: "failed", lastError, updatedAt: new Date() })
            .where(eq(emails.id, id));
        },
        markEmailRequeued: async (id, lastError) => {
          await db
            .update(emails)
            .set({ status: "queued", lastError, updatedAt: new Date() })
            .where(eq(emails.id, id));
        },
        addFromBounce: async (apiKeyId, input) => {
          const row = await addFromBounce(apiKeyId, input);
          return { id: row.id };
        },
        dispatchEvent,
      },
    );
  }
}
