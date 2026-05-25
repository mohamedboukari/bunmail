import { randomBytes } from "crypto";
import { eq, asc, and, isNull, inArray, sql } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { emails } from "../models/email.schema.ts";
import type { DeliveryState, DeliveryGroup } from "../models/email.schema.ts";
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
     * loops join on — minting a new one per attempt would break
     * correlation entirely. (#97)
     */
    const messageId =
      email.messageId ?? `<${randomBytes(16).toString("hex")}@${config.mail.hostname}>`;

    const existingState = email.deliveryState as DeliveryState | null;
    /** Capture pre-attempt status per group so we can detect
     *  transitions (retry → failed via hard 5xx) for bounce webhooks. */
    const priorStatuses = new Map<string, DeliveryGroup["status"]>();
    if (existingState) {
      for (const [mx, g] of Object.entries(existingState)) {
        priorStatuses.set(mx, g.status);
      }
    }

    const result = await sendMail({
      from: email.fromAddress,
      to: email.toAddress,
      cc: email.cc,
      bcc: email.bcc,
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
        dispatchEvent("email.bounced", {
          emailId,
          to: email.toAddress,
          recipient: rcpt,
          bounceType: "hard",
          status: parsed.code,
          diagnostic: group.lastError ?? "(no diagnostic)",
          suppressionId: suppression.id,
          source: "inline",
        });
        logger.warn("Multi-MX recipient hard-bounced — auto-suppressed", {
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
     * - any group still `retry` AND attempts < cap → schedule next pass
     * - else (all terminal, or cap exhausted) → terminal row status:
     *   - any group `sent` → row `sent`
     *   - else any failed-due-to-hard-5xx → row `bounced`
     *   - else → row `failed`
     */
    const groups = Object.entries(result.deliveryState);
    const anyRetry = groups.some(([, g]) => g.status === "retry");
    const anySent = groups.some(([, g]) => g.status === "sent");

    if (anyRetry && attempt < MAX_ATTEMPTS) {
      /** At least one group transient-failed; row goes back to
       *  `queued` so the claim loop picks it up again. Persist the
       *  state so the next pass can skip already-sent groups. */
      await db
        .update(emails)
        .set({
          status: "queued",
          messageId,
          deliveryState: result.deliveryState,
          lastError: summariseRetries(result.deliveryState),
          updatedAt: new Date(),
        })
        .where(eq(emails.id, emailId));
      logger.warn("Email send had retry groups, requeued", {
        emailId,
        attempt,
        remainingAttempts: MAX_ATTEMPTS - attempt,
      });
      /** If this attempt landed at least one group, fire `email.sent`
       *  once — checked against priorStatuses so we don't double-fire
       *  on a future attempt where the same group is already sent. */
      if (anySent && !anySentBefore(priorStatuses)) {
        dispatchEvent("email.sent", {
          emailId,
          from: email.fromAddress,
          to: email.toAddress,
          subject: email.subject,
          messageId,
        });
      }
      return;
    }

    /** Cap-exhaust or all-terminal path. Flip any straggling retry
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

    await db
      .update(emails)
      .set({
        status: finalStatus,
        messageId,
        deliveryState: finalState,
        sentAt: finalAnySent ? new Date() : null,
        lastError:
          finalStatus === "sent" && finalGroups.every((g) => g.status === "sent")
            ? null
            : summariseFailures(finalState),
        updatedAt: new Date(),
      })
      .where(eq(emails.id, emailId));

    logger.info("Email reached terminal state", {
      emailId,
      messageId,
      attempt,
      finalStatus,
      sentGroups: finalGroups.filter((g) => g.status === "sent").length,
      failedGroups: finalGroups.filter((g) => g.status === "failed").length,
    });

    if (finalAnySent && !anySentBefore(priorStatuses)) {
      dispatchEvent("email.sent", {
        emailId,
        from: email.fromAddress,
        to: email.toAddress,
        subject: email.subject,
        messageId,
      });
    }

    if (!finalAnySent && finalStatus === "failed") {
      /** Pure failure (no group ever delivered + no hard 5xx) — keep
       *  the `email.failed` webhook fired by the legacy path so
       *  consumers that watch this event still see it. */
      dispatchEvent("email.failed", {
        emailId,
        from: email.fromAddress,
        to: email.toAddress,
        subject: email.subject,
        error: summariseFailures(finalState),
      });
    }
  } catch (error) {
    /**
     * `sendMail` only throws for fundamental input errors now (no
     * valid recipients after parsing) — never for transport / SMTP
     * failures, which return as `failed`/`retry` groups in state.
     * So this catch is a one-shot terminal: mark `failed`, no retry.
     */
    const errorMessage = error instanceof Error ? error.message : String(error);
    await db
      .update(emails)
      .set({
        status: "failed",
        lastError: errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(emails.id, emailId));
    logger.error("Email permanently failed (input error)", {
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
 * state before this attempt — used to skip duplicate `email.sent`
 * webhook dispatches across retry passes.
 */
function anySentBefore(priorStatuses: Map<string, DeliveryGroup["status"]>): boolean {
  for (const s of priorStatuses.values()) if (s === "sent") return true;
  return false;
}
