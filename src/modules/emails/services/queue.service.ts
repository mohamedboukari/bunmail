import { eq, asc, and, isNull } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { emails } from "../models/email.schema.ts";
import { domains } from "../../domains/models/domain.schema.ts";
import { sendMail } from "./mailer.service.ts";
import type { DkimOptions, UnsubscribeOptions } from "./mailer.service.ts";
import { dispatchEvent } from "../../webhooks/services/webhook-dispatch.service.ts";
import { logger } from "../../../utils/logger.ts";
import { redactEmail } from "../../../utils/redact.ts";

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
  return row;
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
  return row;
}

/** How often the queue checks for new emails to send (in ms) */
const POLL_INTERVAL_MS = 2000;

/** Max emails to process in a single poll cycle */
const BATCH_SIZE = 5;

/** Max send attempts before marking an email as permanently failed */
const MAX_ATTEMPTS = 3;

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
 * Single poll cycle — fetches queued emails and processes them.
 *
 * Steps:
 * 1. SELECT up to BATCH_SIZE emails with status "queued" (oldest first)
 * 2. For each email (concurrently):
 *    a. Mark as "sending" and increment attempts
 *    b. Try SMTP delivery via mailer service
 *    c. On success: mark "sent" with timestamp
 *    d. On failure: if attempts >= MAX_ATTEMPTS mark "failed", else back to "queued"
 */
async function processQueue(): Promise<void> {
  /** Fetch the next batch of queued emails, oldest first */
  const batch = await db
    .select()
    .from(emails)
    .where(and(eq(emails.status, "queued"), isNull(emails.deletedAt)))
    .orderBy(asc(emails.createdAt))
    .limit(BATCH_SIZE);

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
  const attempt = email.attempts + 1;

  logger.info("Processing email", {
    emailId,
    attempt,
    to: redactEmail(email.toAddress),
  });

  /** Step 1: Mark as "sending" and increment the attempt counter */
  await db
    .update(emails)
    .set({
      status: "sending",
      attempts: attempt,
      updatedAt: new Date(),
    })
    .where(eq(emails.id, emailId));

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

    /** Step 3b: Failure — decide whether to retry or permanently fail */
    if (attempt >= MAX_ATTEMPTS) {
      /** All retries exhausted — mark as permanently failed */
      await db
        .update(emails)
        .set({
          status: "failed",
          lastError: errorMessage,
          updatedAt: new Date(),
        })
        .where(eq(emails.id, emailId));

      logger.error("Email permanently failed after max attempts", {
        emailId,
        attempt,
        error: errorMessage,
      });

      dispatchEvent("email.failed", {
        emailId,
        from: email.fromAddress,
        to: email.toAddress,
        subject: email.subject,
        error: errorMessage,
      });
    } else {
      /** Transient failure — put back in queue for retry on next cycle */
      await db
        .update(emails)
        .set({
          status: "queued",
          lastError: errorMessage,
          updatedAt: new Date(),
        })
        .where(eq(emails.id, emailId));

      logger.warn("Email send failed, will retry", {
        emailId,
        attempt,
        remainingAttempts: MAX_ATTEMPTS - attempt,
        error: errorMessage,
      });
    }
  }
}
